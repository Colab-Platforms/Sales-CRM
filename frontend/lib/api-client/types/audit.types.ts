// Kept in sync with backend/src/modules/audit/audit.types.ts and the ActivityType/ActivitySource enums.
export type ActivityType =
  | "LEAD_CREATED"
  | "LEAD_UPDATED"
  | "ASSIGNMENT"
  | "REASSIGNMENT"
  | "CALL"
  | "NOTE"
  | "STATUS_CHANGE"
  | "INTERESTED"
  | "INTERESTED_EXPIRED"
  | "ORDER_CREATED"
  | "ORDER_CONFIRMED"
  | "PAYMENT"
  | "ABANDONMENT"
  | "RECOVERY"
  | "TASK"
  | "ORDER_STATUS_CHANGED"
  | "ORDER_CANCELLED"
  | "PAYMENT_CREATED"
  | "PAYMENT_STATUS_CHANGED"
  | "PAYMENT_REFUNDED"
  | "PAYMENT_MISMATCH_DETECTED"
  | "SHIPMENT_CREATED"
  | "SHIPMENT_STATUS_CHANGED"
  | "TRACKING_UPDATED"
  | "DISCOUNT_CHANGED";

export type ActivitySource = "USER" | "SHOPIFY_SYNC" | "SHOPIFY_WEBHOOK" | "SYSTEM";

export type AuditRole = "ADMIN" | "MANAGER" | "SALESPERSON";

export interface AuditListParams {
  page: number;
  pageSize: number;
  search?: string;
  // ISO date-times
  dateFrom?: string;
  dateTo?: string;
  type?: ActivityType;
  referenceType?: string;
  actorId?: string;
  orderId?: string;
  leadId?: string;
  source?: ActivitySource;
}

export interface EntityAuditParams {
  page: number;
  pageSize: number;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actor: { id: string; name: string } | null;
  actorRole: AuditRole | null;
  type: ActivityType;
  entityType: string | null;
  entityId: string | null;
  leadId: string;
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
