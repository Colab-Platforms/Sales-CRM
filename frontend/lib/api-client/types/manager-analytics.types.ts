export type CallStatusFilter = "ALL" | "CONNECTED" | "NOT_CONNECTED" | "FAILED";
export type LeadStatusFilter = "ALL" | "NOT_CONTACTED" | "CONTACTED" | "INTERESTED" | "CONVERTED";

export interface AnalyticsQuery {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  salespersonId?: string;
  callStatus: CallStatusFilter;
  leadStatus: LeadStatusFilter;
  tzOffsetMinutes: number;
}

export interface CallCounts {
  calls: number;
  connected: number;
  notConnected: number;
  failed: number;
  uniqueLeads: number;
  talkTimeSec: number;
}

export interface SalespersonStats extends CallCounts {
  id: string;
  name: string;
  username: string;
  email: string | null;
  accountStatus: string;
  workStatus: string;
  leads: number;
  contacted: number;
  interested: number;
  converted: number;
  productiveMs: number;
}

export interface DailyBucket extends CallCounts {
  date: string; // YYYY-MM-DD
  productiveMs: number;
  interested: number;
  converted: number;
  bySalesperson: Record<string, CallCounts & { productiveMs: number; interested: number; converted: number }>;
}

export interface AnalyticsKpis {
  totalLeads: number;
  previousTotalLeads: number;
  notContacted: number;
  contacted: number;
  interested: number;
  converted: number;
  callsMade: number;
  connectedCalls: number;
  notConnectedCalls: number;
  failedCalls: number;
  uniqueLeadsContacted: number;
  talkTimeSec: number;
  productiveMs: number;
}

export interface ActivityItem {
  id: string;
  at: string;
  kind: "CALL" | "ACTIVITY" | "SESSION";
  title: string;
  detail: string | null;
  durationSec: number | null;
  leadId: string | null;
}

export interface ManagerAnalytics {
  range: { from: string; to: string; days: number; tzOffsetMinutes: number };
  targets: { conversionRatePercent: number; productiveMsPerDay: number };
  team: { id: string; name: string; username: string }[];
  kpis: AnalyticsKpis;
  salespeople: SalespersonStats[];
  daily: DailyBucket[];
}

export interface SalespersonAnalytics extends ManagerAnalytics {
  salesperson: SalespersonStats;
  recentActivity: ActivityItem[];
}
