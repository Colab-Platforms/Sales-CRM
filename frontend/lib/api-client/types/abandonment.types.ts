import type { Pagination } from "./orders.types";
import type { LeadWorkingStatus } from "./dashboard.types";

// The abandoned-leads queue ("/dashboard/abandoned-leads"), fed by Shiprocket Checkout's "Abandon
// Cart" webhook. Mirrors shiprocket.types.ts's shape (list item + summary + pagination) since it is
// the same kind of centralized operational queue as the Shiprocket shipments page.

export type AbandonmentType = "CHECKOUT" | "PAYMENT" | "SALES";
export type AbandonmentStatus = "ACTIVE" | "IN_PROGRESS" | "RECOVERED" | "NOT_RECOVERED" | "EXPIRED";
export type RecoveryActionType = "CALL" | "CALLBACK" | "CONTINUE_ORDER";
export type RecoveryActionStatus = "PENDING" | "IN_PROGRESS" | "SUCCESS" | "FAILED";

export type AbandonmentAssignmentFilter = "UNASSIGNED" | "ASSIGNED_TO_MANAGER" | "ASSIGNED_TO_SALESPERSON";

export interface ListAbandonmentsParams {
  page: number;
  pageSize: number;
  search?: string;
  status?: AbandonmentStatus;
  type?: AbandonmentType;
  dateFrom?: string;
  dateTo?: string;
  assignment?: AbandonmentAssignmentFilter;
  managerId?: string;
  salespersonId?: string;
  workingStatus?: LeadWorkingStatus;
}

export interface AbandonmentSummary {
  total: number;
  active: number;
  inProgress: number;
  recovered: number;
  notRecovered: number;
  expired: number;
}

// Structured cart detail (value, items, checkout stage, resume link), as reported by the source at
// detection time. Null on abandonments recorded before this existed - the UI falls back to `summary`.
export interface CartSnapshot {
  cartValue: string | null;
  currency: string | null;
  itemCount: number | null;
  itemNames: string[];
  stage: string | null;
  checkoutUrl: string | null;
}

export interface AbandonmentListItem {
  id: string;
  type: AbandonmentType;
  status: AbandonmentStatus;
  detectedAt: string;
  recoveredAt: string | null;
  priorityScore: string | null;
  priorityReason: string | null;
  /** Legacy free-text fallback for abandonments recorded before cartSnapshot existed. */
  summary: string | null;
  cartSnapshot: CartSnapshot | null;
  lead: {
    id: string;
    leadNumber: string;
    name: string;
    mobile: string | null;
    email: string | null;
    /** The lead's own pipeline status - separate from this abandonment's cart-recovery `status` above. */
    workingStatus: LeadWorkingStatus;
    assignedManager: { id: string; name: string } | null;
    owner: { id: string; name: string } | null;
  };
  source: { id: string; name: string } | null;
  latestRecoveryAction: { type: RecoveryActionType; status: RecoveryActionStatus; createdAt: string } | null;
}

export interface ListAbandonmentsResult {
  items: AbandonmentListItem[];
  summary: AbandonmentSummary;
  pagination: Pagination;
}

export interface RecoveryActionItem {
  id: string;
  type: RecoveryActionType;
  status: RecoveryActionStatus;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  performedBy: { id: string; name: string } | null;
}

export interface AbandonmentDetail extends AbandonmentListItem {
  reference: { referenceType: string | null; referenceId: string | null };
  recoveryActions: RecoveryActionItem[];
}

export interface CreateRecoveryActionInput {
  type: RecoveryActionType;
  status?: RecoveryActionStatus;
  notes?: string;
}

export interface BulkAssignManagerPayload {
  abandonmentIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  managerId?: string;
  managerIds?: string[];
}

export interface BulkAssignSalespersonPayload {
  abandonmentIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  salespersonId?: string;
  salespersonIds?: string[];
}

// Auto-assignment toggles behind the manual bulk-assign flow above - see
// backend/src/modules/lead/lead.service.ts's autoAssignAbandonedLead. The manager-stage toggle is
// global (admin-controlled); the salesperson-stage toggle is scoped to the logged-in manager's own team.
export interface AutoAssignConfig {
  enabled: boolean;
}
