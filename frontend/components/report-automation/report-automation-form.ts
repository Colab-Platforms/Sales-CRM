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
  SKIPPED: "Not sent (not needed / turned off)",
};
