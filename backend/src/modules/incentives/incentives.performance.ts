import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { dayBounds } from "../attendance/attendance.calc.js";
import { listDays, zoneDay } from "../attendance/attendance.records.js";
import { attendanceRecords } from "../attendance/attendance.service.js";
import { soldOrders } from "../manager/manager.sales.js";

// ---------------------------------------------------------------------------------------------
// Daily / weekly / custom-range PERFORMANCE TRACKING for the admin Sales Incentives page. This is not the incentive:
// the payable incentive always follows the monthly policy (incentives.calc.ts). Same sources as the monthly plan -
// verified orders (soldOrders), calls with a lead (one per call / provider call id), attendance day records - loaded
// for the whole team at once, then cut per salesperson and day (IST).
// ---------------------------------------------------------------------------------------------

const TZ = REPORT_TZ_OFFSET_MINUTES;

export interface PerfDay {
  date: string;
  present: boolean;
  calls: number;
  orders: number;
  revenue: number;
  netLoginMinutes: number;
  /** Present, with the policy's daily net login and call targets both reached. */
  met: boolean;
}

export interface PerfTotals {
  from: string;
  to: string;
  days: number;
  presentDays: number;
  metDays: number;
  calls: number;
  orders: number;
  revenue: number;
  netLoginMinutes: number;
}

export function totalsOf(days: PerfDay[], from: string, to: string): PerfTotals {
  const inRange = days.filter((d) => d.date >= from && d.date <= to);
  return {
    from,
    to,
    days: inRange.length,
    presentDays: inRange.filter((d) => d.present).length,
    metDays: inRange.filter((d) => d.met).length,
    calls: inRange.reduce((a, d) => a + d.calls, 0),
    orders: inRange.reduce((a, d) => a + d.orders, 0),
    revenue: Math.round(inRange.reduce((a, d) => a + d.revenue, 0) * 100) / 100,
    netLoginMinutes: inRange.reduce((a, d) => a + d.netLoginMinutes, 0),
  };
}

/** Every day in [from, to] for each salesperson: calls, verified orders and revenue, net login, and whether the day's targets were met. */
export async function dailyPerformance(
  admin: AuthUser,
  userIds: string[],
  from: string,
  to: string,
  targets: { minNetLoginMinutes: number; minDailyCalls: number },
): Promise<Map<string, PerfDay[]>> {
  const out = new Map<string, PerfDay[]>();
  if (userIds.length === 0) return out;
  const start = dayBounds(from, TZ).from;
  const end = dayBounds(to, TZ).to;
  const [sold, calls, attendance] = await Promise.all([
    soldOrders(userIds, start, end, { paymentMode: "ALL", orderStatus: "ALL", callStatus: "ALL", leadStatus: "ALL" }),
    prisma.call.findMany({
      where: { agentId: { in: userIds }, leadId: { not: null }, OR: [{ startedAt: { gte: start, lt: end } }, { startedAt: null, createdAt: { gte: start, lt: end } }] },
      select: { id: true, providerCallId: true, agentId: true, startedAt: true, createdAt: true },
    }),
    attendanceRecords(admin, { from, to, status: "ALL", page: 1, pageSize: 10_000 }),
  ]);

  const key = (userId: string, day: string) => `${userId}|${day}`;
  const seenOrders = new Set<string>();
  const orderCount = new Map<string, number>();
  const revenue = new Map<string, number>();
  for (const o of sold) {
    if (seenOrders.has(o.id)) continue;
    seenOrders.add(o.id);
    const k = key(o.userId, zoneDay(o.at, TZ));
    orderCount.set(k, (orderCount.get(k) ?? 0) + 1);
    revenue.set(k, (revenue.get(k) ?? 0) + o.cents / 100);
  }
  const seenCalls = new Set<string>();
  const callCount = new Map<string, number>();
  for (const c of calls) {
    const ids = [c.id, c.providerCallId ? `p:${c.providerCallId}` : null].filter((x): x is string => x !== null);
    if (ids.some((x) => seenCalls.has(x))) continue;
    ids.forEach((x) => seenCalls.add(x));
    const k = key(c.agentId, zoneDay(c.startedAt ?? c.createdAt, TZ));
    callCount.set(k, (callCount.get(k) ?? 0) + 1);
  }
  const records = new Map<string, { present: boolean; netLoginMinutes: number }>();
  for (const e of attendance.employees) {
    for (const r of e.records) {
      const present = r.status === "PRESENT";
      records.set(key(e.id, r.date), { present, netLoginMinutes: present ? Math.max(0, Math.round((r.workingMs - r.breakMs) / 60_000)) : 0 });
    }
  }

  const days = listDays(from, to);
  for (const id of userIds) {
    out.set(
      id,
      days.map((date) => {
        const k = key(id, date);
        const a = records.get(k) ?? { present: false, netLoginMinutes: 0 };
        const dayCalls = callCount.get(k) ?? 0;
        return {
          date,
          present: a.present,
          calls: dayCalls,
          orders: orderCount.get(k) ?? 0,
          revenue: Math.round((revenue.get(k) ?? 0) * 100) / 100,
          netLoginMinutes: a.netLoginMinutes,
          met: a.present && a.netLoginMinutes >= targets.minNetLoginMinutes && dayCalls >= targets.minDailyCalls,
        };
      }),
    );
  }
  return out;
}
