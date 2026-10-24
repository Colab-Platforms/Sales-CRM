import { prisma } from "@/lib/prisma.js";
import { TaskStatus, TaskType } from "../../../generated/prisma/enums.js";
import type { Role } from "../../../generated/prisma/enums.js";
import { managerAnalyticsService } from "../manager/manager.analytics.js";

// The daily telecaller report: ONE definition of every figure, reused from the CRM (the Manager / Admin analytics), formatted for a WhatsApp message.
//
//  Scope        an Admin's report covers every active telecaller, a Manager's their direct reports - exactly the analytics' own team rule (managerAnalyticsService).
//  Day          one calendar day in the automation's timezone (default Asia/Kolkata): [00:00, next 00:00) local, converted to UTC with that zone's offset on that date.
//  Leads        leads handed to the telecaller that day (the analytics' lead cohort); contacted / interested / converted are the analytics' own stage rules.
//  Calls        calls the telecaller made that day, connected / not connected / failed, and talk time (the analytics' call rules).
//  Orders       the Sales & Revenue definition: an eligible order (confirmed, processing, shipped, out for delivery or delivered) is credited to ONE person, once, dated by when the sale happened.
//  Cancelled    orders the telecaller confirmed in the CRM that were cancelled that day (Order.confirmedByUserId + Order.cancelledAt).
//  Follow-ups   the telecaller's open follow-up / callback tasks (PENDING or OVERDUE) that were due by the end of that day.
//  Conversion   converted leads / leads handed over that day, as a percentage, shown only when at least one lead was handed over. It is the same numerator and denominator the analytics use.
// A figure the CRM cannot supply is left out of the message, never filled in.

export interface ReportOptions {
  teamSummary: boolean;
  calls: boolean;
  leads: boolean;
  sales: boolean;
  followUps: boolean;
}

export const DEFAULT_OPTIONS: ReportOptions = { teamSummary: true, calls: true, leads: true, sales: true, followUps: true };

export function normalizeOptions(value: unknown): ReportOptions {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const pick = (k: keyof ReportOptions) => (typeof v[k] === "boolean" ? (v[k] as boolean) : DEFAULT_OPTIONS[k]);
  return { teamSummary: pick("teamSummary"), calls: pick("calls"), leads: pick("leads"), sales: pick("sales"), followUps: pick("followUps") };
}

// ---------------------------------------------------------------------------------------------- time zones

/** An IANA zone such as Asia/Kolkata (or UTC). Bare abbreviations like "IST" are refused: they are ambiguous (India / Ireland / Israel). */
export function isValidTimezone(timezone: string): boolean {
  if (timezone !== "UTC" && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date (YYYY-MM-DD) and minutes since local midnight at instant `at` in `timezone`. */
export function localParts(at: Date, timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** The zone's UTC offset in minutes (east positive) at instant `at`. */
export function tzOffsetMinutes(at: Date, timezone: string): number {
  const { date, minutes } = localParts(at, timezone);
  const asUtc = Date.parse(`${date}T00:00:00.000Z`) + minutes * 60_000;
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The UTC instant at which the wall-clock time `minutes` after local midnight happens on local `date` in `timezone` (offset read at that very instant, so a daylight-saving change is honoured). */
export function localInstant(date: string, minutes: number, timezone: string): Date {
  const naive = Date.parse(`${date}T00:00:00.000Z`) + minutes * 60_000;
  let guess = naive - tzOffsetMinutes(new Date(naive), timezone) * 60_000;
  guess = naive - tzOffsetMinutes(new Date(guess), timezone) * 60_000;
  return new Date(guess);
}

export const shiftDate = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The UTC instants bounding local day `date` in `timezone`: [start, end). The offset is read at local noon so a daylight-saving change inside the day cannot shift the day. */
export function dayBounds(date: string, timezone: string): { start: Date; end: Date; offsetMinutes: number } {
  const noonUtc = new Date(`${date}T12:00:00.000Z`);
  const offsetMinutes = tzOffsetMinutes(noonUtc, timezone);
  const start = new Date(Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000);
  return { start, end: new Date(start.getTime() + 86_400_000), offsetMinutes };
}

/** The local day a scheduled report is FOR. */
export const reportDateFor = (now: Date, timezone: string, reportFor: "TODAY" | "YESTERDAY"): string => {
  const today = localParts(now, timezone).date;
  return reportFor === "YESTERDAY" ? shiftDate(today, -1) : today;
};

export const parseSendTime = (hhmm: string): number => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error("Invalid send time");
  return Number(m[1]) * 60 + Number(m[2]);
};

// ---------------------------------------------------------------------------------------------- data

export interface PersonReport {
  id: string;
  name: string;
  leads: number;
  contacted: number;
  interested: number;
  converted: number;
  conversionPct: number | null;
  calls: number;
  connected: number;
  talkTimeSec: number;
  orders: number;
  revenue: number;
  cancelledOrders: number;
  pendingFollowUps: number;
}

/** Which data the report covers. TODAY / YESTERDAY are relative to the day the report is sent; DATE is one saved calendar day whenever it is sent; LAST7DAYS is the seven complete days before the send day. */
export type ReportMode = "TODAY" | "YESTERDAY" | "DATE" | "LAST7DAYS";
export const REPORT_MODES: readonly ReportMode[] = ["TODAY", "YESTERDAY", "DATE", "LAST7DAYS"];
export interface ReportPeriod {
  /** First local calendar day covered (YYYY-MM-DD, in the report's timezone). */
  from: string;
  /** Last local calendar day covered, inclusive. Equal to `from` for a single day. */
  to: string;
}
export const isValidDateString = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** The data period for a mode, relative to `anchor` = the local day the report is sent (the scheduled occurrence's day; today for a preview / test send). The saved `dataDate` is used as-is for DATE: the
 *  send day never changes it. */
export function resolvePeriod(mode: string, dataDate: string | null | undefined, anchor: string): ReportPeriod {
  if (mode === "YESTERDAY") return { from: shiftDate(anchor, -1), to: shiftDate(anchor, -1) };
  if (mode === "LAST7DAYS") return { from: shiftDate(anchor, -7), to: shiftDate(anchor, -1) };
  if (mode === "DATE") {
    if (!isValidDateString(dataDate)) throw new Error("A specific report date is selected but no valid date is saved.");
    return { from: dataDate, to: dataDate };
  }
  return { from: anchor, to: anchor };
}

export const periodLabel = (p: ReportPeriod): string => (p.from === p.to ? dateLabelOf(p.to) : `${dateLabelOf(p.from)} - ${dateLabelOf(p.to)}`);
const dateLabelOf = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export interface DailyReportData {
  /** The LAST day covered (kept for single-day consumers); `from` is the first. */
  date: string;
  from: string;
  to: string;
  timezone: string;
  offsetMinutes: number;
  people: PersonReport[];
  /** EVERY telecaller in the owner's scope before the roster is applied (id + name) - what the roster picker lists. `people` is only those the roster includes. */
  scope: { id: string; name: string }[];
  team: Omit<PersonReport, "id" | "name"> & { telecallers: number };
}

interface OverviewRow {
  id: string;
  name: string;
  leads: number;
  contacted: number;
  interested: number;
  converted: number;
  calls: number;
  connected: number;
  talkTimeSec: number;
  orders: number;
  revenue: number;
}

export interface ReportSources {
  overview(viewer: { id: string; role: Role }, from: string, to: string, offsetMinutes: number): Promise<OverviewRow[]>;
  cancelledByUser(userIds: string[], start: Date, end: Date): Promise<Map<string, number>>;
  pendingFollowUps(userIds: string[], end: Date): Promise<Map<string, number>>;
}

export const liveSources: ReportSources = {
  async overview(viewer, from, to, offsetMinutes) {
    const data = await managerAnalyticsService.overview(viewer, { from, to, tzOffsetMinutes: offsetMinutes, paymentMode: "ALL", orderStatus: "ALL", callStatus: "ALL", leadStatus: "ALL" });
    return data.salespeople.map((p) => ({ id: p.id, name: p.name, leads: p.leads, contacted: p.contacted, interested: p.interested, converted: p.converted, calls: p.calls, connected: p.connected, talkTimeSec: p.talkTimeSec, orders: p.orders, revenue: p.revenue }));
  },
  async cancelledByUser(userIds, start, end) {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.order.groupBy({ by: ["confirmedByUserId"], where: { confirmedByUserId: { in: userIds }, cancelledAt: { gte: start, lt: end } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.confirmedByUserId!, r._count._all]));
  },
  async pendingFollowUps(userIds, end) {
    if (userIds.length === 0) return new Map();
    const rows = await prisma.task.groupBy({
      by: ["assignedToId"],
      where: { assignedToId: { in: userIds }, status: { in: [TaskStatus.PENDING, TaskStatus.OVERDUE] }, type: { in: [TaskType.FOLLOW_UP, TaskType.CALLBACK] }, scheduledAt: { lt: end } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.assignedToId, r._count._all]));
  },
};

const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** `include` = the roster (user ids). Empty / absent = every telecaller in scope. Applied BEFORE any total, so team figures are the sums of the included people only; an excluded user's orders, calls and
 *  leads are left out - never attributed to anyone else - and the underlying data is untouched. */
export async function buildReportData(viewer: { id: string; role: Role }, period: string | ReportPeriod, timezone: string, sources: ReportSources = liveSources, include: readonly string[] = []): Promise<DailyReportData> {
  const { from, to } = typeof period === "string" ? { from: period, to: period } : period;
  if (!isValidDateString(from) || !isValidDateString(to) || from > to) throw new Error("Invalid report period.");
  // The whole period is read in the report timezone: [start of `from`, end of `to`). The offset is the one in force on the last day (constant across the period, as the analytics service uses it).
  const { start } = dayBounds(from, timezone);
  const { end, offsetMinutes } = dayBounds(to, timezone);
  const everyone = await sources.overview(viewer, from, to, offsetMinutes);
  const roster = new Set(include);
  const rows = roster.size === 0 ? everyone : everyone.filter((r) => roster.has(r.id));
  const ids = rows.map((r) => r.id);
  const [cancelled, followUps] = await Promise.all([sources.cancelledByUser(ids, start, end), sources.pendingFollowUps(ids, end)]);

  const people: PersonReport[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    leads: r.leads,
    contacted: r.contacted,
    interested: r.interested,
    converted: r.converted,
    conversionPct: pct(r.converted, r.leads),
    calls: r.calls,
    connected: r.connected,
    talkTimeSec: r.talkTimeSec,
    orders: r.orders,
    revenue: r.revenue,
    cancelledOrders: cancelled.get(r.id) ?? 0,
    pendingFollowUps: followUps.get(r.id) ?? 0,
  }));
  // Team totals are the sums of the individuals above (each order is credited to one person, so nothing is counted twice).
  const sum = (k: "leads" | "contacted" | "interested" | "converted" | "calls" | "connected" | "talkTimeSec" | "orders" | "revenue" | "cancelledOrders" | "pendingFollowUps") => people.reduce((a, p) => a + p[k], 0);
  const team = {
    telecallers: people.length,
    leads: sum("leads"),
    contacted: sum("contacted"),
    interested: sum("interested"),
    converted: sum("converted"),
    conversionPct: pct(sum("converted"), sum("leads")),
    calls: sum("calls"),
    connected: sum("connected"),
    talkTimeSec: sum("talkTimeSec"),
    orders: sum("orders"),
    revenue: Math.round(sum("revenue") * 100) / 100,
    cancelledOrders: sum("cancelledOrders"),
    pendingFollowUps: sum("pendingFollowUps"),
  };
  return { date: to, from, to, timezone, offsetMinutes, people, scope: everyone.map((r) => ({ id: r.id, name: r.name })), team };
}

// ---------------------------------------------------------------------------------------------- message

const money = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const dur = (sec: number) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function offsetLabel(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const a = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** User-controlled text (a telecaller's name) goes into WhatsApp formatting: strip control characters and the markup characters (* _ ~ `) that would break the layout, and cap the length. */
export const safeName = (name: string): string => name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "Unnamed";

export const formatDuration = (sec: number): string => dur(sec);
export const formatMoney = (n: number): string => money(n);
export const formatDateLabel = (date: string): string => dateLabel(date);

type Metrics = Omit<PersonReport, "id" | "name">;

/** The metric lines for one person, only for the selected groups; a metric the data does not have is left out, never invented. */
function metricLines(p: Metrics, o: ReportOptions): string[] {
  const rate = p.conversionPct === null ? "" : ` (${p.conversionPct}%)`;
  const lines: string[] = [];
  if (o.sales) lines.push(`Orders: ${p.orders} | Revenue: ${money(p.revenue)}`, `Cancelled orders: ${p.cancelledOrders}`);
  if (o.leads) lines.push(`Leads: ${p.leads} | Converted: ${p.converted}${rate}`);
  if (o.calls) lines.push(`Calls: ${p.calls} | Connected: ${p.connected}`, `Talk time: ${dur(p.talkTimeSec)}`);
  if (o.followUps) lines.push(`Pending follow-ups: ${p.pendingFollowUps}`);
  return lines;
}

/** The team block: one metric per line (TEAM OVERVIEW). */
function teamLines(t: Metrics, o: ReportOptions): string[] {
  const lines: string[] = [];
  if (o.sales) lines.push(`Orders: ${t.orders}`, `Revenue: ${money(t.revenue)}`, `Cancelled orders: ${t.cancelledOrders}`);
  if (o.leads) lines.push(`Leads handled: ${t.leads}`, `Converted: ${t.converted}${t.conversionPct === null ? "" : ` (${t.conversionPct}%)`}`);
  if (o.calls) lines.push(`Calls: ${t.calls}`, `Connected calls: ${t.connected}`, `Talk time: ${dur(t.talkTimeSec)}`);
  if (o.followUps) lines.push(`Pending follow-ups: ${t.pendingFollowUps}`);
  return lines;
}

const BRAND_TITLE = "*AYUSHWELLNESS | DAILY TEAM REPORT*";

/** The readable multi-line message (what the preview shows). `maxPeople` limits the telecaller blocks and says how many are left out. */
export function formatReportText(data: DailyReportData, options: ReportOptions, maxPeople = Number.POSITIVE_INFINITY): string {
  const out: string[] = [BRAND_TITLE, data.from === data.to ? `Date: ${dateLabel(data.to)}` : `Period: ${dateLabel(data.from)} to ${dateLabel(data.to)}`, `Timezone: ${data.timezone}`];
  if (data.people.length === 0) {
    out.push("", "No active telecallers are in this report's scope.");
    return out.join("\n");
  }
  if (options.teamSummary) out.push("", "*TEAM OVERVIEW*", ...teamLines(data.team, options));
  out.push("", "*TELECALLER PERFORMANCE*");
  const shown = data.people.slice(0, Math.max(0, maxPeople));
  for (const p of shown) out.push("", `*${safeName(p.name)}*`, ...metricLines(p, options));
  const left = data.people.length - shown.length;
  if (left > 0) out.push("", `+${left} more telecaller${left === 1 ? "" : "s"} not shown - see the Excel report`);
  return out.join("\n");
}

/** The detailed report is sent as ONE free-form WhatsApp text, whose body can be at most 4096 characters. Whole telecaller blocks are dropped (never cut in half) so it fits; the text then says how many
 *  telecallers are not shown and that the complete breakdown is in the Excel file. */
export const DETAIL_TEXT_MAX = 3900;
export function fitDetailText(data: DailyReportData, options: ReportOptions): { text: string; shown: number; truncated: boolean } {
  let shown = data.people.length;
  let text = formatReportText(data, options, shown);
  while (text.length > DETAIL_TEXT_MAX && shown > 0) {
    shown -= Math.max(1, Math.ceil(shown * 0.1));
    text = formatReportText(data, options, shown);
  }
  return { text, shown, truncated: shown < data.people.length };
}

/** What goes into the template's single variable {{report_text}}: a SHORT one-line notification with the headline numbers. It is deliberately not the report - a template parameter is meant for one
 *  short value (WhatsApp/Meta guidance and BSP documentation list line breaks, tabs and runs of 4+ spaces as causes of template error 132018), so the readable multi-line report goes in the separate
 *  free-form text and the Excel file. `detailsFollow` says whether those two are coming (the recipient's 24-hour window is open) or why not. */
export const NOTIFICATION_MAX = 400;
export function toTemplateParam(data: DailyReportData, options: ReportOptions, detailsFollow = true): { text: string; truncated: boolean } {
  const t = data.team;
  const parts: string[] = [];
  if (data.people.length === 0) parts.push("no active telecallers in scope");
  else {
    if (options.sales) parts.push(`Orders ${t.orders}`, `Revenue ${money(t.revenue)}`);
    if (options.leads) parts.push(`Leads ${t.leads}`, `Converted ${t.converted}${t.conversionPct === null ? "" : ` (${t.conversionPct}%)`}`);
    if (options.calls) parts.push(`Calls ${t.calls}`);
    if (options.followUps) parts.push(`Pending follow-ups ${t.pendingFollowUps}`);
  }
  const tail = detailsFollow
    ? "The full report and the Excel file follow in the next messages."
    : "The full report and Excel could not be sent because WhatsApp's 24-hour window for this number is closed: reply to this number to receive them.";
  const text = `Team report for ${periodLabel({ from: data.from, to: data.to })} (${data.timezone}): ${parts.join(", ")}. ${tail}`.replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " ");
  return { text: text.slice(0, NOTIFICATION_MAX), truncated: false };
}
