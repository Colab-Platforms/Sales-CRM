export type Light = "GREEN" | "AMBER" | "RED";
export type IncentiveStatus = "IN_PROGRESS" | "ELIGIBLE" | "APPROVED" | "PAID" | "NOT_ELIGIBLE" | "PENDING_VERIFICATION";
export type PercentBasis = "TOTAL" | "ABOVE_SLAB";

export interface IncentiveCondition {
  key: "PREPAID" | "DELIVERY" | "ATTENDANCE" | "NET_LOGIN" | "DAILY_CALLS" | "AVG_ORDERS";
  label: string;
  actual: string;
  required: string;
  light: Light;
  summary: string;
  details: string[];
}

export interface IncentiveDailyRow {
  date: string;
  calls: number;
  orders: number;
  netLoginMinutes: number;
  attendance: "PRESENT" | "ABSENT" | "PENDING" | "UPCOMING" | "NOT_JOINED";
  status: "MET" | "SHORT" | "ABSENT" | "TODAY" | "UPCOMING" | "NOT_JOINED";
}

export interface IncentiveResult {
  month: string;
  isCurrentMonth: boolean;
  revenue: number;
  slabs: { minRevenue: number; incentive: string; achieved: boolean }[];
  currentSlab: { minRevenue: number; incentive: string } | null;
  nextSlab: { minRevenue: number; remaining: number; incentive: string } | null;
  slabIncentive: number | null;
  slabIncentiveNote: string | null;
  potentialIncentive: number | null;
  conditions: IncentiveCondition[];
  status: IncentiveStatus;
  statusReason: string;
  daily: IncentiveDailyRow[];
  totals: { presentDays: number; loginDays: number; callDays: number; calls: number; orders: number; netLoginMinutes: number };
}

export interface IncentiveQuery {
  id: string;
  message: string;
  status: "OPEN" | "RESOLVED";
  response: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface IncentiveMonth {
  salesperson: { id: string; name: string; employeeId: string };
  month: string;
  today: string;
  status: IncentiveStatus;
  /** Approved months are locked: `result` is the calculation frozen at approval. */
  locked: boolean;
  record: {
    status: "APPROVED" | "PAID";
    amount: number;
    approvedAt: string;
    approvedBy: string | null;
    paidAt: string | null;
    paidBy: string | null;
    paymentRef: string | null;
    paymentNote: string | null;
  } | null;
  result: IncentiveResult;
  policy: { percentBasis: PercentBasis | null; configured: boolean };
  queries: IncentiveQuery[];
}

export interface IncentiveOverviewRow {
  id: string;
  name: string;
  employeeId: string;
  revenue: number;
  currentSlab: { minRevenue: number; incentive: string } | null;
  conditions: { key: IncentiveCondition["key"]; label: string; light: Light; actual: string }[];
  incentive: number | null;
  status: IncentiveStatus;
  statusReason: string;
  openQueries: number;
}

export interface IncentiveOverview {
  month: string;
  today: string;
  policy: { percentBasis: PercentBasis | null; configured: boolean };
  rows: IncentiveOverviewRow[];
}

export interface IncentiveSlab {
  minRevenue: number;
  amount?: number;
  percent?: number;
}

export interface IncentivePolicyRules {
  slabs: IncentiveSlab[];
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

export interface IncentivePolicy {
  rules: IncentivePolicyRules;
  configured: boolean;
  updatedAt: string | null;
}

export interface AdminIncentiveQuery extends IncentiveQuery {
  userId: string;
  name: string;
  month: string;
}

export interface IncentiveAuditEntry {
  id: string;
  action: string;
  actor: string | null;
  salesperson: string | null;
  month: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
