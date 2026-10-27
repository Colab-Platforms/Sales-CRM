import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { dayBounds, todayString } from "../attendance/attendance.calc.js";
import { soldOrders } from "../manager/manager.sales.js";
import { DAY_END, DAY_START, buildSlots, coveredMinutes, dayGate, hhmm, rate, slotGate, slotOf, teamPace, zoneClock, zoneInstant, type Gate, type Pace, type Rag, type Rated } from "./matrix.calc.js";

// ---------------------------------------------------------------------------------------------
// Performance Matrix: calls and actual orders per salesperson, per hour and for the day, with Red/Amber/Green
// worked out automatically against the team's own pace (see matrix.calc.ts). Nothing is configured or stored.
// Sources (read-only):
//   Calls   Call rows (CallerDesk) with a lead - recruitment calls are not sales calls - one per call id, timed by
//           startedAt (createdAt when the call never started). Any outcome counts as a call attempt, the same
//           definition as the sales reports.
//   Orders  The sales reports' sold orders (manager.sales.ts): one per order id, status CONFIRMED..DELIVERED (never
//           draft, pending payment / payment link only, cancelled, returned or refunded), credited to the telecaller
//           who confirmed it in the CRM, or - for a customer-placed Shopify order - to the telecaller who worked that
//           customer in the 7 days before. Timed by the sale (confirmedAt, else placedAt). Converted leads and
//           payments are never used.
//   Shifts  WorkSession clock-ins, to decide which hours are rated and to scale the team average.
// Scope: a manager sees their active direct reports; an admin every active salesperson (optionally one team).
// The team average always uses the whole team in scope, so filtering to one salesperson does not change colours.
// ---------------------------------------------------------------------------------------------

const TZ = REPORT_TZ_OFFSET_MINUTES;

export interface MatrixQuery {
  date: string;
  salespersonId?: string;
  /** Admin only: one manager's team. */
  managerId?: string;
}

class PerformanceMatrixService {
  private async team(user: AuthUser, managerId?: string) {
    if (user.role !== Role.MANAGER && user.role !== Role.ADMIN) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    const teamOf = user.role === Role.MANAGER ? user.id : managerId;
    return prisma.user.findMany({
      where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE, ...(teamOf ? { reportingManagerId: teamOf } : {}) },
      select: { id: true, name: true, username: true, reportingManagerId: true },
      orderBy: { name: "asc" },
    });
  }

  async report(user: AuthUser, q: MatrixQuery) {
    const now = new Date();
    const today = todayString(now, TZ);
    if (q.date > today) throw new ApiError("The date cannot be in the future", STATUS_CODES.BAD_REQUEST);
    const team = await this.team(user, q.managerId);
    if (q.salespersonId && !team.some((p) => p.id === q.salespersonId)) throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    const ids = team.map((p) => p.id);
    const { from: start, to: end } = dayBounds(q.date, TZ);
    const inDay = { OR: [{ startedAt: { gte: start, lt: end } }, { startedAt: null, createdAt: { gte: start, lt: end } }] };

    const [calls, teamCallCount, orders, sessions, managers] = await Promise.all([
      prisma.call.findMany({
        where: { agentId: { in: ids }, leadId: { not: null }, ...inDay },
        select: { id: true, providerCallId: true, agentId: true, startedAt: true, createdAt: true },
      }),
      // Whether the call feed has anything for the whole team that day; none at all = treat as missing data.
      prisma.call.count({ where: { agentId: { in: ids }, ...inDay } }),
      soldOrders(ids, start, end, { paymentMode: "ALL", orderStatus: "ALL", callStatus: "ALL", leadStatus: "ALL" }),
      prisma.workSession.findMany({
        where: { userId: { in: ids }, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
        select: { userId: true, startedAt: true, endedAt: true },
      }),
      user.role === Role.ADMIN
        ? prisma.user.findMany({ where: { role: Role.MANAGER, status: UserStatus.ACTIVE }, select: { id: true, name: true }, orderBy: { name: "asc" } })
        : Promise.resolve([]),
    ]);

    // One count per call id, and per provider call id when a webhook wrote the same call twice.
    const seen = new Set<string>();
    const uniqueCalls = calls.filter((c) => {
      const keys = [c.id, c.providerCallId ? `p:${c.providerCallId}` : null].filter((k): k is string => k !== null);
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    });
    const seenOrders = new Set<string>();
    const uniqueOrders = orders.filter((o) => (seenOrders.has(o.id) ? false : (seenOrders.add(o.id), true)));

    const teamHasCalls = teamCallCount > 0;
    const isToday = q.date === today;
    const intervalsOf = (id: string) => sessions.filter((x) => x.userId === id).map((x) => ({ start: x.startedAt, end: x.endedAt ?? now }));

    // Hourly columns: the 09:30-18:30 day, widened by whole hours to every call / order of the team, so early and late
    // work is shown and rated. Idle logged-in time outside 09:30-18:30 (e.g. a forgotten logout) is not.
    const marks = [...uniqueCalls.map((c) => zoneClock(c.startedAt ?? c.createdAt, TZ).minutes), ...uniqueOrders.map((o) => zoneClock(o.at, TZ).minutes)];
    const earliest = Math.min(DAY_START, ...marks);
    const latest = Math.max(DAY_END, ...marks);
    const slots = buildSlots(Math.max(0, DAY_START - Math.ceil((DAY_START - earliest) / 60) * 60), Math.min(24 * 60, DAY_END + Math.ceil((latest - DAY_END) / 60) * 60));

    // Pass 1: counts, logged-in minutes and whether each hour / day is rated, for the whole team.
    const base = team.map((p) => {
      const counts = new Map(slots.map((x) => [x.key, { calls: 0, orders: 0 }]));
      const outside = { calls: 0, orders: 0 };
      const place = (at: Date, what: "calls" | "orders") => {
        const slot = slotOf(zoneClock(at, TZ).minutes, slots);
        (slot ? counts.get(slot.key)! : outside)[what] += 1;
      };
      for (const c of uniqueCalls) if (c.agentId === p.id) place(c.startedAt ?? c.createdAt, "calls");
      for (const o of uniqueOrders) if (o.userId === p.id) place(o.at, "orders");

      const intervals = intervalsOf(p.id);
      const hours = slots.map((slot) => {
        const c = counts.get(slot.key)!;
        const inWorkingDay = slot.startMinutes >= DAY_START && slot.endMinutes <= DAY_END;
        const loggedIn = coveredMinutes(q.date, slot.startMinutes, slot.endMinutes, intervals, TZ);
        const covered = inWorkingDay || c.calls + c.orders > 0 ? loggedIn : 0;
        const gate = slotGate({
          slot,
          calls: c.calls,
          orders: c.orders,
          covered,
          startsAt: zoneInstant(q.date, slot.startMinutes, TZ),
          endsAt: zoneInstant(q.date, slot.endMinutes, TZ),
          now,
          teamHasCalls,
        });
        return { key: slot.key, calls: c.calls, orders: c.orders, clockedInMinutes: covered, gate };
      });
      const totals = {
        calls: hours.reduce((a, h) => a + h.calls, 0) + outside.calls,
        orders: hours.reduce((a, h) => a + h.orders, 0) + outside.orders,
      };
      // The day is judged on the time logged in, login to logout (open session = still logged in, up to now): all of it
      // inside 09:30-18:30, and outside that only the hours with calls or orders.
      const covered = hours.reduce((a, h) => a + h.clockedInMinutes, 0);
      const gate = dayGate({ ...totals, covered, dayMinutes: DAY_END - DAY_START, isToday, teamHasCalls });
      const mine = sessions.filter((x) => x.userId === p.id).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const stillLoggedIn = mine.some((x) => x.endedAt === null);
      const login = mine.length ? (mine[0]!.startedAt < start ? start : mine[0]!.startedAt) : null;
      const lastEnd = mine.reduce<Date | null>((m, x) => (x.endedAt && (!m || x.endedAt > m) ? x.endedAt : m), null);
      const logout = stillLoggedIn || !lastEnd ? null : lastEnd > end ? end : lastEnd;
      return { p, hours, outside, totals, covered, gate, login, logout, stillLoggedIn };
    });

    // Pass 2: the team's pace per hour and for the day, then each person against it.
    const ratedOf = (g: Gate, calls: number, orders: number): Rated | null => ("minutes" in g ? { calls, orders, minutes: g.minutes } : null);
    const hourPace = new Map(slots.map((s, i) => [s.key, teamPace(base.map((b) => ratedOf(b.hours[i]!.gate, b.hours[i]!.calls, b.hours[i]!.orders)).filter((r): r is Rated => r !== null))]));
    const dayPace = teamPace(base.map((b) => ratedOf(b.gate, b.totals.calls, b.totals.orders)).filter((r): r is Rated => r !== null));
    const judge = (g: Gate, calls: number, orders: number, pace: Pace) => ("off" in g ? g.off : rate({ calls, orders, minutes: g.minutes }, pace));

    const rows = base
      .filter((b) => !q.salespersonId || b.p.id === q.salespersonId)
      .map((b) => {
        const daily = judge(b.gate, b.totals.calls, b.totals.orders, dayPace);
        return {
          id: b.p.id,
          name: b.p.name,
          employeeId: b.p.username,
          managerId: b.p.reportingManagerId,
          hours: b.hours.map(({ gate, ...h }) => {
            const r = judge(gate, h.calls, h.orders, hourPace.get(h.key)!);
            return { ...h, state: r.state, reason: r.reason };
          }),
          outside: b.outside,
          totals: b.totals,
          clockedInMinutes: b.covered,
          loginAt: b.login?.toISOString() ?? null,
          logoutAt: b.logout?.toISOString() ?? null,
          stillLoggedIn: b.stillLoggedIn,
          callsPerHour: b.covered >= 1 ? Math.round((b.totals.calls * 600) / b.covered) / 10 : null,
          status: daily.state,
          reason: daily.reason,
        };
      });

    const attention = (st: string) => st === "RED" || st === "AMBER";
    const round1 = (n: number) => Math.round(n * 10) / 10;

    return {
      date: q.date,
      today,
      isToday,
      generatedAt: now.toISOString(),
      tzOffsetMinutes: TZ,
      dataAvailable: teamHasCalls,
      filters: { salespersonId: q.salespersonId ?? null, managerId: q.managerId ?? null },
      team: team.map((p) => ({ id: p.id, name: p.name })),
      managers,
      slots: slots.map((x) => ({ key: x.key, start: hhmm(x.startMinutes), end: hhmm(x.endMinutes), teamCallsPerHour: round1(hourPace.get(x.key)!.calls) })),
      teamCallsPerHour: round1(dayPace.calls),
      summary: {
        totalCalls: rows.reduce((a, r) => a + r.totals.calls, 0),
        totalOrders: rows.reduce((a, r) => a + r.totals.orders, 0),
        salespeople: rows.length,
        needAttention: rows.filter((r) => attention(r.status)).length,
        byStatus: (["GREEN", "AMBER", "RED"] as Rag[]).reduce((o, k) => ({ ...o, [k]: rows.filter((r) => r.status === k).length }), {} as Record<Rag, number>),
      },
      rows,
    };
  }
}

export const performanceMatrixService = new PerformanceMatrixService();
