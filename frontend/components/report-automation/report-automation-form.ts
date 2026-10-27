import type { ReportAutomationConfigInput, ReportRecipientStatus } from "@/lib/api-client/types/report-automation.types";

// Client-side mirror of the server's validation (the server is the authority): the same recipient, time and metric rules, so a mistake is shown before saving.
export const normalizeRecipient = (value: string): string => value.trim().replace(/[\s\-().]/g, "");
export const E164 = /^\+[1-9]\d{9,14}$/;
export const MAX_RECIPIENTS = 10;
/** The only template the report uses: Utility, one named body variable {{report_text}}, created and approved in the Meta console, then synced into the CRM. */
export const REPORT_TEMPLATE_NAME = "daily_team_report";

export const REPORT_MODE_LABEL: Record<string, string> = {
  TODAY: "Today (the day it is sent)",
  YESTERDAY: "Yesterday (the day before it is sent)",
  DATE: "Select a specific date",
  LAST7DAYS: "Previous 7 days (complete days before it is sent)",
};

export const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

/** Problems with the recipient list, keyed by row index (and "list" for list-wide ones). */
export function validateRecipients(rows: { name?: string; phone: string }[], enabled: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const phone = normalizeRecipient(row.phone);
    if (!phone) { errors[String(i)] = "Enter a WhatsApp number"; return; }
    if (!E164.test(phone)) { errors[String(i)] = "Use a WhatsApp number with country code, e.g. +919876543210"; return; }
    // An Indian number has exactly 10 digits after +91: a number one digit short is valid E.164 but never matches the sender WhatsApp reports, so the reply window would never open.
    if (phone.startsWith("+91") && !/^\+91[6-9]\d{9}$/.test(phone)) { errors[String(i)] = "An Indian (+91) number needs exactly 10 digits after +91, e.g. +919876543210"; return; }
    if (seen.has(phone)) errors[String(i)] = "This number is already in the list";
    seen.add(phone);
    if ((row.name ?? "").trim().length > 100) errors[String(i)] = "The name can be at most 100 characters";
  });
  if (rows.length > MAX_RECIPIENTS) errors.list = `At most ${MAX_RECIPIENTS} recipients`;
  if (enabled && rows.length === 0) errors.list = "At least one recipient is required to enable the automation";
  return errors;
}

/** One message per problem; empty = ready to save. A disabled draft may be incomplete. */
export function validateForm(f: ReportAutomationConfigInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const rec = validateRecipients(f.recipients, f.enabled);
  if (Object.keys(rec).length > 0) errors.recipients = Object.values(rec)[0]!;
  if (f.reportFor === "DATE") {
    if (!f.dataDate || !/^\d{4}-\d{2}-\d{2}$/.test(f.dataDate) || new Date(`${f.dataDate}T00:00:00Z`).toISOString().slice(0, 10) !== f.dataDate) errors.dataDate = "Select the date the report should cover";
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.sendTime)) errors.sendTime = "Use a 24-hour time such as 21:00";
  if (f.enabled && f.sendText && !f.templateName.trim()) errors.templateName = `The approved template "${REPORT_TEMPLATE_NAME}" is required to enable the text message`;
  if (f.enabled && !f.sendText && !f.sendExcel) errors.sendText = "Turn on the text message, the Excel file, or both";
  const o = f.options;
  if (!(o.calls || o.leads || o.sales || o.followUps)) errors.options = "Choose at least one metric group";
  return errors;
}

// SENT is only "the provider accepted the request" - never shown as delivered. Delivered / Read come only from the provider's callback.
export const STATUS_LABEL: Record<ReportRecipientStatus, string> = {
  PENDING: "Pending",
  SENDING: "Sending",
  SENT: "Accepted by WhatsApp",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
  UNCERTAIN: "Outcome unknown",
  WAITING_FOR_REPLY: "Waiting for reply",
  SKIPPED: "Not sent (not needed / turned off)",
};

/** What the Sync templates button reports. Never claims a template is approved: only the dropdown (APPROVED, synced, correctly shaped templates) decides that. */
export function syncMessage(s: { supported: boolean; reason?: string; created: number; updated: number; unchanged: number; disabledMissing: number; total: number }): { ok: boolean; text: string } {
  if (!s.supported) {
    return { ok: false, text: `Meta template listing is not available${s.reason ? `: ${s.reason}` : ""}. Nothing was changed. Create or approve the template in the Meta console, then add it under WhatsApp > Templates and sync again.` };
  }
  return { ok: true, text: `Synced ${s.total} template${s.total === 1 ? "" : "s"} from Meta: ${s.created} new, ${s.updated} updated, ${s.unchanged} unchanged${s.disabledMissing > 0 ? `, ${s.disabledMissing} no longer at Meta` : ""}. Only APPROVED ones appear in the dropdown.` };
}

export const SYNC_TIMEOUT_MS = 20_000;

/** Label of one row of the Add Template picker; the key identifies it (the same name can exist in several languages). */
export const pickerKey = (t: { name: string; language: string }): string => `${t.name}|${t.language}`;
/** What a row's action shows: Already added (no button), Add, or why it cannot be added. */
export function pickerRowState(t: { alreadyAdded: boolean; compatible: boolean; incompatibleReason: string | null }): { kind: "added" | "add" | "blocked"; note: string | null } {
  if (t.alreadyAdded) return { kind: "added", note: null };
  if (!t.compatible) return { kind: "blocked", note: `The report cannot use this template: ${t.incompatibleReason ?? "unsupported variables"}.` };
  return { kind: "add", note: null };
}
/** The picker's load/add failure text; always followed by a Retry button in the modal. */
export function pickerErrorMessage(error: unknown, fallback = "Could not load the approved templates from Meta."): string {
  const err = error as { code?: string; message?: string; response?: { data?: { message?: string } } } | null;
  const server = err?.response?.data?.message;
  const timedOut = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" || /timeout|timed out/i.test(`${server ?? ""} ${err?.message ?? ""}`);
  return timedOut ? "The connection to Meta timed out, so the approved templates could not be loaded. Nothing was changed." : `${(server ?? fallback).replace(/\.?$/, ".")} Nothing was changed.`;
}

/** A readable reason for a failed/slow sync; the Admin is always pointed at manual registration. Never claims anything was synced. */
export function syncFailureMessage(error: unknown, fallback = "Could not sync templates from Meta."): string {
  const err = error as { code?: string; message?: string; response?: { data?: { message?: string } } } | null;
  const server = err?.response?.data?.message;
  const timedOut = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" || /timeout|timed out/i.test(`${server ?? ""} ${err?.message ?? ""}`);
  const base = timedOut ? "Syncing from Meta timed out. Your current template selection was not changed." : `${server ?? fallback} Your current template selection was not changed.`;
  return `${base} You can press Sync templates again later, or use Add Template to pick an approved template from Meta.`;
}

// ------------------------------------------------------------------------------------------------ Scheduled Reports section

export const FORMAT_LABEL: Record<string, string> = { NOTIFICATION: "Template notification", DETAIL: "Detailed report", EXCEL: "Excel" };
const SHORT_TZ: Record<string, string> = { "Asia/Kolkata": "IST", UTC: "UTC", "Asia/Dubai": "GST", "Asia/Singapore": "SGT", "Europe/London": "UK", "America/New_York": "ET" };
/** "28 Oct 2026, 6:00 PM IST" - an instant shown in the configured timezone (never the browser's). */
export function formatInZone(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${date}, ${time} ${SHORT_TZ[timezone] ?? timezone}`;
}
const dayLabel = (ymd: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${ymd}T00:00:00Z`));
/** The data dates a report covers: one day, or a range - always a calendar date, never a time. */
export const dataRangeLabel = (from: string, to: string): string => (from === to ? dayLabel(to) : `${dayLabel(from)} - ${dayLabel(to)}`);

export const cancelConfirmText = (r: { scheduledAt: string; timezone: string; dataFrom: string; dataTo: string }): string =>
  `Cancel the scheduled report for ${formatInZone(r.scheduledAt, r.timezone)} (data date ${dataRangeLabel(r.dataFrom, r.dataTo)})? It will not be sent to any recipient. Other days are not affected.`;
/** What the Delete-from-history confirmation says; a run with sent messages is warned that WhatsApp messages cannot be recalled. */
export const deleteConfirmText = (r: { recipientName: string | null; recipientPhone: string; dataFrom: string; dataTo: string; kind?: string; sentAny?: boolean }): string =>
  `Delete from history: ${r.kind === "TEST" ? "test run" : "scheduled run"} for ${r.recipientName ? `${r.recipientName} ` : ""}${r.recipientPhone}, report date ${dataRangeLabel(r.dataFrom, r.dataTo)}? This only hides the entry from this list (it is kept for audit).${r.sentAny ? " Messages already sent stay in WhatsApp - deleting the history cannot recall them." : ""}`;
export const PAUSE_CONFIRM = "Turn off the automation? No further scheduled reports will be sent until an Admin turns it on again. Completed runs and the history are kept, and messages already sent are not recalled.";

/** The success message after the backend confirmed a cancellation - names the exact date cancelled. */
export const cancelSuccessText = (r: { scheduledAt: string; timezone: string }): string => `Cancelled the report scheduled for ${formatInZone(r.scheduledAt, r.timezone)}. It will not be sent; the other days are unchanged.`;
/** A failure is shown as the backend's own reason and never claims success. */
export const cancelFailureText = (error: unknown): string => {
  const err = error as { response?: { data?: { message?: string } }; message?: string } | null;
  return `Not cancelled: ${err?.response?.data?.message ?? err?.message ?? "the request failed"}`;
};
