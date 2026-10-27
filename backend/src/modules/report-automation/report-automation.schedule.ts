import { localInstant, localParts, parseSendTime, resolvePeriod, shiftDate, tzOffsetMinutes, offsetLabel, periodLabel, type ReportPeriod } from "./report-automation.report.js";

// WHAT IS SCHEDULED, for the "Scheduled Reports" section. Pure: no database, no clock of its own.
// Two different dates are always kept apart: `scheduledAt` is WHEN the report is sent (an instant, shown in the automation's timezone); `dataFrom..dataTo` is WHICH days' figures it covers.
// The scheduler is a recurring daily one (saved time, saved timezone). There is no persistence for one-off future runs, so none are invented here.

export type PartKind = "NOTIFICATION" | "DETAIL" | "EXCEL";
export type RunPhase = "CANCELLED" | "SCHEDULED" | "PROCESSING" | "WAITING_FOR_REPLY" | "PARTIALLY_SENT" | "SENT" | "FAILED";
export const PHASE_LABEL: Record<RunPhase, string> = {
  SCHEDULED: "Scheduled",
  PROCESSING: "Processing",
  WAITING_FOR_REPLY: "Waiting for recipient reply",
  PARTIALLY_SENT: "Partially sent",
  SENT: "Sent",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const SENT = new Set(["SENT", "DELIVERED", "READ"]);
const BAD = new Set(["FAILED", "UNCERTAIN"]);

/** The status of a run (or of one recipient's row) from the statuses of its parts that are switched on. SKIPPED parts are ignored. Precedence: anything mid-send is Processing; anything held for the
 *  recipient's reply is Waiting; a mix of accepted and failed is Partially sent; only failures is Failed; nothing tried yet is Scheduled; otherwise Sent. */
export function derivePhase(parts: readonly string[]): RunPhase {
  const active = parts.filter((s) => s !== "SKIPPED");
  if (active.length === 0) return "SENT";
  if (active.includes("SENDING")) return "PROCESSING";
  if (active.every((s) => s === "PENDING")) return "SCHEDULED";
  if (active.includes("WAITING_FOR_REPLY")) return "WAITING_FOR_REPLY";
  const sent = active.some((s) => SENT.has(s));
  const bad = active.some((s) => BAD.has(s));
  if (bad) return sent ? "PARTIALLY_SENT" : "FAILED";
  if (active.includes("PENDING")) return sent ? "PARTIALLY_SENT" : "SCHEDULED";
  return "SENT";
}

export interface ScheduleAutomation {
  enabled: boolean;
  sendTime: string;
  timezone: string;
  reportFor: string;
  reportDataDate: string | null;
  sendText: boolean;
  sendExcel: boolean;
  updatedAt: Date;
}

export interface UpcomingOccurrence {
  /** The instant it will be sent. */
  scheduledAt: Date;
  /** The local calendar date of the send in the automation's timezone. */
  scheduledDate: string;
  dataFrom: string;
  dataTo: string;
  dataLabel: string;
  timezone: string;
  utcOffset: string;
  formats: PartKind[];
}

export const formatsOf = (a: { sendText: boolean; sendExcel: boolean }): PartKind[] => [...(a.sendText ? (["NOTIFICATION", "DETAIL"] as PartKind[]) : []), ...(a.sendExcel ? (["EXCEL"] as PartKind[]) : [])];

/** The next `count` occurrences of the saved daily send, none of which already has a run (`hasRun(date)`) and none of which predates the saved settings. A disabled automation has none. */
export function upcomingOccurrences(a: ScheduleAutomation, now: Date, hasRun: (occurrenceDate: string) => boolean, count = 3): UpcomingOccurrence[] {
  if (!a.enabled || (!a.sendText && !a.sendExcel)) return [];
  const minutes = parseSendTime(a.sendTime);
  const today = localParts(now, a.timezone).date;
  const out: UpcomingOccurrence[] = [];
  for (let offset = 0; offset < 14 && out.length < count; offset++) {
    const date = shiftDate(today, offset);
    const at = localInstant(date, minutes, a.timezone);
    if (at.getTime() <= now.getTime() || at.getTime() < a.updatedAt.getTime() || hasRun(date)) continue;
    const period: ReportPeriod = resolvePeriod(a.reportFor, a.reportDataDate, date);
    out.push({ scheduledAt: at, scheduledDate: date, dataFrom: period.from, dataTo: period.to, dataLabel: periodLabel(period), timezone: a.timezone, utcOffset: offsetLabel(tzOffsetMinutes(at, a.timezone)), formats: formatsOf(a) });
  }
  return out;
}
