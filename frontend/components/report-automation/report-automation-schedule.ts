import type { ReportMode, ReportOptions } from "@/lib/api-client/types/report-automation.types";

// Pure helpers for the Report Automation page: the NEXT scheduled send and which day's data it covers (computed from the form, so the page can preview unsaved edits), the run status shown in the
// history, and the structure of the Excel file. No network, no clock of its own. Mirrors the server's rules (report-automation.report.ts / .schedule.ts); the server stays the authority for what is sent.

/** Add days to a calendar date (YYYY-MM-DD), calendar arithmetic only - no timezone involved. */
export function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** Offset of a timezone from UTC at an instant, in minutes (Asia/Kolkata = +330). */
function offsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The instant at which a timezone's wall clock reads `ymd` `HH:mm`. */
export function localInstant(ymd: string, hhmm: string, timezone: string): Date {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const guess = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), h, m);
  const first = guess - offsetMinutes(new Date(guess), timezone) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first), timezone) * 60_000);
}

export interface DataRange { from: string; to: string }

/**
 * Which calendar days a report sent on `sendDate` covers. For the recurring daily report this is ALWAYS derived from the send date (previous day = send date - 1); a manually chosen date is only used by the
 * legacy fixed-date mode, which the page no longer offers.
 */
export function dataRangeFor(mode: ReportMode, sendDate: string, fixedDate: string | null = null): DataRange {
  if (mode === "YESTERDAY") { const d = shiftDate(sendDate, -1); return { from: d, to: d }; }
  if (mode === "LAST7DAYS") return { from: shiftDate(sendDate, -7), to: shiftDate(sendDate, -1) };
  if (mode === "DATE" && fixedDate) return { from: fixedDate, to: fixedDate };
  return { from: sendDate, to: sendDate };
}

export interface NextOccurrence { sendAt: Date; sendDate: string; data: DataRange }

/** The next send: today's time if it is still ahead, otherwise tomorrow's - in the form's own timezone. A valid HH:mm is required. */
export function nextOccurrence(form: { sendTime: string; timezone: string; reportFor: ReportMode; dataDate: string | null }, now: Date): NextOccurrence | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.sendTime)) return null;
  const today = localDate(now, form.timezone);
  for (const offset of [0, 1]) {
    const sendDate = shiftDate(today, offset);
    const sendAt = localInstant(sendDate, form.sendTime, form.timezone);
    if (sendAt.getTime() > now.getTime()) return { sendAt, sendDate, data: dataRangeFor(form.reportFor, sendDate, form.dataDate) };
  }
  return null;
}

const SHORT_DAY = (ymd: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${ymd}T00:00:00Z`));
export const longDate = SHORT_DAY;
export const shortDate = (ymd: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${ymd}T00:00:00Z`));
export const rangeText = (r: DataRange, long = false) => (r.from === r.to ? (long ? longDate(r.to) : shortDate(r.to)) : `${long ? longDate(r.from) : shortDate(r.from)} - ${long ? longDate(r.to) : shortDate(r.to)}`);
/** "9:00 AM" in the given timezone. */
export const clock12 = (instant: Date, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(instant);

/** "today" / "tomorrow" / "yesterday" / the date - relative to `today` (all calendar dates in the same timezone). */
export function relativeDay(ymd: string, today: string): string {
  if (ymd === today) return "today";
  if (ymd === shiftDate(today, 1)) return "tomorrow";
  if (ymd === shiftDate(today, -1)) return "yesterday";
  return longDate(ymd);
}

/** The one-sentence plain-English explanation of the next report, e.g. "This report will be sent tomorrow at 9:00 AM and will contain sales data from today, 18 November 2026." */
export function explainNext(n: { sendAt: Date; sendDate: string; data: DataRange }, timezone: string, now: Date): string {
  const today = localDate(now, timezone);
  const when = `${relativeDay(n.sendDate, today)} at ${clock12(n.sendAt, timezone)}`;
  const single = n.data.from === n.data.to;
  const what = single
    ? `${relativeDay(n.data.to, today)}${["today", "tomorrow", "yesterday"].includes(relativeDay(n.data.to, today)) ? `, ${longDate(n.data.to)}` : ""}`
    : `${longDate(n.data.from)} to ${longDate(n.data.to)}`;
  return `This report will be sent ${when} and will contain sales data from ${what}.`;
}

// ------------------------------------------------------------------------------------------------ run status (history)

export type RunPhase = "CANCELLED" | "SCHEDULED" | "PROCESSING" | "WAITING_FOR_REPLY" | "PARTIALLY_SENT" | "SENT" | "FAILED";
export const PHASE_LABEL: Record<RunPhase, string> = { SCHEDULED: "Scheduled", PROCESSING: "Sending", WAITING_FOR_REPLY: "Waiting for reply", PARTIALLY_SENT: "Partially sent", SENT: "Sent", FAILED: "Failed", CANCELLED: "Cancelled" };
export const PHASE_TONE: Record<RunPhase, string> = {
  SCHEDULED: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300",
  PROCESSING: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  WAITING_FOR_REPLY: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  PARTIALLY_SENT: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300",
  SENT: "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
  CANCELLED: "bg-gray-200 text-gray-700 dark:bg-gray-500/25 dark:text-gray-300",
};
const SENT_SET = new Set(["SENT", "DELIVERED", "READ"]);
const BAD_SET = new Set(["FAILED", "UNCERTAIN"]);

/** The status of a run (or one recipient) from its parts' statuses; SKIPPED parts are ignored. Same precedence as the server. */
export function derivePhase(parts: readonly string[]): RunPhase {
  const active = parts.filter((s) => s !== "SKIPPED");
  if (active.length === 0) return "SENT";
  if (active.includes("SENDING")) return "PROCESSING";
  if (active.every((s) => s === "PENDING")) return "SCHEDULED";
  if (active.includes("WAITING_FOR_REPLY")) return "WAITING_FOR_REPLY";
  const sent = active.some((s) => SENT_SET.has(s));
  const bad = active.some((s) => BAD_SET.has(s));
  if (bad) return sent ? "PARTIALLY_SENT" : "FAILED";
  if (active.includes("PENDING")) return sent ? "PARTIALLY_SENT" : "SCHEDULED";
  return "SENT";
}

export interface RunLike { status: string; recipients: { status: string; detail: { status: string }; document: { status: string } }[] }
export function runPhase(run: RunLike): RunPhase {
  if (run.status === "CANCELLED") return "CANCELLED";
  return derivePhase(run.recipients.flatMap((r) => [r.status, r.detail.status, r.document.status]));
}

// ------------------------------------------------------------------------------------------------ Excel structure (preview)

/** The sheets and column headers of the Excel the report sends, for the options chosen (mirrors report-automation.xlsx.ts). */
export function excelStructure(o: ReportOptions): { sheet: string; columns: string[] }[] {
  const summary = ["Metric", "Value"];
  const people = ["Telecaller", ...(o.sales ? ["Orders", "Revenue", "Cancelled orders"] : []), ...(o.leads ? ["Leads handled", "Converted leads", "Conversion rate"] : []), ...(o.calls ? ["Total calls", "Connected calls", "Talk time (h:mm:ss)"] : []), ...(o.followUps ? ["Pending follow-ups"] : [])];
  return [{ sheet: "Team Summary", columns: summary }, { sheet: "Telecaller Performance", columns: people }];
}

/** Masked display of a stored E.164 number: +91•••••••210 style (first 3 and last 2 characters). */
export const maskPhone = (phone: string): string => (phone.length <= 6 ? phone : `${phone.slice(0, 3)}${"•".repeat(phone.length - 5)}${phone.slice(-2)}`);
