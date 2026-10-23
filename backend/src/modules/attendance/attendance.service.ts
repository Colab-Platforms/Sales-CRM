import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import { logger } from "@/utils/logger.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, SessionEndReason, UserStatus, WorkStatus } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import {
  BREAK_STATUSES,
  DISCONNECT_GRACE_MS,
  ENDED_CALL_STATUSES,
  MANUAL_STATUSES,
  MAX_ON_CALL_MS,
  ATTENDANCE_CUTOFF_MINUTES,
  MAX_ATTENDANCE_RANGE_DAYS,
  REPORT_TZ_OFFSET_MINUTES,
  STALE_SESSION_MS,
  SWEEP_INTERVAL_MS,
} from "./attendance.constants.js";
import { computeSummary, dayBounds, mergeSummaries, todayString } from "./attendance.calc.js";
import { presence } from "./attendance.presence.js";
import { dayRecord, listDays, matchesStatus, totalsOf, zoneDay, type DayCalls, type SessionForDay } from "./attendance.records.js";
import { classify } from "../manager/manager.metrics.js";
import type { AttendanceSummary, LogInterval, RecordsQuery, StatusEvent } from "./attendance.types.js";

const sessionInclude = { statusLogs: { orderBy: { startedAt: "asc" as const } } };

type SessionWithLogs = NonNullable<Awaited<ReturnType<typeof findOpenSession>>>;

function findOpenSession(userId: string) {
  return prisma.workSession.findFirst({
    where: { userId, endedAt: null },
    orderBy: { startedAt: "desc" },
    include: sessionInclude,
  });
}

function toLogs(session: SessionWithLogs): LogInterval[] {
  return session.statusLogs.map((l) => ({ status: l.status, startedAt: l.startedAt, endedAt: l.endedAt }));
}

function summarize(session: SessionWithLogs, now: Date): AttendanceSummary {
  return computeSummary(toLogs(session), session.startedAt, session.endedAt ?? now);
}

function serializeSession(session: SessionWithLogs, now: Date) {
  return {
    id: session.id,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    status: session.endedAt ? WorkStatus.OFFLINE : session.currentStatus,
    statusSince: session.statusSince,
    summary: summarize(session, now),
  };
}

class AttendanceService {
  // Called once at boot: wires presence -> service and starts the keep-alive pings and the sweeper.
  start(): void {
    presence.onGraceExpired = (userId) => {
      void this.handleDisconnected(userId).catch((e) => logger.error("[attendance] grace handler failed", e));
    };
    presence.startPings();
    const timer = setInterval(() => {
      void this.sweep().catch((e) => logger.error("[attendance] sweep failed", e));
    }, SWEEP_INTERVAL_MS);
    timer.unref();
  }

  // ---- shift lifecycle ----------------------------------------------------------------------

  // Two near-simultaneous /start calls (React dev double-mount, two tabs opening together) must not
  // each create a shift, so starts for the same user run one after another.
  private startLocks = new Map<string, Promise<unknown>>();

  startSession(userId: string) {
    const previous = this.startLocks.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.startSessionUnlocked(userId));
    this.startLocks.set(userId, run);
    void run.finally(() => {
      if (this.startLocks.get(userId) === run) this.startLocks.delete(userId);
    });
    return run;
  }

  private async startSessionUnlocked(userId: string) {
    await this.collapseOpenSessions(userId);
    const existing = await findOpenSession(userId);
    if (existing) {
      // A leftover shift from a crash/closed laptop must not carry into a new day's timer.
      if (Date.now() - existing.lastSeenAt.getTime() < STALE_SESSION_MS) return existing;
      await this.closeSession(existing.id, userId, SessionEndReason.STALE, existing.lastSeenAt);
    }

    const now = new Date();
    const session = await prisma.workSession.create({
      data: {
        userId,
        startedAt: now,
        lastSeenAt: now,
        currentStatus: WorkStatus.ACTIVE,
        statusSince: now,
        statusLogs: { create: { userId, status: WorkStatus.ACTIVE, startedAt: now } },
      },
      include: sessionInclude,
    });
    await this.publish(userId, WorkStatus.ACTIVE, now, false);
    return session;
  }

  // A user must only ever have one open shift. If duplicates exist, keep the newest and close the
  // older ones at the moment the newer one began, so no time is counted twice.
  private async collapseOpenSessions(userId: string): Promise<void> {
    const open = await prisma.workSession.findMany({
      where: { userId, endedAt: null },
      orderBy: { startedAt: "desc" },
      select: { id: true, startedAt: true },
    });
    for (let i = 1; i < open.length; i += 1) {
      const endedAt = open[i - 1].startedAt;
      await prisma.$transaction([
        prisma.statusLog.updateMany({ where: { sessionId: open[i].id, endedAt: null }, data: { endedAt } }),
        prisma.workSession.update({
          where: { id: open[i].id },
          data: { endedAt, endReason: SessionEndReason.STALE, currentStatus: WorkStatus.OFFLINE, statusSince: endedAt },
        }),
      ]);
    }
  }

  async endSession(userId: string, reason: SessionEndReason = SessionEndReason.LOGOUT): Promise<void> {
    const session = await findOpenSession(userId);
    if (!session) return;
    await this.closeSession(session.id, userId, reason, new Date());
  }

  private async closeSession(sessionId: string, userId: string, reason: SessionEndReason, endedAt: Date) {
    await prisma.$transaction([
      prisma.statusLog.updateMany({ where: { sessionId, endedAt: null }, data: { endedAt } }),
      prisma.workSession.update({
        where: { id: sessionId },
        data: { endedAt, endReason: reason, currentStatus: WorkStatus.OFFLINE, statusSince: endedAt },
      }),
    ]);
    await this.publish(userId, WorkStatus.OFFLINE, endedAt, true);
  }

  // ---- status changes -----------------------------------------------------------------------

  // A salesperson picking Active / a break / Team Huddle from the header dropdown.
  async setManualStatus(userId: string, status: WorkStatus) {
    if (!MANUAL_STATUSES.has(status)) {
      throw new ApiError("That status is set automatically", STATUS_CODES.BAD_REQUEST);
    }
    const session = await findOpenSession(userId);
    if (!session) throw new ApiError("Clock in to start your shift first", STATUS_CODES.CONFLICT);

    // Going from a break straight to another break doesn't add to the number of people away.
    const startsBreak = BREAK_STATUSES.has(status) && !BREAK_STATUSES.has(session.currentStatus);
    if (!startsBreak) {
      await this.transition(session.id, userId, session.currentStatus, status);
      return this.getMine(userId);
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { reportingManagerId: true } });
    const managerId = user?.reportingManagerId;
    if (!managerId) {
      await this.transition(session.id, userId, session.currentStatus, status);
      return this.getMine(userId);
    }

    // The check and the transition run under one per-manager lock, so two people tapping "break" at
    // the same moment can't both slip under the cap.
    await this.withBreakLock(managerId, async () => {
      const limit = await this.getBreakLimit(managerId);
      if (limit !== null) {
        const onBreak = await prisma.workSession.count({
          where: {
            endedAt: null,
            userId: { not: userId },
            currentStatus: { in: [...BREAK_STATUSES] },
            user: { reportingManagerId: managerId },
          },
        });
        if (onBreak >= limit) {
          throw new ApiError(
            `Break not available - ${onBreak} of ${limit} allowed teammates are already on a break. Try again shortly.`,
            STATUS_CODES.CONFLICT,
          );
        }
      }
      await this.transition(session.id, userId, session.currentStatus, status);
    });
    return this.getMine(userId);
  }

  // ---- break cap ----------------------------------------------------------------------------

  private breakLocks = new Map<string, Promise<unknown>>();

  private withBreakLock<T>(managerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.breakLocks.get(managerId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    this.breakLocks.set(managerId, run);
    void run
      .catch(() => {})
      .finally(() => {
        if (this.breakLocks.get(managerId) === run) this.breakLocks.delete(managerId);
      });
    return run;
  }

  // null = no cap.
  async getBreakLimit(managerId: string): Promise<number | null> {
    const row = await prisma.breakLimitConfig.findUnique({ where: { managerId } });
    return row?.maxConcurrentBreaks ?? null;
  }

  // The manager's own cap (managers) or, for admins, the cap of the manager they name.
  async getBreakLimitFor(user: AuthUser, managerId?: string) {
    const target = this.resolveManagerId(user, managerId);
    return { managerId: target, maxConcurrentBreaks: await this.getBreakLimit(target) };
  }

  // maxConcurrentBreaks null removes the cap.
  async setBreakLimit(user: AuthUser, maxConcurrentBreaks: number | null, managerId?: string) {
    const target = this.resolveManagerId(user, managerId);
    if (maxConcurrentBreaks === null) {
      await prisma.breakLimitConfig.deleteMany({ where: { managerId: target } });
    } else {
      await prisma.breakLimitConfig.upsert({
        where: { managerId: target },
        create: { managerId: target, maxConcurrentBreaks },
        update: { maxConcurrentBreaks },
      });
    }
    return { managerId: target, maxConcurrentBreaks };
  }

  private resolveManagerId(user: AuthUser, managerId?: string): string {
    if (user.role === Role.MANAGER) return user.id;
    if (!managerId) throw new ApiError("managerId is required", STATUS_CODES.BAD_REQUEST);
    return managerId;
  }

  // Set by the system (ON_CALL from click-to-call, IDLE from lost connection) - a no-op without a shift.
  async setSystemStatus(userId: string, status: WorkStatus): Promise<void> {
    const session = await findOpenSession(userId);
    if (!session) return;
    await this.transition(session.id, userId, session.currentStatus, status);
  }

  // Back to ACTIVE after a call ends - but never override a break/huddle the salesperson chose meanwhile.
  async restoreFromCall(userId: string): Promise<void> {
    const session = await findOpenSession(userId);
    if (session?.currentStatus !== WorkStatus.ON_CALL) return;
    await this.transition(session.id, userId, session.currentStatus, WorkStatus.ACTIVE);
  }

  private async transition(sessionId: string, userId: string, from: WorkStatus, to: WorkStatus): Promise<void> {
    if (from === to) return;
    const now = new Date();
    await prisma.$transaction([
      prisma.statusLog.updateMany({ where: { sessionId, endedAt: null }, data: { endedAt: now } }),
      prisma.statusLog.create({ data: { sessionId, userId, status: to, startedAt: now } }),
      prisma.workSession.update({ where: { id: sessionId }, data: { currentStatus: to, statusSince: now } }),
    ]);
    await this.publish(userId, to, now, false);
  }

  // ---- presence -----------------------------------------------------------------------------

  // Browser (re)connected its stream: stamp the heartbeat and recover from a presence-caused IDLE.
  async markConnected(userId: string): Promise<void> {
    const session = await findOpenSession(userId);
    if (!session) return;
    await prisma.workSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    if (session.currentStatus === WorkStatus.IDLE) {
      await this.transition(session.id, userId, WorkStatus.IDLE, WorkStatus.ACTIVE);
    }
  }

  // Browser heartbeat: proves the person is there even when the stream looks open.
  async heartbeat(userId: string): Promise<void> {
    presence.touch(userId);
    await this.markConnected(userId);
  }

  private async handleDisconnected(userId: string): Promise<void> {
    const session = await findOpenSession(userId);
    if (!session) return;
    await prisma.workSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    await this.markIdleIfWorking(session.id, userId, session.currentStatus);
  }

  // Someone on a break/huddle who closes the laptop is still on that break - only "working" statuses
  // turn into IDLE when the browser goes away.
  private async markIdleIfWorking(sessionId: string, userId: string, status: WorkStatus): Promise<void> {
    if (status === WorkStatus.ACTIVE || status === WorkStatus.ON_CALL) {
      await this.transition(sessionId, userId, status, WorkStatus.IDLE);
    }
  }

  // Safety net for what the stream events can't see (server crash, a missed close): runs every minute.
  private async sweep(): Promise<void> {
    const now = new Date();
    const connected = presence.aliveUserIds();

    if (connected.length > 0) {
      await prisma.workSession.updateMany({
        where: { userId: { in: connected }, endedAt: null },
        data: { lastSeenAt: now },
      });
    }

    const open = await prisma.workSession.findMany({ where: { endedAt: null }, orderBy: { startedAt: "desc" } });
    const seen = new Set<string>();
    for (const session of open) {
      if (seen.has(session.userId)) {
        await this.collapseOpenSessions(session.userId);
        continue;
      }
      seen.add(session.userId);
      const { userId } = session;
      // The call webhook normally clears ON_CALL, but the call rows are shared state: if whichever
      // server received the webhook didn't clear it (or it never came), clear it once the agent has
      // no unfinished call left.
      if (session.currentStatus === WorkStatus.ON_CALL && !(await this.hasCallInFlight(userId, now))) {
        await this.transition(session.id, userId, WorkStatus.ON_CALL, WorkStatus.ACTIVE);
        continue;
      }
      if (presence.isAlive(userId)) {
        if (session.currentStatus === WorkStatus.ON_CALL && now.getTime() - session.statusSince.getTime() > MAX_ON_CALL_MS) {
          await this.transition(session.id, userId, WorkStatus.ON_CALL, WorkStatus.ACTIVE);
        }
        continue;
      }
      // After a restart every browser is reconnecting: give them the full grace period before judging.
      if (presence.inBootGrace()) continue;

      const silentMs = now.getTime() - session.lastSeenAt.getTime();
      if (silentMs > STALE_SESSION_MS) {
        await this.closeSession(session.id, userId, SessionEndReason.STALE, session.lastSeenAt);
      } else if (silentMs > DISCONNECT_GRACE_MS) {
        await this.markIdleIfWorking(session.id, userId, session.currentStatus);
      }
    }
  }

  private async hasCallInFlight(userId: string, now: Date): Promise<boolean> {
    const count = await prisma.call.count({
      where: {
        agentId: userId,
        startedAt: { gte: new Date(now.getTime() - MAX_ON_CALL_MS) },
        status: { notIn: [...ENDED_CALL_STATUSES] },
      },
    });
    return count > 0;
  }

  private async publish(userId: string, status: WorkStatus, since: Date, sessionEnded: boolean): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, reportingManagerId: true },
    });
    if (!user) return;
    const event: StatusEvent = {
      type: "status",
      userId,
      name: user.name,
      managerId: user.reportingManagerId,
      status,
      statusSince: since.toISOString(),
      sessionEnded,
    };
    presence.sendToUser(userId, event);
    presence.broadcastToTeam(event);
  }

  // ---- reads --------------------------------------------------------------------------------

  // The salesperson's own clock. The 9h shift, 1h break allowance and 8h target are per DAY, so the
  // figures add up every shift they worked today: logging out and back in continues the same clock
  // instead of starting a fresh 9 hours. Time spent logged out is not counted.
  async getMine(userId: string) {
    const now = new Date();
    const { from, to } = dayBounds(todayString(now, REPORT_TZ_OFFSET_MINUTES), REPORT_TZ_OFFSET_MINUTES);
    const sessions = await prisma.workSession.findMany({
      where: { userId, OR: [{ endedAt: null }, { startedAt: { gte: from, lt: to } }] },
      orderBy: { startedAt: "asc" },
      include: sessionInclude,
    });
    if (sessions.length === 0) return { session: null, serverTime: now };

    const current = sessions.filter((s) => !s.endedAt).at(-1) ?? sessions[sessions.length - 1];
    return {
      session: {
        ...serializeSession(current, now),
        startedAt: sessions[0].startedAt,
        summary: mergeSummaries(sessions.map((s) => summarize(s, now))),
      },
      serverTime: now,
    };
  }

  private async scopedSalespersons(user: AuthUser, onlyUserId?: string) {
    if (user.role === Role.SALESPERSON) {
      if (onlyUserId && onlyUserId !== user.id) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
      return prisma.user.findMany({
        where: { id: user.id },
        select: { id: true, name: true, username: true, reportingManagerId: true },
      });
    }
    return prisma.user.findMany({
      where: {
        role: Role.SALESPERSON,
        status: UserStatus.ACTIVE,
        ...(user.role === Role.MANAGER ? { reportingManagerId: user.id } : {}),
        ...(onlyUserId ? { id: onlyUserId } : {}),
      },
      select: { id: true, name: true, username: true, reportingManagerId: true },
      orderBy: { name: "asc" },
    });
  }

  // Live board: one row per salesperson in scope, with today's totals and their current status.
  async getTeam(user: AuthUser) {
    const now = new Date();
    const { from, to } = dayBounds(todayString(now, REPORT_TZ_OFFSET_MINUTES), REPORT_TZ_OFFSET_MINUTES);
    const people = await this.scopedSalespersons(user);
    const sessions = await prisma.workSession.findMany({
      where: {
        userId: { in: people.map((p) => p.id) },
        OR: [{ endedAt: null }, { startedAt: { gte: from, lt: to } }],
      },
      orderBy: { startedAt: "asc" },
      include: sessionInclude,
    });

    return {
      serverTime: now,
      members: people.map((person) => {
        const mine = sessions.filter((s) => s.userId === person.id);
        const open = mine.filter((s) => !s.endedAt).at(-1) ?? null;
        return {
          userId: person.id,
          name: person.name,
          username: person.username,
          managerId: person.reportingManagerId,
          status: open ? open.currentStatus : WorkStatus.OFFLINE,
          statusSince: open ? open.statusSince : (mine.at(-1)?.endedAt ?? null),
          shiftStartedAt: open?.startedAt ?? null,
          summary: mine.length ? mergeSummaries(mine.map((s) => summarize(s, now))) : null,
        };
      }),
    };
  }

  async getReport(user: AuthUser, date: string | undefined, userId: string | undefined) {
    const now = new Date();
    const day = date ?? todayString(now, REPORT_TZ_OFFSET_MINUTES);
    const { from, to } = dayBounds(day, REPORT_TZ_OFFSET_MINUTES);
    const people = await this.scopedSalespersons(user, userId);
    if (userId && people.length === 0) throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);

    const sessions = await prisma.workSession.findMany({
      where: { userId: { in: people.map((p) => p.id) }, startedAt: { gte: from, lt: to } },
      orderBy: { startedAt: "asc" },
      include: sessionInclude,
    });

    return {
      date: day,
      rows: people.map((person) => {
        const mine = sessions.filter((s) => s.userId === person.id);
        return {
          userId: person.id,
          name: person.name,
          username: person.username,
          firstLoginAt: mine[0]?.startedAt ?? null,
          lastLogoutAt: mine.length && mine.every((s) => s.endedAt) ? (mine.at(-1)?.endedAt ?? null) : null,
          sessions: mine.map((s) => serializeSession(s, now)),
          summary: mine.length ? mergeSummaries(mine.map((s) => summarize(s, now))) : null,
        };
      }),
    };
  }
}

// Attendance records over a date range (see attendance.records.ts for the status rules). Scope: a manager sees
// their active direct reports, an admin every active salesperson, a salesperson only themselves. Sessions are read from the database for
// exactly these people and days; statuses are derived, never stored or altered.
export async function attendanceRecords(user: AuthUser, q: RecordsQuery) {
  const tz = REPORT_TZ_OFFSET_MINUTES;
  const now = new Date();
  const today = todayString(now, tz);
  if (q.from > q.to) throw new ApiError("From date must not be after To date", STATUS_CODES.BAD_REQUEST);
  if (q.to > today) throw new ApiError("The range cannot end in the future", STATUS_CODES.BAD_REQUEST);
  const days = listDays(q.from, q.to);
  if (days.length > MAX_ATTENDANCE_RANGE_DAYS) {
    throw new ApiError(`Choose a range of at most ${MAX_ATTENDANCE_RANGE_DAYS} days`, STATUS_CODES.BAD_REQUEST);
  }

  // A salesperson only ever sees their own records, whatever userId they ask for.
  if (user.role === Role.SALESPERSON && q.userId && q.userId !== user.id) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  const people = await prisma.user.findMany({
    where: {
      role: Role.SALESPERSON,
      ...(user.role === Role.SALESPERSON ? { id: user.id } : { status: UserStatus.ACTIVE }),
      ...(user.role === Role.MANAGER ? { reportingManagerId: user.id } : {}),
      ...(q.userId ? { id: q.userId } : {}),
    },
    select: { id: true, name: true, username: true, createdAt: true },
    orderBy: { name: "asc" },
  });
  if (q.userId && people.length === 0) throw new ApiError("Employee not found", STATUS_CODES.NOT_FOUND);

  // Attendance tracking began with the first session ever recorded; days before it are not absences.
  const firstEver = await prisma.workSession.findFirst({ orderBy: { startedAt: "asc" }, select: { startedAt: true } });
  const trackingStartedOn = firstEver ? zoneDay(firstEver.startedAt, tz) : null;

  const start = dayBounds(q.from, tz).from;
  const end = dayBounds(q.to, tz).to;
  const sessions = await prisma.workSession.findMany({
    where: { userId: { in: people.map((p) => p.id) }, startedAt: { gte: start, lt: end } },
    select: { userId: true, startedAt: true, endedAt: true, endReason: true, lastSeenAt: true, ...sessionInclude },
    orderBy: { startedAt: "asc" },
  });
  const byPersonDay = new Map<string, SessionForDay[]>();
  for (const s of sessions) {
    const key = `${s.userId}|${zoneDay(s.startedAt, tz)}`;
    const list = byPersonDay.get(key) ?? [];
    list.push({
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      endReason: s.endReason,
      lastSeenAt: s.lastSeenAt,
      logs: s.statusLogs.map((l) => ({ status: l.status, startedAt: l.startedAt, endedAt: l.endedAt })),
    });
    byPersonDay.set(key, list);
  }

  // Calls per employee per day (by when the call started, report zone); talk time counts connected calls only,
  // matching the sales reports' Talk Time.
  const calls = await prisma.call.findMany({
    where: {
      agentId: { in: people.map((p) => p.id) },
      OR: [{ startedAt: { gte: start, lt: end } }, { startedAt: null, createdAt: { gte: start, lt: end } }],
    },
    select: { agentId: true, status: true, startedAt: true, createdAt: true, durationSeconds: true },
  });
  const callsByPersonDay = new Map<string, DayCalls>();
  for (const c of calls) {
    const key = `${c.agentId}|${zoneDay(c.startedAt ?? c.createdAt, tz)}`;
    const row = callsByPersonDay.get(key) ?? { calls: 0, talkTimeSec: 0 };
    row.calls += 1;
    if (classify(c.status) === "connected") row.talkTimeSec += c.durationSeconds ?? 0;
    callsByPersonDay.set(key, row);
  }

  const everyone = people.map((p) => {
    const joinedOn = zoneDay(p.createdAt, tz);
    const records = days.map((date) =>
      dayRecord({
        date,
        today,
        joinedOn,
        trackingStartedOn,
        sessions: byPersonDay.get(`${p.id}|${date}`) ?? [],
        callStats: callsByPersonDay.get(`${p.id}|${date}`),
        now,
        tzOffsetMinutes: tz,
      }),
    );
    const matching = records.filter((r) => matchesStatus(r.status, q.status));
    return { id: p.id, name: p.name, employeeId: p.username, joinedOn, records, matching };
  });
  // A status filter keeps the employee-days with that status (and the employees who have at least one).
  const employees = q.status === "ALL" ? everyone : everyone.filter((e) => e.matching.length > 0);
  const counted = employees.flatMap((e) => e.matching);

  const daily = days.map((date) => {
    const onDay = employees.map((e) => e.records.find((r) => r.date === date)!).filter((r) => matchesStatus(r.status, q.status));
    const t = totalsOf(onDay);
    return { date, present: t.present, absent: t.absent, expected: t.expected, attendancePct: t.attendancePct };
  });

  const pageSize = q.pageSize;
  const pages = Math.max(1, Math.ceil(employees.length / pageSize));
  const page = Math.min(q.page, pages);
  const slice = employees.slice((page - 1) * pageSize, page * pageSize);

  return {
    range: { from: q.from, to: q.to, days, today, tzOffsetMinutes: tz },
    filters: { userId: q.userId ?? null, status: q.status },
    policy: {
      trackingStartedOn,
      // Before this time (IST) today has no status yet; after it, no clock-in = Absent.
      cutoff: `${String(Math.floor(ATTENDANCE_CUTOFF_MINUTES / 60)).padStart(2, "0")}:${String(ATTENDANCE_CUTOFF_MINUTES % 60).padStart(2, "0")}`,
      weeklyOff: null,
      halfDay: false,
      leaveAndHolidays: false,
    },
    summary: { totalEmployees: employees.length, ...totalsOf(counted) },
    daily,
    employees: slice.map((e) => ({
      id: e.id,
      name: e.name,
      employeeId: e.employeeId,
      joinedOn: e.joinedOn,
      totals: totalsOf(e.matching),
      records: e.records,
    })),
    pagination: { page, pageSize, pages, total: employees.length },
    // Everyone in scope (for the employee filter), independent of the status filter and paging.
    team: people.map((p) => ({ id: p.id, name: p.name, employeeId: p.username })),
  };
}

export const attendanceService = new AttendanceService();
export default AttendanceService;
