import type { Prisma } from "../../../generated/prisma/client.js";
import type { CallStatus } from "../../../generated/prisma/enums.js";
import type { CallStatusCount, CallSummary, ListCallsQuery } from "./call.history.types.js";

const MAX_SEARCH_TERMS = 5;

// Call itself has no free-text field worth searching; search reaches through to its lead, the same
// way a customer is searched everywhere else in this app (name / lead number / mobile).
export function searchWhere(search: string): Prisma.CallWhereInput {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);

  return {
    AND: terms.map((term): Prisma.CallWhereInput => {
      const contains = { contains: term, mode: "insensitive" as const };
      return {
        lead: {
          OR: [{ firstName: contains }, { lastName: contains }, { leadNumber: contains }, { mobile: contains }],
        },
      };
    }),
  };
}

// Mirrors orders.filters.ts#buildOrderWhere: the lead scope (who may see this call, via its lead)
// is just one more AND-ed clause alongside the query's own filters.
//
// `viewerId`, when given, widens that clause to "my lead scope OR I am this call's agent" - without
// it, a call on a still-unassigned Lead (ownerId/groupId both null - e.g. a new "IVR Inquiry" Lead,
// see callerdesk.store.ts#createIvrLead) would be invisible to the very salesperson who answered it,
// even though Call.agentId already correctly identifies them. This never widens who may see an
// already-owned Lead's calls - only adds back calls the viewer personally handled on an unowned one.
export function buildCallWhere(
  query: Pick<ListCallsQuery, "search" | "status" | "direction" | "dateFrom" | "dateTo" | "agentId" | "virtualNumberId" | "hasRecording">,
  leadScope: Prisma.LeadWhereInput,
  viewerId?: string | null,
): Prisma.CallWhereInput {
  const and: Prisma.CallWhereInput[] = [];

  if (Object.keys(leadScope).length > 0) {
    and.push(viewerId ? { OR: [{ lead: leadScope }, { agentId: viewerId }] } : { lead: leadScope });
  }
  if (query.search) and.push(searchWhere(query.search));
  if (query.status) and.push({ status: query.status });
  if (query.direction) and.push({ direction: query.direction });
  // createdAt, not startedAt: startedAt is null for a call that never actually started (e.g. a
  // provider rejection before dialling), and those should still be found by their creation date.
  if (query.dateFrom || query.dateTo) and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  // IVR reporting filters - additive, never change the plain Call History page's existing behaviour
  // when left unset.
  if (query.agentId) and.push({ agentId: query.agentId });
  if (query.virtualNumberId) and.push({ virtualNumberId: query.virtualNumberId });
  if (query.hasRecording !== undefined) and.push({ recording: query.hasRecording ? { isNot: null } : { is: null } });

  return and.length > 0 ? { AND: and } : {};
}

/** Builds the IVR summary cards' numbers from one `call.groupBy({by:["status"]})` result - the same
 * shape as abandonment.filters.ts#buildAbandonmentSummary, just generic over whatever CallStatus
 * values actually occurred (no bucket/label decisions made here - that's a frontend concern, since
 * CallerDesk's own "Abandonedcall" collapses into our NO_ANSWER status and inventing a separate
 * count here would not be real data - see telephony README's status mapping table). */
export function buildCallSummary(
  counts: { status: CallStatus; _count: { _all: number } }[],
  totalTalkTimeSeconds: number | null,
): CallSummary {
  const byStatus: CallStatusCount[] = counts.map((row) => ({ status: row.status, count: row._count._all }));
  const total = byStatus.reduce((sum, row) => sum + row.count, 0);
  return { total, byStatus, totalTalkTimeSeconds: totalTalkTimeSeconds ?? 0 };
}

// One call, but only if the user's lead scope (or, with viewerId, their own agent assignment -
// see buildCallWhere above) allows it. Mirrors orders.filters.ts#scopedOrderWhere so a call id that
// exists but is out of scope looks the same as a missing one - no existence leak.
export function scopedCallWhere(id: string, leadScope: Prisma.LeadWhereInput, viewerId?: string | null): Prisma.CallWhereInput {
  if (Object.keys(leadScope).length === 0) return { id };
  return { AND: [{ id }, viewerId ? { OR: [{ lead: leadScope }, { agentId: viewerId }] } : { lead: leadScope }] };
}
