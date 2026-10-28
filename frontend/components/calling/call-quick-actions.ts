import type { CallStatus } from "@/lib/api-client/types/calling.types";

export type CallStateLabel = "Ringing" | "Connected" | "Call Ended";

/** The three states a telecaller needs to see in the popup, derived only from the provider-reported call status (never from the popup being opened or dismissed). */
export function callStateLabel(status: CallStatus | undefined): CallStateLabel {
  if (status === "CONNECTED") return "Connected";
  if (status === "COMPLETED" || status === "NO_ANSWER" || status === "BUSY" || status === "NOT_REACHABLE" || status === "FAILED") return "Call Ended";
  return "Ringing";
}

/** The full lead page, opened in a new tab so the live call popup (and anything typed in it) is never lost. */
export const fullLeadHref = (leadId: string): string => `/dashboard/leads/${encodeURIComponent(leadId)}`;

/** The customer line under the name: only what the call actually carries - nothing is invented when the number is unknown. */
export function customerLine(lead: { mobile?: string | null; status?: string | null }): string {
  return [lead.mobile ?? null, lead.status ? lead.status.replaceAll("_", " ") : null].filter(Boolean).join(" · ");
}

/** What the form has on screen vs what the server already holds (or this form just saved). True = a selection that would be lost on close. A saved disposition is never "unsaved". */
export function hasUnsavedOutcome(
  selected: { outcomeId: string; notes: string },
  stored: { outcomeId: string | null; notes: string | null },
  justSaved: { outcomeId: string; notes: string } | null,
): boolean {
  if (!selected.outcomeId) return false;
  const same = (o: { outcomeId: string | null; notes: string | null }) => o.outcomeId === selected.outcomeId && (o.notes ?? "") === selected.notes;
  return !(same(stored) || (justSaved !== null && same(justSaved)));
}

/** The line shown after a disposition is saved (and when the popup is reopened on a call that already has one). Quick actions stay available either way. */
export function savedSummary(outcomeName: string | null | undefined, followUpAt: string | null | undefined, timeZone?: string): string | null {
  if (!outcomeName) return null;
  const when = followUpAt ? new Date(followUpAt) : null;
  const at = when && !Number.isNaN(when.getTime()) ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, ...(timeZone ? { timeZone } : {}) }).format(when) : null;
  return `Saved: ${outcomeName}${at ? ` · follow-up ${at}` : ""}`;
}
