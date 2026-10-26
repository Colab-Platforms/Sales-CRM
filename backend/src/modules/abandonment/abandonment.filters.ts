import { AbandonmentStatus, Role } from "../../../generated/prisma/enums.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import { fullName } from "../orders/orders.filters.js";
import { dayBounds, todayString } from "../attendance/attendance.calc.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { bucketToday } from "@/lib/leadBucket.js";
import { abandonmentItemsWhere, readSnapshotItems } from "./abandonment.items.js";
import type { AbandonmentCallItem, CallAttemptBreakdown, AbandonmentDateRange, AbandonmentListItem, AbandonmentSummary, CartSnapshot, ListAbandonmentsQuery } from "./abandonment.types.js";

// Where-building, row-mapping and summary logic for the abandoned-leads queue. Kept separate from
// abandonment.service.ts the same way orders.filters.ts / shiprocket.list.filters.ts are kept
// separate from their services.

const MAX_SEARCH_TERMS = 5;

/**
 * Whose abandoned checkouts a user may see: the SAME assignment-based rule as a normal lead (a manager sees the ones assigned to them, a salesperson the ones they own), ADMIN and HR everything
 * (HR for lead distribution only - see ABANDONMENT_WORK_ROLES), and a role this module does not know, nothing. Shared by the queue/detail and by "View Customer Details" on an order, so the
 * two can never disagree about who may open a customer's abandoned lead.
 */
export function abandonmentLeadScope(user: { id: string; role: Role }): Prisma.LeadWhereInput {
  if (user.role === Role.MANAGER) return { assignedManagerId: user.id };
  if (user.role === Role.SALESPERSON) return { ownerId: user.id };
  if (user.role === Role.ADMIN || user.role === Role.HR) return {};
  return { id: { in: [] } };
}

/** Who may OPEN (not just list) an abandoned lead: HR distributes them but never works one. */
export const ABANDONMENT_WORK_ROLES: Role[] = [Role.ADMIN, Role.MANAGER, Role.SALESPERSON];


/** Every whitespace-separated term must match at least one of the fields `fields` lists for it. */
function abandonmentTermsWhere(text: string, fields: (contains: { contains: string; mode: "insensitive" }) => Prisma.AbandonmentWhereInput[]): Prisma.AbandonmentWhereInput {
  const terms = text.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  return { AND: terms.map((term): Prisma.AbandonmentWhereInput => ({ OR: fields({ contains: term, mode: "insensitive" }) })) };
}

/**
 * Filters that cannot be expressed as a Prisma where: the cart value (a decimal STRING inside the cartSnapshot JSON) and the type of the LATEST recovery action.
 * Returns the matching ids as a where (null when neither filter is set), to be ANDed with buildAbandonmentListWhere - so they apply to the whole result set, never to the loaded page.
 * The query is narrowed by the same detected-at bounds as the list so it stays small; the lead scope is applied by the list where it is ANDed with.
 */
export async function abandonmentDerivedWhere(db: DbClient, query: ListAbandonmentsQuery, now: Date = new Date()): Promise<Prisma.AbandonmentWhereInput | null> {
  const hasValue = query.valueMin !== undefined || query.valueMax !== undefined;
  if (!hasValue && !query.lastAction) return null;
  const conds: Prisma.Sql[] = [];
  if (hasValue) {
    // A cart value that is not a plain decimal is never matched (and never cast, so a malformed one cannot fail the query).
    const value = Prisma.sql`(CASE WHEN a.cart_snapshot->>'cartValue' ~ '^[0-9]+([.][0-9]+)?$' THEN (a.cart_snapshot->>'cartValue')::numeric END)`;
    if (query.valueMin !== undefined) conds.push(Prisma.sql`${value} >= ${query.valueMin}`);
    if (query.valueMax !== undefined) conds.push(Prisma.sql`${value} <= ${query.valueMax}`);
  }
  if (query.lastAction) {
    const latest = Prisma.sql`(SELECT r.type::text FROM recovery_actions r WHERE r.abandonment_id = a.id ORDER BY r.created_at DESC LIMIT 1)`;
    conds.push(query.lastAction === "NONE" ? Prisma.sql`${latest} IS NULL` : Prisma.sql`${latest} = ${query.lastAction}`);
  }
  const day = abandonmentDateRangeBounds(query.dateRange, now);
  if (day) conds.push(Prisma.sql`a.detected_at >= ${day.gte} AND a.detected_at < ${day.lt}`);
  if (query.dateFrom) conds.push(Prisma.sql`a.detected_at >= ${query.dateFrom}`);
  if (query.dateTo) conds.push(Prisma.sql`a.detected_at <= ${query.dateTo}`);
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT a.id FROM abandonments a WHERE ${Prisma.join(conds, " AND ")}`);
  return { id: { in: rows.map((r) => r.id) } };
}

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

/**
 * The half-open instant range [gte, lt) of a day filter, as UTC instants. A "day" is a calendar day in the reporting timezone (REPORT_TZ_OFFSET_MINUTES = IST, the same
 * convention attendance and the manager reports use), so "today" starts at 00:00 IST and ends at the next 00:00 IST - never at the server's or the browser's own midnight.
 * `all` (or no filter) is no restriction at all.
 */
export function abandonmentDateRangeBounds(range: AbandonmentDateRange | undefined, now: Date = new Date(), tzOffsetMinutes: number = REPORT_TZ_OFFSET_MINUTES): { gte: Date; lt: Date } | null {
  if (!range || range === "all") return null;
  const today = dayBounds(todayString(now, tzOffsetMinutes), tzOffsetMinutes);
  if (range === "today") return { gte: today.from, lt: today.to };
  const yesterday = dayBounds(todayString(new Date(today.from.getTime() - 1), tzOffsetMinutes), tzOffsetMinutes);
  return { gte: yesterday.from, lt: today.from };
}

export function buildAbandonmentListWhere(query: ListAbandonmentsQuery, leadScope: Prisma.LeadWhereInput, role: Role, now: Date = new Date()): Prisma.AbandonmentWhereInput {
  const and: Prisma.AbandonmentWhereInput[] = [];
  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.search) and.push(abandonmentSearchWhere(query.search));
  if (query.status) and.push({ status: query.status });
  if (query.type) and.push({ type: query.type });
  if (query.dateFrom || query.dateTo) and.push({ detectedAt: { gte: query.dateFrom, lte: query.dateTo } });
  // By when the checkout was ABANDONED (detectedAt - the delivery's own time), never by updatedAt, which assignments and repeat deliveries also move.
  const day = abandonmentDateRangeBounds(query.dateRange, now);
  if (day) and.push({ detectedAt: { gte: day.gte, lt: day.lt } });
  if (query.assignment === "UNASSIGNED") and.push({ lead: { assignedManagerId: null } });
  else if (query.assignment === "ASSIGNED_TO_MANAGER") and.push({ lead: { assignedManagerId: { not: null }, ownerId: null } });
  else if (query.assignment === "ASSIGNED_TO_SALESPERSON") and.push({ lead: { ownerId: { not: null } } });
  else if (query.assignment === "UNASSIGNED_TELECALLER") and.push({ lead: { ownerId: null } });
  if (query.managerId) and.push({ lead: { assignedManagerId: query.managerId } });
  if (query.salespersonId) and.push({ lead: { ownerId: query.salespersonId } });
  if (query.bucket === "TODAY") and.push({ lead: { bucketDate: bucketToday(now), bucketDoneAt: null } });
  if (query.items && query.items.length > 0) and.push(abandonmentItemsWhere(query.items));
  // Column filters. Each term is "contains", case-insensitive, and every filter ANDs with all the others.
  if (query.lead) and.push(abandonmentTermsWhere(query.lead, (contains) => [{ lead: { firstName: contains } }, { lead: { lastName: contains } }, { lead: { leadNumber: contains } }]));
  if (query.contact) and.push(abandonmentTermsWhere(query.contact, (contains) => [{ lead: { mobile: contains } }, { lead: { email: contains } }]));
  if (query.assignee) and.push(abandonmentTermsWhere(query.assignee, (contains) => [{ lead: { owner: { name: contains } } }, { lead: { assignedManager: { name: contains } } }]));
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
    calls: AbandonmentCallItem[];
    _count?: { calls: number };
    tasks: { id: string; type: string; scheduledAt: Date | null }[];
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
    items: readSnapshotItems(v.items),
    stage: typeof v.stage === "string" ? v.stage : null,
    checkoutUrl: typeof v.checkoutUrl === "string" ? v.checkoutUrl : null,
  };
}

/** What an outbound call attempt came to: reached the customer (successful), did not connect (failed: provider failure, no answer, busy, not reachable) or has not finished yet (ringing / in progress). */
export function classifyCallStatus(status: string): keyof CallAttemptBreakdown {
  if (status === "COMPLETED" || status === "CONNECTED" || status === "AGENT_ANSWERED") return "successful";
  if (status === "INITIATED" || status === "RINGING_AGENT" || status === "RINGING_CUSTOMER") return "ringing";
  return "failed"; // FAILED, NO_ANSWER, BUSY, NOT_REACHABLE
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
      firstName: row.lead.firstName,
      lastName: row.lead.lastName,
      name: fullName(row.lead.firstName, row.lead.lastName),
      mobile: row.lead.mobile,
      email: row.lead.email,
      workingStatus: row.lead.workingStatus,
      assignedManager: row.lead.assignedManager,
      owner: row.lead.owner,
      calls: row.lead.calls,
      callAttempts: row.lead._count?.calls ?? row.lead.calls.filter((c) => c.direction === "OUTBOUND").length,
      tasks: row.lead.tasks,
    },
    source: row.source,
    latestRecoveryAction: latest ? { type: latest.type, status: latest.status, createdAt: latest.createdAt } : null,
  };
}
