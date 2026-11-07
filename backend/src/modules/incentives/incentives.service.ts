import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { OrderStatus, Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { dayBounds, todayString } from "../attendance/attendance.calc.js";
import { zoneDay } from "../attendance/attendance.records.js";
import { attendanceRecords } from "../attendance/attendance.service.js";
import { soldOrders } from "../manager/manager.sales.js";
import { DEFAULT_POLICY, evaluateMonth, monthDays, policyError, type DayInput, type IncentivePolicyRules, type MonthResult, type MonthStatus, type PercentBasis, type Slab } from "./incentives.calc.js";

// ---------------------------------------------------------------------------------------------
// Sales revenue incentives. Every figure is computed live from the CRM's own records, read-only:
//   Revenue / orders  the sales reports' verified orders (manager.sales.ts soldOrders): status CONFIRMED..DELIVERED,
//                     credited to the salesperson (confirmed by them, or a customer's Shopify order after their call),
//                     one per order id, value net of refunds. Never converted leads, payment links or payment attempts.
//                     Returned orders the salesperson confirmed are added for the delivery condition only.
//   Prepaid           an order's payment method (orders module derivePaymentMode).
//   Delivery          order status DELIVERED / RETURNED / SHIPPED / OUT_FOR_DELIVERY.
//   Attendance, login the attendance module's day records: present = clocked in; net login = time logged in minus breaks.
//   Calls             Call rows for a lead, one per call id / provider call id, by IST day.
// Days are IST. What is stored (incentives.prisma) is only the policy, the admin's approval / payment, queries and the
// audit log. An approved month is locked: it shows the figures frozen at approval.
// ---------------------------------------------------------------------------------------------

const TZ = REPORT_TZ_OFFSET_MINUTES;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface MonthRecord {
  status: "APPROVED" | "PAID";
  amount: number;
  approvedAt: string;
  approvedBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  paymentRef: string | null;
  paymentNote: string | null;
}

async function names(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function toRules(row: Awaited<ReturnType<typeof prisma.incentivePolicy.findFirst>>): IncentivePolicyRules {
  if (!row) return structuredClone(DEFAULT_POLICY);
  return {
    slabs: (Array.isArray(row.slabs) ? (row.slabs as unknown as Slab[]) : DEFAULT_POLICY.slabs).map((s) => ({ minRevenue: Number(s.minRevenue), ...(s.amount !== undefined && s.amount !== null ? { amount: Number(s.amount) } : {}), ...(s.percent !== undefined && s.percent !== null ? { percent: Number(s.percent) } : {}) })),
    percentBasis: row.percentBasis === "TOTAL" || row.percentBasis === "ABOVE_SLAB" ? row.percentBasis : null,
    minPrepaidPercent: row.minPrepaidPercent,
    minDeliveryPercent: row.minDeliveryPercent,
    minAttendanceDays: row.minAttendanceDays,
    minNetLoginMinutes: row.minNetLoginMinutes,
    minLoginDays: row.minLoginDays,
    minDailyCalls: row.minDailyCalls,
    minCallDays: row.minCallDays,
    minAvgDailyOrders: row.minAvgDailyOrdersX100 / 100,
  };
}

class IncentivesService {
  async policy() {
    const row = await prisma.incentivePolicy.findFirst();
    return { rules: toRules(row), configured: row !== null, updatedAt: row?.updatedAt.toISOString() ?? null };
  }

  private async salesperson(userId: string) {
    const u = await prisma.user.findFirst({ where: { id: userId, role: Role.SALESPERSON }, select: { id: true, name: true, username: true, status: true } });
    if (!u) throw new ApiError("Salesperson not found", STATUS_CODES.NOT_FOUND);
    return u;
  }

  private checkMonth(month: string, today: string) {
    if (!MONTH_RE.test(month)) throw new ApiError("month must be YYYY-MM", STATUS_CODES.BAD_REQUEST);
    if (month > today.slice(0, 7)) throw new ApiError("The month cannot be in the future", STATUS_CODES.BAD_REQUEST);
  }

  /** The live calculation for one salesperson and month. */
  async calculate(userId: string, month: string, rules?: IncentivePolicyRules): Promise<MonthResult> {
    const now = new Date();
    const today = todayString(now, TZ);
    this.checkMonth(month, today);
    const policy = rules ?? (await this.policy()).rules;
    const days = monthDays(month);
    const first = days[0]!;
    const last = days.at(-1)!;
    const start = dayBounds(first, TZ).from;
    const end = dayBounds(last, TZ).to;
    const lastSoFar = last < today ? last : today;

    const [sold, returned, calls, attendance] = await Promise.all([
      soldOrders([userId], start, end, { paymentMode: "ALL", orderStatus: "ALL", callStatus: "ALL", leadStatus: "ALL" }),
      prisma.order.findMany({
        where: {
          status: OrderStatus.RETURNED,
          confirmedByUserId: userId,
          OR: [{ confirmedAt: { gte: start, lt: end } }, { confirmedAt: null, placedAt: { gte: start, lt: end } }],
        },
        select: { id: true },
      }),
      prisma.call.findMany({
        where: { agentId: userId, leadId: { not: null }, OR: [{ startedAt: { gte: start, lt: end } }, { startedAt: null, createdAt: { gte: start, lt: end } }] },
        select: { id: true, providerCallId: true, startedAt: true, createdAt: true },
      }),
      attendanceRecords({ id: userId, role: Role.SALESPERSON, username: "" } as AuthUser, { from: first, to: lastSoFar, userId, status: "ALL", page: 1, pageSize: 1 }),
    ]);

    // One count per order and per call (a webhook can write the same call twice under one provider id).
    const seenOrders = new Set<string>();
    const orders = sold.filter((o) => (seenOrders.has(o.id) ? false : (seenOrders.add(o.id), true)));
    const returnedIds = returned.map((r) => r.id).filter((id) => !seenOrders.has(id));
    const seenCalls = new Set<string>();
    const callsByDay = new Map<string, number>();
    for (const c of calls) {
      const keys = [c.id, c.providerCallId ? `p:${c.providerCallId}` : null].filter((k): k is string => k !== null);
      if (keys.some((k) => seenCalls.has(k))) continue;
      keys.forEach((k) => seenCalls.add(k));
      const day = zoneDay(c.startedAt ?? c.createdAt, TZ);
      callsByDay.set(day, (callsByDay.get(day) ?? 0) + 1);
    }
    const ordersByDay = new Map<string, number>();
    for (const o of orders) {
      const day = zoneDay(o.at, TZ);
      ordersByDay.set(day, (ordersByDay.get(day) ?? 0) + 1);
    }

    const records = new Map((attendance.employees[0]?.records ?? []).map((r) => [r.date, r]));
    const dayInputs: DayInput[] = days.map((date) => {
      const r = records.get(date);
      const status: DayInput["attendance"] =
        date > today ? "UPCOMING" : !r ? "ABSENT" : r.status === "PRESENT" ? "PRESENT" : r.status === "PENDING" ? "PENDING" : r.status === "ABSENT" ? "ABSENT" : "NOT_JOINED";
      return {
        date,
        attendance: status,
        netLoginMinutes: r && r.status === "PRESENT" ? Math.max(0, Math.round((r.workingMs - r.breakMs) / 60_000)) : 0,
        calls: callsByDay.get(date) ?? 0,
        orders: ordersByDay.get(date) ?? 0,
      };
    });

    const delivered = orders.filter((o) => o.status === OrderStatus.DELIVERED).length;
    const inTransit = orders.filter((o) => o.status === OrderStatus.SHIPPED || o.status === OrderStatus.OUT_FOR_DELIVERY).length;
    return evaluateMonth({
      month,
      today,
      days: dayInputs,
      revenue: Math.round(orders.reduce((a, o) => a + o.cents, 0)) / 100,
      orders: {
        total: orders.length + returnedIds.length,
        prepaid: orders.filter((o) => o.mode === "PREPAID").length,
        delivered,
        returned: returnedIds.length,
        inTransit,
        notDispatched: orders.length - delivered - inTransit,
      },
      policy,
    });
  }

  private recordOut(row: Prisma.IncentiveMonthGetPayload<object>, who: Map<string, string>): MonthRecord {
    return {
      status: row.status as MonthRecord["status"],
      amount: Number(row.amount),
      approvedAt: row.approvedAt.toISOString(),
      approvedBy: who.get(row.approvedById) ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      paidBy: row.paidById ? (who.get(row.paidById) ?? null) : null,
      paymentRef: row.paymentRef,
      paymentNote: row.paymentNote,
    };
  }

  /** One salesperson's month: the frozen figures once approved, the live calculation before that. */
  async month(userId: string, month: string) {
    const person = await this.salesperson(userId);
    const today = todayString(new Date(), TZ);
    this.checkMonth(month, today);
    const [row, queries, policy] = await Promise.all([
      prisma.incentiveMonth.findUnique({ where: { userId_month: { userId, month } } }),
      prisma.incentiveQuery.findMany({ where: { userId, month }, orderBy: { createdAt: "desc" } }),
      this.policy(),
    ]);
    const who = await names([row?.approvedById, row?.paidById, ...queries.map((q) => q.resolvedById)]);
    let result: MonthResult;
    let status: MonthStatus;
    if (row) {
      result = row.snapshot as unknown as MonthResult;
      status = row.status as MonthStatus;
    } else {
      result = await this.calculate(userId, month, policy.rules);
      status = result.status;
    }
    return {
      salesperson: { id: person.id, name: person.name, employeeId: person.username },
      month,
      today,
      status,
      locked: row !== null,
      record: row ? this.recordOut(row, who) : null,
      result,
      policy: { percentBasis: policy.rules.percentBasis, configured: policy.configured },
      queries: queries.map((q) => ({
        id: q.id,
        message: q.message,
        status: q.status,
        response: q.response,
        resolvedBy: q.resolvedById ? (who.get(q.resolvedById) ?? null) : null,
        resolvedAt: q.resolvedAt?.toISOString() ?? null,
        createdAt: q.createdAt.toISOString(),
      })),
    };
  }

  /** Admin: every active salesperson's month at a glance. */
  async overview(month: string) {
    const today = todayString(new Date(), TZ);
    this.checkMonth(month, today);
    const [people, rows, openQueries, policy] = await Promise.all([
      prisma.user.findMany({ where: { role: Role.SALESPERSON, status: UserStatus.ACTIVE }, select: { id: true, name: true, username: true }, orderBy: { name: "asc" } }),
      prisma.incentiveMonth.findMany({ where: { month } }),
      prisma.incentiveQuery.groupBy({ by: ["userId"], where: { month, status: "OPEN" }, _count: { _all: true } }),
      this.policy(),
    ]);
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    const queriesBy = new Map(openQueries.map((q) => [q.userId, q._count._all]));
    const out = [];
    for (const p of people) {
      const row = byUser.get(p.id);
      const r = row ? (row.snapshot as unknown as MonthResult) : await this.calculate(p.id, month, policy.rules);
      out.push({
        id: p.id,
        name: p.name,
        employeeId: p.username,
        revenue: r.revenue,
        currentSlab: r.currentSlab,
        conditions: r.conditions.map((c) => ({ key: c.key, label: c.label, light: c.light, actual: c.actual })),
        incentive: row ? Number(row.amount) : r.potentialIncentive,
        status: row ? (row.status as MonthStatus) : r.status,
        statusReason: row ? (row.status === "PAID" ? "Paid" : "Approved and locked") : r.statusReason,
        openQueries: queriesBy.get(p.id) ?? 0,
      });
    }
    return { month, today, policy: { percentBasis: policy.rules.percentBasis, configured: policy.configured }, rows: out };
  }

  private audit(tx: Prisma.TransactionClient, actorId: string, action: string, details: object, userId?: string, month?: string) {
    return tx.incentiveAuditLog.create({ data: { actorId, action, details: details as Prisma.InputJsonValue, userId: userId ?? null, month: month ?? null } });
  }

  async setPolicy(admin: AuthUser, rules: IncentivePolicyRules) {
    const err = policyError(rules);
    if (err) throw new ApiError(err, STATUS_CODES.BAD_REQUEST);
    const before = await this.policy();
    const data = {
      slabs: rules.slabs.map((s) => ({ minRevenue: s.minRevenue, ...(s.amount !== undefined ? { amount: s.amount } : { percent: s.percent }) })) as unknown as Prisma.InputJsonValue,
      percentBasis: rules.percentBasis,
      minPrepaidPercent: rules.minPrepaidPercent,
      minDeliveryPercent: rules.minDeliveryPercent,
      minAttendanceDays: rules.minAttendanceDays,
      minNetLoginMinutes: rules.minNetLoginMinutes,
      minLoginDays: rules.minLoginDays,
      minDailyCalls: rules.minDailyCalls,
      minCallDays: rules.minCallDays,
      minAvgDailyOrdersX100: Math.round(rules.minAvgDailyOrders * 100),
      updatedById: admin.id,
    };
    await prisma.$transaction(async (tx) => {
      const existing = await tx.incentivePolicy.findFirst({ select: { id: true } });
      if (existing) await tx.incentivePolicy.update({ where: { id: existing.id }, data });
      else await tx.incentivePolicy.create({ data });
      await this.audit(tx, admin.id, "POLICY_UPDATED", { before: before.rules, after: rules });
    });
    return this.policy();
  }

  /** Approve and lock a month: only when every condition is met and the incentive is known. */
  async approve(admin: AuthUser, userId: string, month: string, note?: string) {
    await this.salesperson(userId);
    const today = todayString(new Date(), TZ);
    this.checkMonth(month, today);
    if (month >= today.slice(0, 7)) throw new ApiError("A month can be approved only after it has ended", STATUS_CODES.BAD_REQUEST);
    const existing = await prisma.incentiveMonth.findUnique({ where: { userId_month: { userId, month } } });
    if (existing) throw new ApiError("This month is already approved", STATUS_CODES.CONFLICT);
    const r = await this.calculate(userId, month);
    if (r.status !== "ELIGIBLE" || r.slabIncentive === null) throw new ApiError(`Cannot approve: ${r.statusReason}`, STATUS_CODES.BAD_REQUEST);
    await prisma.$transaction(async (tx) => {
      await tx.incentiveMonth.create({
        data: { userId, month, status: "APPROVED", amount: r.slabIncentive!, snapshot: r as unknown as Prisma.InputJsonValue, approvedById: admin.id, approvedAt: new Date() },
      });
      await this.audit(tx, admin.id, "MONTH_APPROVED", { amount: r.slabIncentive, revenue: r.revenue, slab: r.currentSlab, note: note ?? null }, userId, month);
    });
    return this.month(userId, month);
  }

  /** Record that an approved incentive has been paid. */
  async recordPayment(admin: AuthUser, userId: string, month: string, p: { paymentRef?: string; note?: string; paidOn?: string }) {
    const row = await prisma.incentiveMonth.findUnique({ where: { userId_month: { userId, month } } });
    if (!row) throw new ApiError("Approve the month before recording a payment", STATUS_CODES.BAD_REQUEST);
    if (row.status === "PAID") throw new ApiError("This incentive is already marked paid", STATUS_CODES.CONFLICT);
    const paidAt = p.paidOn ? dayBounds(p.paidOn, TZ).from : new Date();
    await prisma.$transaction(async (tx) => {
      await tx.incentiveMonth.update({ where: { id: row.id }, data: { status: "PAID", paidById: admin.id, paidAt, paymentRef: p.paymentRef ?? null, paymentNote: p.note ?? null } });
      await this.audit(tx, admin.id, "PAYMENT_RECORDED", { amount: Number(row.amount), paymentRef: p.paymentRef ?? null, paidOn: paidAt.toISOString(), note: p.note ?? null }, userId, month);
    });
    return this.month(userId, month);
  }

  async raiseQuery(user: AuthUser, month: string, message: string) {
    this.checkMonth(month, todayString(new Date(), TZ));
    await prisma.$transaction(async (tx) => {
      await tx.incentiveQuery.create({ data: { userId: user.id, month, message } });
      await this.audit(tx, user.id, "QUERY_RAISED", { message }, user.id, month);
    });
    return this.month(user.id, month);
  }

  async listQueries(status?: "OPEN" | "RESOLVED") {
    const rows = await prisma.incentiveQuery.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { user: { select: { name: true } } },
    });
    const who = await names(rows.map((r) => r.resolvedById));
    return rows.map((q) => ({
      id: q.id,
      userId: q.userId,
      name: q.user.name,
      month: q.month,
      message: q.message,
      status: q.status,
      response: q.response,
      resolvedBy: q.resolvedById ? (who.get(q.resolvedById) ?? null) : null,
      resolvedAt: q.resolvedAt?.toISOString() ?? null,
      createdAt: q.createdAt.toISOString(),
    }));
  }

  async resolveQuery(admin: AuthUser, id: string, response: string) {
    const q = await prisma.incentiveQuery.findUnique({ where: { id } });
    if (!q) throw new ApiError("Query not found", STATUS_CODES.NOT_FOUND);
    if (q.status === "RESOLVED") throw new ApiError("This query is already answered", STATUS_CODES.CONFLICT);
    await prisma.$transaction(async (tx) => {
      await tx.incentiveQuery.update({ where: { id }, data: { status: "RESOLVED", response, resolvedById: admin.id, resolvedAt: new Date() } });
      await this.audit(tx, admin.id, "QUERY_ANSWERED", { queryId: id, response }, q.userId, q.month);
    });
    return { ok: true };
  }

  async auditLog(f: { userId?: string; month?: string }) {
    const rows = await prisma.incentiveAuditLog.findMany({
      where: { ...(f.userId ? { userId: f.userId } : {}), ...(f.month ? { month: f.month } : {}) },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    const who = await names(rows.flatMap((r) => [r.actorId, r.userId]));
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: who.get(r.actorId) ?? null,
      salesperson: r.userId ? (who.get(r.userId) ?? null) : null,
      month: r.month,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

export type { PercentBasis };
export const incentivesService = new IncentivesService();
