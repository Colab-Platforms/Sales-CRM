import type { AbandonmentAssignmentFilter, AbandonmentDateRange } from "@/lib/api-client/types/abandonment.types";

// Typed URL state of the Abandoned Leads page, shared by every dashboard card / row that drills into it. The page re-validates everything it reads (a hand-edited URL falls
// back to the defaults) and the BACKEND re-checks every parameter and the viewer's scope, so a URL can never widen what someone is allowed to see.

export const DEFAULT_RANGE: AbandonmentDateRange = "today";
const RANGES: AbandonmentDateRange[] = ["today", "yesterday", "all"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AbandonedLeadsUrlState {
  range: AbandonmentDateRange;
  /** Only the leads currently assigned to this telecaller (user id). */
  salespersonId?: string;
  /** "UNASSIGNED_TELECALLER" = leads still waiting for a telecaller. */
  assignment?: Extract<AbandonmentAssignmentFilter, "UNASSIGNED_TELECALLER">;
}

export function abandonedLeadsHref(state: Partial<AbandonedLeadsUrlState> = {}): string {
  const q = new URLSearchParams();
  if (state.range && state.range !== DEFAULT_RANGE) q.set("range", state.range);
  if (state.salespersonId && UUID.test(state.salespersonId)) q.set("salespersonId", state.salespersonId);
  if (state.assignment === "UNASSIGNED_TELECALLER") q.set("assignment", state.assignment);
  const text = q.toString();
  return text ? `/dashboard/abandoned-leads?${text}` : "/dashboard/abandoned-leads";
}

/** Reads and validates the page's URL. Anything unrecognised is ignored (never trusted). */
export function parseAbandonedLeadsUrl(params: URLSearchParams): AbandonedLeadsUrlState {
  const rawRange = params.get("range");
  const rawPerson = params.get("salespersonId");
  const salespersonId = rawPerson && UUID.test(rawPerson) ? rawPerson : undefined;
  return {
    range: RANGES.includes(rawRange as AbandonmentDateRange) ? (rawRange as AbandonmentDateRange) : DEFAULT_RANGE,
    salespersonId,
    // a named telecaller and "no telecaller" cannot both apply
    assignment: !salespersonId && params.get("assignment") === "UNASSIGNED_TELECALLER" ? "UNASSIGNED_TELECALLER" : undefined,
  };
}
