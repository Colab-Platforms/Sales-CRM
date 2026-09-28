import { AbandonmentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { fullName } from "../orders/orders.filters.js";
import type { AbandonmentListItem, AbandonmentSummary, CartSnapshot, ListAbandonmentsQuery } from "./abandonment.types.js";

// Where-building, row-mapping and summary logic for the abandoned-leads queue. Kept separate from
// abandonment.service.ts the same way orders.filters.ts / shiprocket.list.filters.ts are kept
// separate from their services.

const MAX_SEARCH_TERMS = 5;

export function abandonmentSearchWhere(search: string): Prisma.AbandonmentWhereInput {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  return {
    AND: terms.map((term): Prisma.AbandonmentWhereInput => {
      const contains = { contains: term, mode: "insensitive" as const };
      return {
        OR: [
          { lead: { firstName: contains } },
          { lead: { lastName: contains } },
          { lead: { mobile: contains } },
          { lead: { email: contains } },
          { lead: { leadNumber: contains } },
        ],
      };
    }),
  };
}

export function buildAbandonmentListWhere(query: ListAbandonmentsQuery, leadScope: Prisma.LeadWhereInput, role: Role): Prisma.AbandonmentWhereInput {
  const and: Prisma.AbandonmentWhereInput[] = [];
  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.search) and.push(abandonmentSearchWhere(query.search));
  if (query.status) and.push({ status: query.status });
  if (query.type) and.push({ type: query.type });
  if (query.dateFrom || query.dateTo) and.push({ detectedAt: { gte: query.dateFrom, lte: query.dateTo } });
  if (query.assignment === "UNASSIGNED") and.push({ lead: { assignedManagerId: null } });
  else if (query.assignment === "ASSIGNED_TO_MANAGER") and.push({ lead: { assignedManagerId: { not: null }, ownerId: null } });
  else if (query.assignment === "ASSIGNED_TO_SALESPERSON") and.push({ lead: { ownerId: { not: null } } });
  if (query.managerId) and.push({ lead: { assignedManagerId: query.managerId } });
  if (query.salespersonId) and.push({ lead: { ownerId: query.salespersonId } });
  if (query.workingStatus) {
    // A salesperson's "NEW" filter includes leads that are ASSIGNED underneath (they never see ASSIGNED
    // itself) - same rule lead.service.ts's listLeads applies.
    const includesAssigned = role === Role.SALESPERSON && (query.workingStatus === "NEW" || query.workingStatus === "ASSIGNED");
    and.push({ lead: { workingStatus: includesAssigned ? { in: ["NEW", "ASSIGNED"] } : query.workingStatus } });
  }
  return and.length > 0 ? { AND: and } : {};
}

/** One abandonment, but only if it is inside the user's lead scope. */
export function scopedAbandonmentWhere(id: string, leadScope: Prisma.LeadWhereInput): Prisma.AbandonmentWhereInput {
  const and: Prisma.AbandonmentWhereInput[] = [{ id }];
  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  return { AND: and };
}

export function buildAbandonmentSummary(counts: { status: AbandonmentStatus; _count: { _all: number } }[]): AbandonmentSummary {
  const summary: AbandonmentSummary = { total: 0, active: 0, inProgress: 0, recovered: 0, notRecovered: 0, expired: 0 };
  for (const row of counts) {
    const n = row._count._all;
    summary.total += n;
    if (row.status === AbandonmentStatus.ACTIVE) summary.active += n;
    else if (row.status === AbandonmentStatus.IN_PROGRESS) summary.inProgress += n;
    else if (row.status === AbandonmentStatus.RECOVERED) summary.recovered += n;
    else if (row.status === AbandonmentStatus.NOT_RECOVERED) summary.notRecovered += n;
    else if (row.status === AbandonmentStatus.EXPIRED) summary.expired += n;
  }
  return summary;
}

export interface AbandonmentListRow {
  id: string;
  type: import("../../../generated/prisma/enums.js").AbandonmentType;
  status: AbandonmentStatus;
  detectedAt: Date;
  recoveredAt: Date | null;
  priorityScore: { toString(): string } | null;
  priorityReason: string | null;
  cartSnapshot: unknown;
  lead: {
    id: string;
    leadNumber: string;
    firstName: string;
    lastName: string | null;
    mobile: string | null;
    email: string | null;
    workingStatus: import("../../../generated/prisma/enums.js").LeadWorkingStatus;
    assignedManager: { id: string; name: string } | null;
    owner: { id: string; name: string } | null;
  };
  source: { id: string; name: string } | null;
  recoveryActions: { type: import("../../../generated/prisma/enums.js").RecoveryActionType; status: import("../../../generated/prisma/enums.js").RecoveryActionStatus; createdAt: Date }[];
}

/** Defensive read of the JSON column - only ever written by buildCartSnapshot (shiprocket.abandonment.processor.ts),
 *  but validated on the way out rather than trusted, same as any other JSON column in this codebase. */
function asCartSnapshot(value: unknown): CartSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    cartValue: typeof v.cartValue === "string" ? v.cartValue : null,
    currency: typeof v.currency === "string" ? v.currency : null,
    itemCount: typeof v.itemCount === "number" ? v.itemCount : null,
    itemNames: Array.isArray(v.itemNames) ? v.itemNames.filter((n): n is string => typeof n === "string") : [],
    stage: typeof v.stage === "string" ? v.stage : null,
    checkoutUrl: typeof v.checkoutUrl === "string" ? v.checkoutUrl : null,
  };
}

export function mapAbandonmentListRow(row: AbandonmentListRow, summary: string | null): AbandonmentListItem {
  const [latest] = row.recoveryActions;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    detectedAt: row.detectedAt,
    recoveredAt: row.recoveredAt,
    priorityScore: row.priorityScore ? row.priorityScore.toString() : null,
    priorityReason: row.priorityReason,
    summary,
    cartSnapshot: asCartSnapshot(row.cartSnapshot),
    lead: {
      id: row.lead.id,
      leadNumber: row.lead.leadNumber,
      name: fullName(row.lead.firstName, row.lead.lastName),
      mobile: row.lead.mobile,
      email: row.lead.email,
      workingStatus: row.lead.workingStatus,
      assignedManager: row.lead.assignedManager,
      owner: row.lead.owner,
    },
    source: row.source,
    latestRecoveryAction: latest ? { type: latest.type, status: latest.status, createdAt: latest.createdAt } : null,
  };
}
