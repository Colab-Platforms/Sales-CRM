import type { ReportAutomationConfigInput, SelectedTemplateStatus, SummaryKind, SummaryTemplateState, SummaryTemplateStatus } from "@/lib/api-client/types/report-automation.types";

// Presentation rules for the "Initial message template" card. Pure: the server decides the state (and writes the explanation); this only decides how it looks and which actions make sense.

export const STATE_LABEL: Record<SummaryTemplateState, string> = {
  READY: "Approved - ready",
  NOT_APPROVED: "Waiting for Meta approval",
  NOT_ADDED: "Not added yet",
  VARIABLES_MISMATCH: "Variables don't match",
};

/** Badge colours: green = usable, amber = waiting, red = needs a fix in Meta. */
export const STATE_TONE: Record<SummaryTemplateState, string> = {
  READY: "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300",
  NOT_APPROVED: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  NOT_ADDED: "bg-gray-200 text-gray-700 dark:bg-gray-500/25 dark:text-gray-300",
  VARIABLES_MISMATCH: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
};

/** Rejected / disabled templates need a fix in Meta, not just waiting: show them as a problem. */
export function stateLabel(t: Pick<SummaryTemplateStatus, "state" | "status">): string {
  if (t.state === "NOT_APPROVED" && t.status === "REJECTED") return "Rejected by Meta";
  if (t.state === "NOT_APPROVED" && t.status === "DISABLED") return "Disabled at Meta";
  if (t.state === "NOT_APPROVED" && t.status === "DRAFT") return "Draft - not submitted";
  return STATE_LABEL[t.state];
}
export function stateTone(t: Pick<SummaryTemplateStatus, "state" | "status">): string {
  if (t.state === "NOT_APPROVED" && (t.status === "REJECTED" || t.status === "DISABLED")) return STATE_TONE.VARIABLES_MISMATCH;
  return STATE_TONE[t.state];
}

export const KIND_LABEL: Record<SummaryKind, string> = {
  SHOPIFY_SUMMARY: "Shopify Orders Summary (total, website, telecaller-created, revenue)",
  WEBSITE_ABANDONED: "Website Orders + Abandoned Checkouts summary",
  REPORT_TEXT: "One-line report text",
  UNKNOWN: "Unknown",
};

/** "Use this template" only when it can actually be sent and is not already what the form has selected. The language travels with it (an approved template may exist in another language than the saved one). */
export function canUseTemplate(t: SummaryTemplateStatus, form: Pick<ReportAutomationConfigInput, "templateName" | "languageCode">): boolean {
  return t.state === "READY" && Boolean(t.language) && !(form.templateName === t.name && form.languageCode === t.language);
}

/** The warning when the SAVED selection could not be sent (shown before a scheduled report fails because of it); null when fine or nothing is selected. */
export function selectedTemplateWarning(s: SelectedTemplateStatus | null): string | null {
  if (!s || s.usable) return null;
  const why = (s.reason ?? "it is not available").replace(/[.\s]+$/, "");
  return `The selected template "${s.name}" cannot be sent: ${why}. Scheduled reports will fail until it is fixed or another template is selected.`;
}
