import type { ActivitySource, ActivityType, Role } from "../../../generated/prisma/enums.js";

export interface ListAuditQuery {
  page: number;
  pageSize: number;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  type?: ActivityType;
  referenceType?: string;
  actorId?: string;
  orderId?: string;
  leadId?: string;
  source?: ActivitySource;
}

// Minimal paging for the entity-scoped sub-endpoints (/orders/:id/audit, /customers/:leadId/audit),
// which already know which order/customer they mean.
export interface EntityAuditQuery {
  page: number;
  pageSize: number;
}

export interface AuditEntry {
  id: string;
  occurredAt: Date;
  actor: { id: string; name: string } | null;
  actorRole: Role | null;
  type: ActivityType;
  // The entity that actually changed (e.g. "Order", "Payment", "Shipment", "LeadAssignment"); null
  // for events that only ever concerned the lead itself (e.g. LEAD_CREATED, LEAD_UPDATED).
  entityType: string | null;
  entityId: string | null;
  // Null for an E7.2 template event (create/update/status change/sync) - not about any one customer.
  leadId: string | null;
  customer: { leadId: string; leadNumber: string; name: string } | null;
  order: { id: string; orderNumber: string; externalNumber: string | null } | null;
  title: string | null;
  description: string | null;
  oldValue: unknown;
  newValue: unknown;
  metadata: unknown;
  source: ActivitySource;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface AuditListResult {
  items: AuditEntry[];
  pagination: Pagination;
}
