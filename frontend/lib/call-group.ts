/**
 * Raw CallerDesk `call_group` -> human label, display-only.
 *
 * The backend never does this translation (backend/src/modules/webhooks/callerdesk/callerdesk.service.ts
 * persists the raw string verbatim on `Call.callGroup`) - a mapping belongs here, at the one place
 * that renders it, so an unmapped value is still shown (as its raw string) rather than silently
 * hidden or mis-labelled as an existing category.
 *
 * Verified so far: "callgroup1" is the group CallerDesk sends for Sales inbound calls (confirmed
 * against real stored webhook payloads). No other raw value has ever been observed reaching this
 * CRM - in particular, no "Partnership" traffic has been seen, so there is nothing yet to add a
 * confirmed label for. The moment a real Partnership call's raw call_group is known (check a
 * received call's "Call Group" column, or the CallerDesk dashboard/account config), add ONE line
 * here - the Inbound IVR page's tabs are generated from whatever distinct groups the backend
 * actually returns (see ivr-filters.tsx), so a new raw value gets its own tab automatically, even
 * before a label is added for it (it just shows its raw value until then).
 */
export const CALL_GROUP_LABELS: Record<string, string> = {
  callgroup1: "Sales",
};

export function formatCallGroup(raw: string | null): string {
  if (!raw) return "—";
  return CALL_GROUP_LABELS[raw] ?? raw;
}
