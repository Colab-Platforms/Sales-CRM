// ---------------------------------------------------------------------------------------------
// Sales revenue incentive rules - pure functions; incentives.service.ts feeds them real CRM records.
// Source of truth: the "Sales Revenue Incentive Policy" sheet (defaults below; an admin can change them).
//
//  Revenue slab   The highest slab the month's revenue reaches. Slab incentives are never added together.
//                 A percentage slab (2.5% at ₹3,00,000) is only calculated once the admin has confirmed its
//                 basis: TOTAL (of the whole month's revenue) or ABOVE_SLAB (of the revenue above the slab).
//  Conditions     All six are mandatory; failing any one means no incentive.
//                   1 Prepaid orders      prepaid orders / all orders            >= 40%
//                   2 Delivery            delivered orders / all orders          >= 80%  (returned orders count
//                                         as not delivered; orders still in transit are pending, not failed)
//                   3 Attendance          days present                           >= 26
//                   4 Net login time      days with >= 8h logged in minus breaks >= 26  ("8 hours per day for
//                                         all 26 days" - every qualifying day is checked on its own)
//                   5 Daily calls         days with >= 100 calls                 >= 26  (same: day by day,
//                                         never a monthly average that would hide a short day)
//                   6 Avg daily orders    orders / days present                  >= 12  (the policy itself
//                                         asks for an average here)
//  Colours        Green = met. Amber = not met yet but still possible this month, or waiting for data
//                 (orders in transit). Red = missed (a past month), or can no longer be met this month.
//  Month status   In Progress (current month) -> after the month: Not Eligible (no slab or a Red condition) /
//                 Pending Data Verification (an Amber condition, or a percentage slab whose basis is not
//                 confirmed) / Eligible - Awaiting Admin Approval. Approved and Paid come only from an admin.
// ---------------------------------------------------------------------------------------------

export type PercentBasis = "TOTAL" | "ABOVE_SLAB";

export interface Slab {
  /** Rupees. */
  minRevenue: number;
  /** A fixed incentive in rupees, or ... */
  amount?: number;
  /** ... a percentage (e.g. 2.5). */
  percent?: number;
}

export interface IncentivePolicyRules {
  slabs: Slab[];
  percentBasis: PercentBasis | null;
  minPrepaidPercent: number;
  minDeliveryPercent: number;
  minAttendanceDays: number;
  minNetLoginMinutes: number;
  minLoginDays: number;
  minDailyCalls: number;
  minCallDays: number;
  minAvgDailyOrders: number;
}

/** The Sales Revenue Incentive Policy sheet, as provided. The 2.5% basis is deliberately unconfirmed. */
export const DEFAULT_POLICY: IncentivePolicyRules = {
  slabs: [
    { minRevenue: 100000, amount: 1000 },
    { minRevenue: 125000, amount: 1500 },
    { minRevenue: 150000, amount: 2000 },
    { minRevenue: 200000, amount: 2500 },
    { minRevenue: 250000, amount: 4000 },
    { minRevenue: 300000, percent: 2.5 },
  ],
  percentBasis: null,
  minPrepaidPercent: 40,
  minDeliveryPercent: 80,
  minAttendanceDays: 26,
  minNetLoginMinutes: 8 * 60,
  minLoginDays: 26,
  minDailyCalls: 100,
  minCallDays: 26,
  minAvgDailyOrders: 12,
};

export type Light = "GREEN" | "AMBER" | "RED";
export type MonthStatus = "IN_PROGRESS" | "ELIGIBLE" | "APPROVED" | "PAID" | "NOT_ELIGIBLE" | "PENDING_VERIFICATION";

export interface DayInput {
  date: string;
  /** PRESENT / ABSENT, or PENDING / UPCOMING for today before the cut-off and future days. */
  attendance: "PRESENT" | "ABSENT" | "PENDING" | "UPCOMING" | "NOT_JOINED";
  netLoginMinutes: number;
  calls: number;
  orders: number;
}

export interface OrderTotals {
  /** Verified (sold) orders credited to the salesperson, plus their returned orders. */
  total: number;
  prepaid: number;
  delivered: number;
  returned: number;
  /** Shipped / out for delivery: delivery outcome not known yet. */
  inTransit: number;
  /** Confirmed / processing: not dispatched yet. */
  notDispatched: number;
}

export interface MonthInput {
  month: string;
  /** Today's IST date. */
  today: string;
  /** Every calendar day of the month. */
  days: DayInput[];
  /** Verified revenue in rupees (net of refunds). */
  revenue: number;
  orders: OrderTotals;
  policy: IncentivePolicyRules;
}

export interface Condition {
  key: "PREPAID" | "DELIVERY" | "ATTENDANCE" | "NET_LOGIN" | "DAILY_CALLS" | "AVG_ORDERS";
  label: string;
  actual: string;
  required: string;
  light: Light;
  /** One line under the condition. */
  summary: string;
  /** The calculation, step by step, for the details view. */
  details: string[];
}

export interface SlabView {
  minRevenue: number;
  incentive: string;
  achieved: boolean;
}

export interface MonthResult {
  month: string;
  isCurrentMonth: boolean;
  revenue: number;
  slabs: SlabView[];
  currentSlab: { minRevenue: number; incentive: string } | null;
  nextSlab: { minRevenue: number; remaining: number; incentive: string } | null;
  /** Rupees for the slab reached; null when no slab is reached or its percentage basis is unconfirmed. */
  slabIncentive: number | null;
  slabIncentiveNote: string | null;
  /** What the salesperson would receive if the month ended now: the slab incentive, or 0 if a condition is Red. */
  potentialIncentive: number | null;
  conditions: Condition[];
  status: MonthStatus;
  statusReason: string;
  daily: DailyRow[];
  totals: { presentDays: number; loginDays: number; callDays: number; calls: number; orders: number; netLoginMinutes: number };
}

export interface DailyRow {
  date: string;
  calls: number;
  orders: number;
  netLoginMinutes: number;
  attendance: DayInput["attendance"];
  /** MET = present with the day's login and calls targets met; SHORT = present but a target missed. */
  status: "MET" | "SHORT" | "ABSENT" | "TODAY" | "UPCOMING" | "NOT_JOINED";
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const pct = (num: number, den: number) => (den === 0 ? 0 : Math.round((num / den) * 1000) / 10);
const hours = (m: number) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m`;

export function slabLabel(s: Slab, basis: PercentBasis | null): string {
  if (s.amount !== undefined) return inr(s.amount);
  const of = basis === "TOTAL" ? " of total revenue" : basis === "ABOVE_SLAB" ? ` of revenue above ${inr(s.minRevenue)}` : " (basis awaiting admin confirmation)";
  return `${s.percent}%${of}`;
}

/** The incentive for a revenue: only the highest slab reached counts. */
export function slabFor(revenue: number, policy: Pick<IncentivePolicyRules, "slabs" | "percentBasis">) {
  const slabs = [...policy.slabs].sort((a, b) => a.minRevenue - b.minRevenue);
  const reached = slabs.filter((s) => revenue >= s.minRevenue);
  const current = reached.at(-1) ?? null;
  const next = slabs.find((s) => revenue < s.minRevenue) ?? null;
  let amount: number | null = null;
  let note: string | null = null;
  if (current?.amount !== undefined) amount = current.amount;
  else if (current?.percent !== undefined) {
    if (policy.percentBasis === "TOTAL") amount = Math.round(revenue * current.percent) / 100;
    else if (policy.percentBasis === "ABOVE_SLAB") amount = Math.round((revenue - current.minRevenue) * current.percent) / 100;
    else note = `The ${current.percent}% at ${inr(current.minRevenue)} is waiting for the admin to confirm whether it applies to total revenue or only revenue above ${inr(current.minRevenue)}.`;
  }
  return { slabs, current, next, amount, note };
}

export function monthDays(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export function evaluateMonth(i: MonthInput): MonthResult {
  const p = i.policy;
  const isCurrentMonth = i.today.slice(0, 7) === i.month;
  const monthOver = i.month < i.today.slice(0, 7);
  // Days that can still count this month: today (until it is over) and every day after it.
  const daysLeft = monthOver ? 0 : i.days.filter((d) => d.date >= i.today).length;

  const present = i.days.filter((d) => d.attendance === "PRESENT");
  const presentDays = present.length;
  const loginDays = present.filter((d) => d.netLoginMinutes >= p.minNetLoginMinutes).length;
  const callDays = present.filter((d) => d.calls >= p.minDailyCalls).length;
  const totalCalls = i.days.reduce((a, d) => a + d.calls, 0);
  const totalOrdersByDay = i.days.reduce((a, d) => a + d.orders, 0);
  const netLoginMinutes = present.reduce((a, d) => a + d.netLoginMinutes, 0);

  // A count of qualifying days: met, still reachable, or out of reach.
  const dayCount = (have: number, need: number): Light => (have >= need ? "GREEN" : have + daysLeft >= need ? "AMBER" : "RED");
  // A share that can still move until the month is over.
  const share = (ok: boolean): Light => (ok ? "GREEN" : monthOver ? "RED" : "AMBER");

  const o = i.orders;
  const prepaidPct = pct(o.prepaid, o.total);
  const deliveryPct = pct(o.delivered, o.total);
  const bestDeliveryPct = pct(o.delivered + o.inTransit + o.notDispatched, o.total);
  const avgOrders = presentDays === 0 ? 0 : Math.round((o.total / presentDays) * 10) / 10;

  let deliveryLight: Light;
  if (o.total > 0 && deliveryPct >= p.minDeliveryPercent) deliveryLight = "GREEN";
  else if (o.total > 0 && bestDeliveryPct >= p.minDeliveryPercent) deliveryLight = "AMBER"; // depends on orders still on their way
  else deliveryLight = monthOver ? "RED" : "AMBER";

  const conditions: Condition[] = [
    {
      key: "PREPAID",
      label: "Prepaid Orders",
      actual: `${prepaidPct}%`,
      required: `${p.minPrepaidPercent}%`,
      light: share(o.total > 0 && prepaidPct >= p.minPrepaidPercent),
      summary: `${o.prepaid} of ${o.total} orders prepaid`,
      details: [
        `Verified orders this month: ${o.total}`,
        `Prepaid orders: ${o.prepaid}`,
        `Prepaid share: ${o.prepaid} ÷ ${o.total} = ${prepaidPct}% (minimum ${p.minPrepaidPercent}%)`,
        "An order counts as prepaid when its payment method is prepaid; COD orders and orders with no payment yet do not.",
      ],
    },
    {
      key: "DELIVERY",
      label: "Delivery Achievement",
      actual: `${deliveryPct}%`,
      required: `${p.minDeliveryPercent}%`,
      light: deliveryLight,
      summary: `${o.delivered} delivered of ${o.total}${o.inTransit + o.notDispatched > 0 ? ` · ${o.inTransit + o.notDispatched} still on the way` : ""}`,
      details: [
        `Orders this month (verified + returned): ${o.total}`,
        `Delivered: ${o.delivered} · Returned: ${o.returned} · In transit: ${o.inTransit} · Not dispatched yet: ${o.notDispatched}`,
        `Delivery achievement: ${o.delivered} ÷ ${o.total} = ${deliveryPct}% (minimum ${p.minDeliveryPercent}%)`,
        o.inTransit + o.notDispatched > 0 ? `If every order still on its way is delivered: ${bestDeliveryPct}%` : "Every order's delivery outcome is known.",
      ],
    },
    {
      key: "ATTENDANCE",
      label: "Attendance",
      actual: `${presentDays} days`,
      required: `${p.minAttendanceDays} days`,
      light: dayCount(presentDays, p.minAttendanceDays),
      summary: `${presentDays} days present${!monthOver && presentDays < p.minAttendanceDays ? ` · ${daysLeft} days left this month` : ""}`,
      details: [
        `Days present (clocked in): ${presentDays}`,
        `Required: ${p.minAttendanceDays} days`,
        monthOver ? "The month is over." : `Days left in the month, today included: ${daysLeft}`,
      ],
    },
    {
      key: "NET_LOGIN",
      label: "Net Login Time",
      actual: `${loginDays} days · avg ${hours(presentDays ? netLoginMinutes / presentDays : 0)}`,
      required: `${hours(p.minNetLoginMinutes)} on ${p.minLoginDays} days`,
      light: dayCount(loginDays, p.minLoginDays),
      summary: `${loginDays} days with ${hours(p.minNetLoginMinutes)}+ net login`,
      details: [
        `Net login = time logged in minus breaks (tea, lunch, bio), checked day by day.`,
        `Days with at least ${hours(p.minNetLoginMinutes)}: ${loginDays} of ${presentDays} days present`,
        `Average per day present: ${hours(presentDays ? netLoginMinutes / presentDays : 0)} (shown for reference only - the condition counts qualifying days)`,
        `Required: ${p.minLoginDays} qualifying days`,
      ],
    },
    {
      key: "DAILY_CALLS",
      label: "Daily Calls",
      actual: `${callDays} days`,
      required: `${p.minDailyCalls}+ calls on ${p.minCallDays} days`,
      light: dayCount(callDays, p.minCallDays),
      summary: `${callDays} days with ${p.minDailyCalls}+ calls`,
      details: [
        `Days with at least ${p.minDailyCalls} calls: ${callDays} of ${presentDays} days present`,
        `Calls this month: ${totalCalls}`,
        `Required: ${p.minCallDays} qualifying days - each day is checked on its own, so a busy day does not make up for a short one.`,
      ],
    },
    {
      key: "AVG_ORDERS",
      label: "Average Daily Orders",
      actual: `${avgOrders}`,
      required: `${p.minAvgDailyOrders}`,
      light: share(presentDays > 0 && avgOrders >= p.minAvgDailyOrders),
      summary: `${o.total} orders over ${presentDays} days present`,
      details: [
        `Verified orders: ${o.total}`,
        `Days present: ${presentDays}`,
        `Average: ${o.total} ÷ ${presentDays} = ${avgOrders} per day (minimum ${p.minAvgDailyOrders})`,
      ],
    },
  ];

  const s = slabFor(i.revenue, p);
  const anyRed = conditions.some((c) => c.light === "RED");
  const anyAmber = conditions.some((c) => c.light === "AMBER");

  let status: MonthStatus;
  let statusReason: string;
  if (isCurrentMonth || !monthOver) {
    status = "IN_PROGRESS";
    statusReason = anyRed ? "A condition can no longer be met this month" : "The month is still running";
  } else if (!s.current) {
    status = "NOT_ELIGIBLE";
    statusReason = `Revenue ${inr(i.revenue)} is below the first slab (${inr(s.slabs[0]?.minRevenue ?? 0)})`;
  } else if (anyRed) {
    status = "NOT_ELIGIBLE";
    statusReason = `Not met: ${conditions.filter((c) => c.light === "RED").map((c) => c.label).join(", ")}`;
  } else if (anyAmber || s.amount === null) {
    status = "PENDING_VERIFICATION";
    statusReason = anyAmber ? `Waiting for data: ${conditions.filter((c) => c.light === "AMBER").map((c) => c.label).join(", ")}` : (s.note ?? "Waiting for data");
  } else {
    status = "ELIGIBLE";
    statusReason = "All conditions met - awaiting admin approval";
  }

  const daily: DailyRow[] = i.days.map((d) => ({
    date: d.date,
    calls: d.calls,
    orders: d.orders,
    netLoginMinutes: d.netLoginMinutes,
    attendance: d.attendance,
    status:
      d.date > i.today
        ? "UPCOMING"
        : d.attendance === "NOT_JOINED"
          ? "NOT_JOINED"
          : d.date === i.today && d.attendance !== "ABSENT"
            ? "TODAY"
            : d.attendance !== "PRESENT"
              ? "ABSENT"
              : d.netLoginMinutes >= p.minNetLoginMinutes && d.calls >= p.minDailyCalls
                ? "MET"
                : "SHORT",
  }));

  return {
    month: i.month,
    isCurrentMonth,
    revenue: i.revenue,
    slabs: s.slabs.map((x) => ({ minRevenue: x.minRevenue, incentive: slabLabel(x, p.percentBasis), achieved: i.revenue >= x.minRevenue })),
    currentSlab: s.current ? { minRevenue: s.current.minRevenue, incentive: slabLabel(s.current, p.percentBasis) } : null,
    nextSlab: s.next ? { minRevenue: s.next.minRevenue, remaining: Math.max(0, s.next.minRevenue - i.revenue), incentive: slabLabel(s.next, p.percentBasis) } : null,
    slabIncentive: s.amount,
    slabIncentiveNote: s.note,
    potentialIncentive: anyRed ? 0 : s.amount,
    conditions,
    status,
    statusReason,
    daily,
    totals: { presentDays, loginDays, callDays, calls: totalCalls, orders: totalOrdersByDay, netLoginMinutes },
  };
}

export function policyError(p: IncentivePolicyRules): string | null {
  if (p.slabs.length === 0) return "Add at least one revenue slab";
  const mins = p.slabs.map((s) => s.minRevenue);
  if (new Set(mins).size !== mins.length) return "Two slabs have the same revenue";
  for (const s of p.slabs) {
    if (!(s.minRevenue > 0)) return "Slab revenue must be above zero";
    if ((s.amount === undefined) === (s.percent === undefined)) return `The ₹${s.minRevenue} slab needs either an amount or a percentage`;
    if (s.amount !== undefined && s.amount < 0) return "Incentive amounts cannot be negative";
    if (s.percent !== undefined && (s.percent <= 0 || s.percent > 100)) return "A percentage must be between 0 and 100";
  }
  if (p.minPrepaidPercent < 0 || p.minPrepaidPercent > 100 || p.minDeliveryPercent < 0 || p.minDeliveryPercent > 100) return "Percentages must be between 0 and 100";
  for (const d of [p.minAttendanceDays, p.minLoginDays, p.minCallDays]) if (d < 0 || d > 31) return "Day counts must be between 0 and 31";
  return null;
}
