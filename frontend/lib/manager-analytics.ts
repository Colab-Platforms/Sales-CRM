import type {
  AnalyticsQuery,
  CallCounts,
  CallStatusFilter,
  LeadStatusFilter,
  ManagerAnalytics,
  OrderStatusFilter,
  PaymentModeFilter,
  SalespersonStats,
} from "@/lib/api-client/types/manager-analytics.types";

// ---------- formatting ----------

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return `${s}s`;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export const formatMs = (ms: number) => formatDuration(ms / 1000);

export function formatCallDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const formatNumber = (n: number) => n.toLocaleString("en-IN");

export const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);
export const formatPct = (value: number, digits = 1) => `${value.toFixed(digits)}%`;
export const formatRupees = (n: number) => n.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
/** Change vs the previous period of the same length, worded so a zero baseline never shows as Infinity/NaN. */
export function periodChange(current: number, previous: number): { text: string; tone: "default" | "positive" | "negative" } {
  if (previous <= 0) {
    return current > 0 ? { text: "New: none in the previous period", tone: "positive" } : { text: "No sales in either period", tone: "default" };
  }
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.05) return { text: "Same as previous period", tone: "default" };
  return { text: `${change > 0 ? "+" : ""}${change.toFixed(1)}% vs previous period`, tone: change > 0 ? "positive" : "negative" };
}
/** Short axis/tile form: ₹1.2L, ₹3.4Cr. */
export const formatRupeesCompact = (n: number) =>
  n.toLocaleString("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 1 });

export function formatDay(ymd: string, style: "short" | "long" | "weekday" = "short"): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  const opts: Intl.DateTimeFormatOptions =
    style === "long"
      ? { month: "long", day: "numeric", year: "numeric" }
      : style === "weekday"
        ? { weekday: "short", month: "short", day: "numeric" }
        : { month: "short", day: "numeric" };
  return d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

// ---------- date range / filters ----------

export type RangePreset = "today" | "yesterday" | "7d" | "30d" | "month" | "custom";

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  month: "This Month",
  custom: "Custom Range",
};

export const CALL_STATUS_LABELS: Record<CallStatusFilter, string> = {
  ALL: "All Calls",
  CONNECTED: "Connected",
  NOT_CONNECTED: "Not Connected",
  FAILED: "Failed",
};

export const LEAD_STATUS_LABELS: Record<LeadStatusFilter, string> = {
  ALL: "All Leads",
  NOT_CONTACTED: "Not Contacted",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  CONVERTED: "Converted",
};

export interface DashboardFilters {
  preset: RangePreset;
  customFrom: string;
  customTo: string;
  salespersonId: string; // "" = all
  callStatus: CallStatusFilter;
  leadStatus: LeadStatusFilter;
  paymentMode: PaymentModeFilter;
  orderStatus: OrderStatusFilter;
}

export const PAYMENT_MODE_LABELS: Record<PaymentModeFilter, string> = { ALL: "All Payments", COD: "COD", PREPAID: "Prepaid" };
export const ORDER_STATUS_LABELS: Record<OrderStatusFilter, string> = {
  ALL: "All Order Statuses",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
};

/** Reports run on India business days (IST, UTC+5:30) for every viewer; the backend enforces the same offset. */
export const REPORT_TZ_OFFSET_MINUTES = 330;
const toYmd = (d: Date) => new Date(d.getTime() + REPORT_TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

export function presetRange(preset: RangePreset, customFrom: string, customTo: string, now = new Date()) {
  const day = (offset: number) => toYmd(new Date(now.getTime() - offset * 24 * 60 * 60_000));
  switch (preset) {
    case "today":
      return { from: day(0), to: day(0) };
    case "yesterday":
      return { from: day(1), to: day(1) };
    case "7d":
      return { from: day(6), to: day(0) };
    case "30d":
      return { from: day(29), to: day(0) };
    case "month": {
      const today = day(0);
      return { from: `${today.slice(0, 8)}01`, to: today };
    }
    case "custom": {
      const from = customFrom || day(6);
      const to = customTo || day(0);
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

export function defaultFilters(): DashboardFilters {
  const today = toYmd(new Date());
  return { preset: "today", customFrom: today, customTo: today, salespersonId: "", callStatus: "ALL", leadStatus: "ALL", paymentMode: "ALL", orderStatus: "ALL" };
}

export function toQuery(f: DashboardFilters): AnalyticsQuery {
  const { from, to } = presetRange(f.preset, f.customFrom, f.customTo);
  return {
    from,
    to,
    callStatus: f.callStatus,
    leadStatus: f.leadStatus,
    paymentMode: f.paymentMode,
    orderStatus: f.orderStatus,
    salespersonId: f.salespersonId || undefined,
    tzOffsetMinutes: REPORT_TZ_OFFSET_MINUTES,
  };
}

export function rangeLabel(from: string, to: string): string {
  return from === to ? formatDay(from, "long") : `${formatDay(from)} – ${formatDay(to)}`;
}

// ---------- derived metrics (formulas from the spec) ----------

export const contactRate = (s: { leads: number; contacted: number }) => pct(s.contacted, s.leads);
export const interestRate = (s: { contacted: number; interested: number }) => pct(s.interested, s.contacted);
export const conversionRate = (s: { leads: number; converted: number }) => pct(s.converted, s.leads);
export const connectionRate = (s: Pick<CallCounts, "calls" | "connected">) => pct(s.connected, s.calls);
export const avgCallDurationSec = (s: Pick<CallCounts, "connected" | "talkTimeSec">) =>
  s.connected > 0 ? s.talkTimeSec / s.connected : 0;
export const callsPerProductiveHour = (calls: number, productiveMs: number) =>
  productiveMs > 0 ? calls / (productiveMs / 3_600_000) : 0;

export type CallMetric = "calls" | "connected" | "notConnected" | "failed" | "talkTimeSec";

export const CALL_METRIC_LABELS: Record<CallMetric, string> = {
  calls: "Total Calls",
  connected: "Connected Calls",
  notConnected: "Not Connected",
  failed: "Failed Calls",
  talkTimeSec: "Total Talk Time",
};

export const formatCallMetric = (metric: CallMetric, value: number) =>
  metric === "talkTimeSec" ? formatDuration(value) : formatNumber(value);

// ---------- performance classification ----------

export type PerformanceLevel = "top" | "above" | "on" | "attention";

export const PERFORMANCE_LABELS: Record<PerformanceLevel, string> = {
  top: "Top performer",
  above: "Above target",
  on: "On target",
  attention: "Needs attention",
};

// Based on conversion rate against the team target; "top" is the best salesperson who is also at/above target.
export function performanceLevels(people: SalespersonStats[], targetPercent: number): Map<string, PerformanceLevel> {
  const result = new Map<string, PerformanceLevel>();
  const rated = people.filter((p) => p.leads > 0);
  const best = rated.length ? rated.reduce((a, b) => (conversionRate(b) > conversionRate(a) ? b : a)) : null;
  for (const p of people) {
    const rate = conversionRate(p);
    let level: PerformanceLevel;
    if (p.leads === 0) level = "on";
    else if (best && p.id === best.id && rate >= targetPercent && rated.length > 1) level = "top";
    else if (rate >= targetPercent) level = "above";
    else if (rate >= targetPercent * 0.8) level = "on";
    else level = "attention";
    result.set(p.id, level);
  }
  return result;
}

// ---------- productivity vs results ----------

export type Quadrant = "strong" | "coaching" | "efficient" | "attention";

export const QUADRANT_INFO: Record<Quadrant, { label: string; description: string }> = {
  strong: { label: "Strong performer", description: "High productivity, high conversion" },
  coaching: { label: "Coaching opportunity", description: "High productivity, low conversion" },
  efficient: { label: "Efficient", description: "Low productivity, high conversion – review workload" },
  attention: { label: "Needs attention", description: "Low productivity, low conversion" },
};

// Splits at the team average on both axes, so the labels are purely relative to this team and period.
export function classifyQuadrants(people: SalespersonStats[]) {
  const active = people.filter((p) => p.productiveMs > 0 || p.leads > 0);
  const avgProd = active.length ? active.reduce((a, p) => a + p.productiveMs, 0) / active.length : 0;
  const avgConv = active.length ? active.reduce((a, p) => a + conversionRate(p), 0) / active.length : 0;
  const map = new Map<string, Quadrant>();
  for (const p of active) {
    const highProd = p.productiveMs >= avgProd;
    const highConv = conversionRate(p) >= avgConv;
    map.set(p.id, highProd ? (highConv ? "strong" : "coaching") : highConv ? "efficient" : "attention");
  }
  return { map, avgProd, avgConv };
}

// ---------- insights (all computed from the loaded metrics) ----------

export interface Insight {
  tone: "positive" | "neutral" | "warning";
  text: string;
}

export function buildInsights(data: ManagerAnalytics, periodLabel: string): Insight[] {
  const people = data.salespeople;
  const out: Insight[] = [];
  if (people.length < 2) return out;

  const first = (name: string) => name.split(" ")[0]!;
  const withLeads = people.filter((p) => p.leads > 0);
  const avgCalls = people.reduce((a, p) => a + p.calls, 0) / people.length;
  const avgConv = pct(
    withLeads.reduce((a, p) => a + p.converted, 0),
    withLeads.reduce((a, p) => a + p.leads, 0),
  );

  if (withLeads.length > 0) {
    const top = withLeads.reduce((a, b) => (conversionRate(b) > conversionRate(a) ? b : a));
    if (top.converted > 0)
      out.push({
        tone: "positive",
        text: `${first(top.name)} has the highest conversion rate ${periodLabel} (${formatPct(conversionRate(top))}).`,
      });
  }

  if (avgCalls > 0) {
    const busiest = people.reduce((a, b) => (b.calls > a.calls ? b : a));
    const diff = ((busiest.calls - avgCalls) / avgCalls) * 100;
    if (diff >= 5)
      out.push({
        tone: "neutral",
        text: `${first(busiest.name)} has made ${Math.round(diff)}% more calls than the team average (${busiest.calls} vs ${Math.round(avgCalls)}).`,
      });
    for (const p of people) {
      if (p.calls >= avgCalls * 1.1 && p.leads > 0 && conversionRate(p) < avgConv * 0.9)
        out.push({
          tone: "warning",
          text: `${first(p.name)} has high activity (${p.calls} calls) but below-average conversion (${formatPct(conversionRate(p))} vs team ${formatPct(avgConv)}).`,
        });
    }
    const lowest = people.reduce((a, b) => (b.calls < a.calls ? b : a));
    const gap = ((avgCalls - lowest.calls) / avgCalls) * 100;
    if (gap >= 20)
      out.push({
        tone: "warning",
        text: `${first(lowest.name)} is ${Math.round(gap)}% below the team average on calls (${lowest.calls} vs ${Math.round(avgCalls)}).`,
      });
  }

  if (withLeads.length > 1) {
    const lowContact = withLeads.reduce((a, b) => (contactRate(b) < contactRate(a) ? b : a));
    out.push({
      tone: "warning",
      text: `${first(lowContact.name)} has the lowest contact rate (${formatPct(contactRate(lowContact))} of assigned leads).`,
    });
  }

  const idle = people.filter((p) => p.productiveMs > 0 && p.converted === 0);
  for (const p of idle.slice(0, 2))
    out.push({
      tone: "warning",
      text: `${first(p.name)} logged ${formatMs(p.productiveMs)} of productive time with no conversions.`,
    });

  return out;
}

// ---------- CSV export ----------

export function exportCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // The BOM tells Excel the file is UTF-8, so ₹ and non-English names open correctly.
  const blob = new Blob(["﻿", rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- filters <-> URL (so the drill-down keeps the manager's date range) ----------

export function filtersToSearch(f: DashboardFilters): string {
  const p = new URLSearchParams({ range: f.preset, callStatus: f.callStatus, leadStatus: f.leadStatus });
  if (f.paymentMode !== "ALL") p.set("payment", f.paymentMode);
  if (f.orderStatus !== "ALL") p.set("orderStatus", f.orderStatus);
  if (f.preset === "custom") {
    p.set("from", f.customFrom);
    p.set("to", f.customTo);
  }
  return p.toString();
}

export function filtersFromSearch(sp: { get(name: string): string | null }): DashboardFilters {
  const base = defaultFilters();
  const range = sp.get("range") as RangePreset | null;
  const callStatus = sp.get("callStatus") as CallStatusFilter | null;
  const leadStatus = sp.get("leadStatus") as LeadStatusFilter | null;
  const paymentMode = sp.get("payment") as PaymentModeFilter | null;
  const orderStatus = sp.get("orderStatus") as OrderStatusFilter | null;
  return {
    ...base,
    preset: range && range in RANGE_LABELS ? range : base.preset,
    customFrom: sp.get("from") ?? base.customFrom,
    customTo: sp.get("to") ?? base.customTo,
    callStatus: callStatus && callStatus in CALL_STATUS_LABELS ? callStatus : "ALL",
    leadStatus: leadStatus && leadStatus in LEAD_STATUS_LABELS ? leadStatus : "ALL",
    paymentMode: paymentMode && paymentMode in PAYMENT_MODE_LABELS ? paymentMode : "ALL",
    orderStatus: orderStatus && orderStatus in ORDER_STATUS_LABELS ? orderStatus : "ALL",
  };
}
