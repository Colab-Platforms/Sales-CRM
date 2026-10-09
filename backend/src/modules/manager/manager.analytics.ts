import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import {
  ActivityType,
  CallStatus,
  LeadWorkingStatus,
  Role,
  UserStatus,
  WorkStatus,
} from "../../../generated/prisma/enums.js";
import { PRODUCTIVE_TARGET_MS, REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { computeSummary, mergeSummaries } from "../attendance/attendance.calc.js";

// ---------------------------------------------------------------------------------------------
// Definitions (kept in one place so the dashboard and the per-salesperson report always agree):
//
//  Calls          Call rows (never derived from lead status changes), grouped by the call's start
//                 timestamp (createdAt when it never started) in the manager's timezone.
//  Connected      status CONNECTED / COMPLETED / AGENT_ANSWERED  (the customer was reached)
//  Failed         status FAILED
//  Not connected  everything else (NO_ANSWER, BUSY, NOT_REACHABLE, still ringing, ...)
//  Talk time      sum of durationSeconds of connected calls
//  Unique leads   distinct leadIds called in the period - deliberately NOT the same as calls made
//  Lead metrics   a cohort: leads currently owned by the salesperson whose assignment date falls in
//                 the selected range. Contacted = has a call (or has moved past NEW/ASSIGNED),
//                 Interested = INTERESTED/CONVERTED or has an interested period, Converted = CONVERTED.
//  Productivity   WorkSession/StatusLog via the attendance module's computeSummary (productiveMs).
// ---------------------------------------------------------------------------------------------

export const TEAM_CONVERSION_TARGET_PERCENT = 6;
const CONNECTED_STATUSES = new Set<CallStatus>([CallStatus.CONNECTED, CallStatus.COMPLETED, CallStatus.AGENT_ANSWERED]);
const MAX_RANGE_DAYS = 92;
const DAY_MS = 24 * 60 * 60_000;

export type CallStatusFilter = "ALL" | "CONNECTED" | "NOT_CONNECTED" | "FAILED";
export type LeadStatusFilter = "ALL" | "NOT_CONTACTED" | "CONTACTED" | "INTERESTED" | "CONVERTED";

export interface AnalyticsFilters {
  from: string; // YYYY-MM-DD, inclusive, in the manager's timezone
  to: string; // YYYY-MM-DD, inclusive
  salespersonId?: string;
  callStatus: CallStatusFilter;
  leadStatus: LeadStatusFilter;
  tzOffsetMinutes: number;
}

interface CallCounts {
  calls: number;
  connected: number;
  notConnected: number;
  failed: number;
  uniqueLeads: number;
  talkTimeSec: number;
}

const emptyCounts = (): CallCounts => ({ calls: 0, connected: 0, notConnected: 0, failed: 0, uniqueLeads: 0, talkTimeSec: 0 });

function classify(status: CallStatus): "connected" | "failed" | "notConnected" {
  if (CONNECTED_STATUSES.has(status)) return "connected";
  if (status === CallStatus.FAILED) return "failed";
  return "notConnected";
}

function dayKey(date: Date, tz: number): string {
  return new Date(date.getTime() + tz * 60_000).toISOString().slice(0, 10);
}

function rangeBounds(f: AnalyticsFilters) {
  const start = new Date(Date.parse(`${f.from}T00:00:00.000Z`) - f.tzOffsetMinutes * 60_000);
  const end = new Date(Date.parse(`${f.to}T00:00:00.000Z`) - f.tzOffsetMinutes * 60_000 + DAY_MS);
  return { start, end };
}

function listDays(f: AnalyticsFilters): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${f.from}T00:00:00.000Z`); t <= Date.parse(`${f.to}T00:00:00.000Z`); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

interface LeadRow {
  id: string;
  ownerId: string | null;
  workingStatus: LeadWorkingStatus;
  hasCall: boolean;
  hasInterestedPeriod: boolean;
  assignedAt: Date;
}

function leadStages(lead: LeadRow) {
  const converted = lead.workingStatus === LeadWorkingStatus.CONVERTED;
  const interested = converted || lead.workingStatus === LeadWorkingStatus.INTERESTED || lead.hasInterestedPeriod;
  const contacted =
    interested ||
    lead.hasCall ||
    (lead.workingStatus !== LeadWorkingStatus.NEW && lead.workingStatus !== LeadWorkingStatus.ASSIGNED);
  return { contacted, interested, converted };
}

function matchesLeadStatus(lead: LeadRow, filter: LeadStatusFilter): boolean {
  if (filter === "ALL") return true;
  const s = leadStages(lead);
  if (filter === "NOT_CONTACTED") return !s.contacted;
  if (filter === "CONTACTED") return s.contacted;
  if (filter === "INTERESTED") return s.interested;
  return s.converted;
}

class ManagerAnalyticsService {
  private async getTeam(managerId: string) {
    return prisma.user.findMany({
      where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE, reportingManagerId: managerId },
      select: { id: true, name: true, username: true, phone: true, email: true, status: true },
      orderBy: { name: "asc" },
    });
  }

  private async leadCohort(ownerIds: string[], start: Date, end: Date): Promise<LeadRow[]> {
    if (ownerIds.length === 0) return [];
    const leads = await prisma.lead.findMany({
      where: {
        ownerId: { in: ownerIds },
        workingStatus: { not: LeadWorkingStatus.DEACTIVATED },
        OR: [
          { assignments: { some: { isCurrent: true, assignedAt: { gte: start, lt: end } } } },
          { assignments: { none: {} }, createdAt: { gte: start, lt: end } },
        ],
      },
      select: {
        id: true,
        ownerId: true,
        workingStatus: true,
        createdAt: true,
        lastContactedAt: true,
        assignments: { where: { isCurrent: true }, select: { assignedAt: true }, take: 1 },
        calls: { select: { id: true }, take: 1 },
        interestedPeriods: { select: { id: true }, take: 1 },
      },
    });
    return leads.map((l) => ({
      id: l.id,
      ownerId: l.ownerId,
      workingStatus: l.workingStatus,
      hasCall: l.calls.length > 0 || l.lastContactedAt !== null,
      hasInterestedPeriod: l.interestedPeriods.length > 0,
      assignedAt: l.assignments[0]?.assignedAt ?? l.createdAt,
    }));
  }

  private async productivityByDay(userIds: string[], start: Date, end: Date, tz: number) {
    const result = new Map<string, Map<string, number>>(); // userId -> day -> productiveMs
    if (userIds.length === 0) return result;
    const sessions = await prisma.workSession.findMany({
      where: { userId: { in: userIds }, startedAt: { gte: start, lt: end } },
      include: { statusLogs: { orderBy: { startedAt: "asc" } } },
    });
    const now = new Date();
    const summaries = new Map<string, ReturnType<typeof computeSummary>[]>(); // `${userId}|${day}`
    for (const s of sessions) {
      const summary = computeSummary(
        s.statusLogs.map((l) => ({ status: l.status, startedAt: l.startedAt, endedAt: l.endedAt })),
        s.startedAt,
        s.endedAt ?? now,
      );
      const key = `${s.userId}|${dayKey(s.startedAt, tz)}`;
      summaries.set(key, [...(summaries.get(key) ?? []), summary]);
    }
    for (const [key, list] of summaries) {
      const [userId, day] = key.split("|");
      const byDay = result.get(userId) ?? new Map<string, number>();
      byDay.set(day, mergeSummaries(list).productiveMs);
      result.set(userId, byDay);
    }
    return result;
  }

  private async currentStatuses(userIds: string[]) {
    const open = await prisma.workSession.findMany({
      where: { userId: { in: userIds }, endedAt: null },
      select: { userId: true, currentStatus: true },
    });
    return new Map(open.map((s) => [s.userId, s.currentStatus]));
  }

  async overview(managerId: string, f: AnalyticsFilters) {
    return this.compute(managerId, f, false);
  }

  async salesperson(managerId: string, f: AnalyticsFilters) {
    if (!f.salespersonId) throw new ApiError("salespersonId is required", STATUS_CODES.BAD_REQUEST);
    const data = await this.compute(managerId, f, true);
    const person = data.salespeople[0];
    if (!person) throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    const recentActivity = await this.recentActivity(person.id);
    return { ...data, salesperson: person, recentActivity };
  }

  private async compute(managerId: string, f: AnalyticsFilters, single: boolean) {
    const allTeam = await this.getTeam(managerId);
    if (f.salespersonId && !allTeam.some((p) => p.id === f.salespersonId)) {
      throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    }
    const team = f.salespersonId ? allTeam.filter((p) => p.id === f.salespersonId) : allTeam;
    const ids = team.map((p) => p.id);
    const tz = f.tzOffsetMinutes;
    const { start, end } = rangeBounds(f);
    const days = listDays(f);
    if (days.length === 0 || days.length > MAX_RANGE_DAYS) {
      throw new ApiError(`Date range must be between 1 and ${MAX_RANGE_DAYS} days`, STATUS_CODES.BAD_REQUEST);
    }
    const prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()));

    const [calls, cohort, prevCohort, productivity, statuses, interestedEvents, convertedEvents] = await Promise.all([
      prisma.call.findMany({
        where: {
          agentId: { in: ids },
          OR: [
            { startedAt: { gte: start, lt: end } },
            { startedAt: null, createdAt: { gte: start, lt: end } },
          ],
        },
        select: { agentId: true, leadId: true, status: true, startedAt: true, createdAt: true, durationSeconds: true },
      }),
      this.leadCohort(ids, start, end),
      this.leadCohort(ids, prevStart, start),
      this.productivityByDay(ids, start, end, tz),
      this.currentStatuses(ids),
      prisma.interestedLeadPeriod.findMany({
        where: { qualifiedById: { in: ids }, startedAt: { gte: start, lt: end } },
        select: { qualifiedById: true, startedAt: true },
      }),
      prisma.activity.findMany({
        where: {
          actorId: { in: ids },
          type: ActivityType.STATUS_CHANGE,
          title: "Status changed to CONVERTED",
          createdAt: { gte: start, lt: end },
        },
        select: { actorId: true, createdAt: true },
      }),
    ]);

    // --- lead cohort metrics (call-status filter does not apply; lead-status filter does)
    const leads = cohort.filter((l) => matchesLeadStatus(l, f.leadStatus));
    const leadStats = new Map<string, { leads: number; contacted: number; interested: number; converted: number }>();
    for (const id of ids) leadStats.set(id, { leads: 0, contacted: 0, interested: 0, converted: 0 });
    for (const lead of leads) {
      const s = leadStages(lead);
      const row = leadStats.get(lead.ownerId ?? "");
      if (!row) continue;
      row.leads += 1;
      if (s.contacted) row.contacted += 1;
      if (s.interested) row.interested += 1;
      if (s.converted) row.converted += 1;
    }

    // --- calls, filtered by the call-status filter, bucketed per salesperson and per day
    const perPerson = new Map<string, CallCounts & { leadSet: Set<string> }>();
    const perDay = new Map<string, Map<string, CallCounts & { leadSet: Set<string> }>>();
    const blank = () => ({ ...emptyCounts(), leadSet: new Set<string>() });
    const matchesCall = (kind: ReturnType<typeof classify>) =>
      f.callStatus === "ALL" ||
      (f.callStatus === "CONNECTED" && kind === "connected") ||
      (f.callStatus === "NOT_CONNECTED" && kind === "notConnected") ||
      (f.callStatus === "FAILED" && kind === "failed");

    for (const c of calls) {
      const kind = classify(c.status);
      if (!matchesCall(kind)) continue;
      const day = dayKey(c.startedAt ?? c.createdAt, tz);
      const person = perPerson.get(c.agentId) ?? blank();
      const dayMap = perDay.get(day) ?? new Map();
      const cell = dayMap.get(c.agentId) ?? blank();
      for (const t of [person, cell]) {
        t.calls += 1;
        t[kind] += 1;
        t.leadSet.add(c.leadId);
        if (kind === "connected") t.talkTimeSec += c.durationSeconds ?? 0;
      }
      perPerson.set(c.agentId, person);
      dayMap.set(c.agentId, cell);
      perDay.set(day, dayMap);
    }

    const interestedByDay = new Map<string, number>();
    for (const e of interestedEvents) {
      const k = `${e.qualifiedById}|${dayKey(e.startedAt, tz)}`;
      interestedByDay.set(k, (interestedByDay.get(k) ?? 0) + 1);
    }
    const convertedByDay = new Map<string, number>();
    for (const e of convertedEvents) {
      const k = `${e.actorId}|${dayKey(e.createdAt, tz)}`;
      convertedByDay.set(k, (convertedByDay.get(k) ?? 0) + 1);
    }

    const finalize = (c: (CallCounts & { leadSet: Set<string> }) | undefined): CallCounts => {
      if (!c) return emptyCounts();
      const { leadSet, ...rest } = c;
      return { ...rest, uniqueLeads: leadSet.size };
    };

    // --- per salesperson
    const salespeople = team.map((p) => {
      const stats = leadStats.get(p.id)!;
      const c = finalize(perPerson.get(p.id));
      const productiveMs = [...(productivity.get(p.id)?.values() ?? [])].reduce((a, b) => a + b, 0);
      return {
        id: p.id,
        name: p.name,
        username: p.username,
        email: p.email,
        accountStatus: p.status,
        workStatus: statuses.get(p.id) ?? WorkStatus.OFFLINE,
        ...stats,
        ...c,
        productiveMs,
      };
    });

    // --- per day (team total + per salesperson)
    const daily = days.map((date) => {
      const dayMap = perDay.get(date) ?? new Map();
      const total = { ...emptyCounts(), leadSet: new Set<string>() };
      const bySalesperson: Record<string, CallCounts & { productiveMs: number; interested: number; converted: number }> = {};
      let productiveMs = 0;
      for (const p of team) {
        const cell = dayMap.get(p.id);
        const pMs = productivity.get(p.id)?.get(date) ?? 0;
        productiveMs += pMs;
        bySalesperson[p.id] = {
          ...finalize(cell),
          productiveMs: pMs,
          interested: interestedByDay.get(`${p.id}|${date}`) ?? 0,
          converted: convertedByDay.get(`${p.id}|${date}`) ?? 0,
        };
        if (cell) {
          total.calls += cell.calls;
          total.connected += cell.connected;
          total.notConnected += cell.notConnected;
          total.failed += cell.failed;
          total.talkTimeSec += cell.talkTimeSec;
          cell.leadSet.forEach((id: string) => total.leadSet.add(id));
        }
      }
      return {
        date,
        ...finalize(total),
        productiveMs,
        interested: Object.values(bySalesperson).reduce((a, b) => a + b.interested, 0),
        converted: Object.values(bySalesperson).reduce((a, b) => a + b.converted, 0),
        bySalesperson,
      };
    });

    // --- team KPIs
    const sum = (pick: (s: (typeof salespeople)[number]) => number) => salespeople.reduce((a, s) => a + pick(s), 0);
    const allLeadIds = new Set<string>();
    for (const c of calls) if (matchesCall(classify(c.status))) allLeadIds.add(c.leadId);
    const totalLeads = sum((s) => s.leads);
    const contacted = sum((s) => s.contacted);
    const kpis = {
      totalLeads,
      previousTotalLeads: prevCohort.filter((l) => matchesLeadStatus(l, f.leadStatus)).length,
      notContacted: totalLeads - contacted,
      contacted,
      interested: sum((s) => s.interested),
      converted: sum((s) => s.converted),
      callsMade: sum((s) => s.calls),
      connectedCalls: sum((s) => s.connected),
      notConnectedCalls: sum((s) => s.notConnected),
      failedCalls: sum((s) => s.failed),
      uniqueLeadsContacted: allLeadIds.size,
      talkTimeSec: sum((s) => s.talkTimeSec),
      productiveMs: sum((s) => s.productiveMs),
    };

    return {
      range: { from: f.from, to: f.to, days: days.length, tzOffsetMinutes: tz },
      filters: { callStatus: f.callStatus, leadStatus: f.leadStatus, salespersonId: f.salespersonId ?? null },
      targets: { conversionRatePercent: TEAM_CONVERSION_TARGET_PERCENT, productiveMsPerDay: PRODUCTIVE_TARGET_MS },
      team: allTeam.map((p) => ({ id: p.id, name: p.name, username: p.username })),
      kpis,
      salespeople,
      daily,
      single,
    };
  }

  // Latest things this salesperson did: calls, lead activity and shift starts, newest first.
  private async recentActivity(userId: string) {
    const [calls, activities, sessions] = await Promise.all([
      prisma.call.findMany({
        where: { agentId: userId },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          id: true,
          status: true,
          durationSeconds: true,
          startedAt: true,
          createdAt: true,
          lead: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      prisma.activity.findMany({
        where: {
          actorId: userId,
          type: { in: [ActivityType.STATUS_CHANGE, ActivityType.ASSIGNMENT, ActivityType.INTERESTED, ActivityType.ORDER_CREATED] },
        },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: { id: true, type: true, title: true, createdAt: true },
      }),
      prisma.workSession.findMany({
        where: { userId },
        orderBy: { startedAt: "desc" },
        take: 5,
        select: { id: true, startedAt: true },
      }),
    ]);

    const items = [
      ...calls.map((c) => ({
        id: `call-${c.id}`,
        at: (c.startedAt ?? c.createdAt).toISOString(),
        kind: "CALL" as const,
        title: `Called ${[c.lead.firstName, c.lead.lastName].filter(Boolean).join(" ")}`,
        detail: classify(c.status) === "connected" ? "Connected" : classify(c.status) === "failed" ? "Failed" : "Not connected",
        durationSec: classify(c.status) === "connected" ? (c.durationSeconds ?? 0) : null,
        leadId: c.lead.id,
      })),
      ...activities.map((a) => ({
        id: `act-${a.id}`,
        at: a.createdAt.toISOString(),
        kind: "ACTIVITY" as const,
        title: a.title ?? a.type.replace(/_/g, " ").toLowerCase(),
        detail: null,
        durationSec: null,
        leadId: null,
      })),
      ...sessions.map((s) => ({
        id: `sess-${s.id}`,
        at: s.startedAt.toISOString(),
        kind: "SESSION" as const,
        title: "Productivity session started",
        detail: null,
        durationSec: null,
        leadId: null,
      })),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
  }
}

export const defaultTzOffset = REPORT_TZ_OFFSET_MINUTES;
export const managerAnalyticsService = new ManagerAnalyticsService();
