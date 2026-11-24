import type { LeadIdFilter, LeadListParams } from "@/lib/api-client/types/lead.types";

const KEYS = ["segmentId", "customerClass", "assignment", "sourceId", "workingStatus", "search", "managerId", "salespersonId"] as const;

/**
 * The part of the lead list's filters that "select every lead matching this filter" may send to the server instead of tens of thousands of ids.
 * null when no such filter is active: selecting "everything" with no filter is never offered.
 */
export function idFilterOf(filters: Omit<LeadListParams, "page" | "limit">): LeadIdFilter | null {
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const v = filters[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as LeadIdFilter) : null;
}
