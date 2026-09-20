import type { ActivitySource, ActivityType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { fullName } from "../orders/orders.filters.js";
import { ORDER_REFERENCE_TYPE } from "../orders/orders.types.js";
import type { AuditEntry, ListAuditQuery } from "./audit.types.js";

export function buildAuditWhere(query: ListAuditQuery, leadScope: Prisma.LeadWhereInput): Prisma.ActivityWhereInput {
  const and: Prisma.ActivityWhereInput[] = [];

  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.dateFrom || query.dateTo) and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  if (query.type) and.push({ type: query.type });
  if (query.referenceType) and.push({ referenceType: query.referenceType });
  if (query.actorId) and.push({ actorId: query.actorId });
  // orderId covers rows written since the E6.6 Audit Trail; the OR also catches historical rows
  // (written before that column existed) whose entity IS the order itself.
  if (query.orderId) and.push({ OR: [{ orderId: query.orderId }, { referenceType: ORDER_REFERENCE_TYPE, referenceId: query.orderId }] });
  if (query.leadId) and.push({ leadId: query.leadId });
  if (query.source) and.push({ source: query.source });
  if (query.search) {
    const contains = { contains: query.search, mode: "insensitive" as const };
    and.push({
      OR: [
        { title: contains },
        { description: contains },
        { lead: { firstName: contains } },
        { lead: { lastName: contains } },
        { lead: { leadNumber: contains } },
        { order: { orderNumber: contains } },
        { order: { externalNumber: contains } },
      ],
    });
  }

  return and.length > 0 ? { AND: and } : {};
}

// One order, but only if the user's lead scope allows it - mirrors scopedOrderWhere/scopedLeadWhere.
export function orderAuditWhere(orderId: string): Prisma.ActivityWhereInput {
  return { OR: [{ orderId }, { referenceType: ORDER_REFERENCE_TYPE, referenceId: orderId }] };
}

export interface AuditActivityInput {
  id: string;
  createdAt: Date;
  type: ActivityType;
  referenceType: string | null;
  referenceId: string | null;
  leadId: string;
  title: string | null;
  description: string | null;
  oldValue: Prisma.JsonValue;
  newValue: Prisma.JsonValue;
  metadata: Prisma.JsonValue;
  source: ActivitySource;
  actorRole: Role | null;
  actor: { id: string; name: string } | null;
  lead: { id: string; leadNumber: string; firstName: string; lastName: string | null } | null;
  order: { id: string; orderNumber: string; externalNumber: string | null } | null;
}

export function mapAuditEntry(row: AuditActivityInput): AuditEntry {
  return {
    id: row.id,
    occurredAt: row.createdAt,
    actor: row.actor,
    actorRole: row.actorRole,
    type: row.type,
    entityType: row.referenceType,
    entityId: row.referenceId,
    leadId: row.leadId,
    customer: row.lead ? { leadId: row.lead.id, leadNumber: row.lead.leadNumber, name: fullName(row.lead.firstName, row.lead.lastName) } : null,
    order: row.order,
    title: row.title,
    description: row.description,
    oldValue: row.oldValue,
    newValue: row.newValue,
    metadata: row.metadata,
    source: row.source,
  };
}
