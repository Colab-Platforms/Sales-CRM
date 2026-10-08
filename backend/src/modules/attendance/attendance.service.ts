import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import { logger } from "@/utils/logger.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role, SessionEndReason, UserStatus, WorkStatus } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import {
  DISCONNECT_GRACE_MS,
  ENDED_CALL_STATUSES,
  MANUAL_STATUSES,
  MAX_ON_CALL_MS,
  REPORT_TZ_OFFSET_MINUTES,
  STALE_SESSION_MS,
  SWEEP_INTERVAL_MS,
} from "./attendance.constants.js";
import { computeSummary, dayBounds, mergeSummaries, todayString } from "./attendance.calc.js";
import { presence } from "./attendance.presence.js";
import type { AttendanceSummary, LogInterval, StatusEvent } from "./attendance.types.js";

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
    await this.transition(session.id, userId, session.currentStatus, status);
    return this.getMine(userId);
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

export const attendanceService = new AttendanceService();
export default AttendanceService;
