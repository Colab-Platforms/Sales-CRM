import type { Prisma } from "../../../generated/prisma/client.js";
import type { ListCallsQuery } from "./call.history.types.js";

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
export function buildCallWhere(
  query: Pick<ListCallsQuery, "search" | "status" | "direction" | "dateFrom" | "dateTo">,
  leadScope: Prisma.LeadWhereInput,
): Prisma.CallWhereInput {
  const and: Prisma.CallWhereInput[] = [];

  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.search) and.push(searchWhere(query.search));
  if (query.status) and.push({ status: query.status });
  if (query.direction) and.push({ direction: query.direction });
  // createdAt, not startedAt: startedAt is null for a call that never actually started (e.g. a
  // provider rejection before dialling), and those should still be found by their creation date.
  if (query.dateFrom || query.dateTo) and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });

  return and.length > 0 ? { AND: and } : {};
}

// One call, but only if the user's lead scope allows it. Mirrors orders.filters.ts#scopedOrderWhere
// so a call id that exists but is out of scope looks the same as a missing one - no existence leak.
export function scopedCallWhere(id: string, leadScope: Prisma.LeadWhereInput): Prisma.CallWhereInput {
  return Object.keys(leadScope).length > 0 ? { AND: [{ id }, { lead: leadScope }] } : { id };
}
