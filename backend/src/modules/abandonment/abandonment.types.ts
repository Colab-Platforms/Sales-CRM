import type { AbandonmentStatus, AbandonmentType, CallDirection, CallStatus, LeadWorkingStatus, RecoveryActionStatus, RecoveryActionType } from "../../../generated/prisma/enums.js";
import type { Pagination } from "../orders/orders.types.js";

// Abandoned-checkout queue ("/dashboard/abandoned-leads"). Reads the Abandonment/RecoveryAction tables
// E6's Customer 360 timeline already renders (customers.timeline.ts) - this is the first module that
// writes and lists them directly, rather than only rendering them inside one lead's history.

export type AbandonmentAssignmentFilter = "UNASSIGNED" | "ASSIGNED_TO_MANAGER" | "ASSIGNED_TO_SALESPERSON";

export interface ListAbandonmentsQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: AbandonmentStatus;
  type?: AbandonmentType;
  dateFrom?: Date;
  dateTo?: Date;
  assignment?: AbandonmentAssignmentFilter;
  managerId?: string;
  salespersonId?: string;
  /** Filters on the underlying Lead's own pipeline status, same field the Leads page filters on. */
  workingStatus?: LeadWorkingStatus;
}

// Structured cart detail written by the ingesting processor (e.g. shiprocket.abandonment.processor.ts)
// onto Abandonment.cartSnapshot. Null on rows written before that column existed - the UI falls back
// to `summary` (the Activity-recorded text) for those.
export interface CartSnapshot {
  cartValue: string | null;
  currency: string | null;
  itemCount: number | null;
  itemNames: string[];
  stage: string | null;
  checkoutUrl: string | null;
}

// Same shape frontend's Call type (calling.types.ts) expects - lets the abandoned-leads queue and lead
// detail page reuse the exact same calling/history UI components normal leads already have.
export interface AbandonmentCallItem {
  id: string;
  provider: string;
  direction: CallDirection;
  status: CallStatus;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  recording: { recordingUrl: string | null } | null;
  agent: { id: string; name: string } | null;
  notes: string | null;
  outcome: { id: string; name: string; code: string } | null;
}

export interface AbandonmentListItem {
  id: string;
  type: AbandonmentType;
  status: AbandonmentStatus;
  detectedAt: Date;
  recoveredAt: Date | null;
  priorityScore: string | null;
  priorityReason: string | null;
  /** Legacy free-text fallback (from the Activity row) for abandonments recorded before cartSnapshot existed. */
  summary: string | null;
  cartSnapshot: CartSnapshot | null;
  lead: {
    id: string;
    leadNumber: string;
    firstName: string;
    lastName: string | null;
    name: string;
    mobile: string | null;
    email: string | null;
    /** The lead's own pipeline status (NEW/ASSIGNED/.../CONVERTED) - separate from this abandonment's
     *  cart-recovery status above. A salesperson never sees ASSIGNED here either, same as the Leads page. */
    workingStatus: LeadWorkingStatus;
    assignedManager: { id: string; name: string } | null;
    owner: { id: string; name: string } | null;
    calls: AbandonmentCallItem[];
    /** This lead's pending call back / follow up reminder, if any - same shape leadListInclude.tasks
     *  gives the Leads page, so the call-outcome form here can pre-fill/replace it identically. */
    tasks: { id: string; type: string; scheduledAt: Date | null }[];
  };
  source: { id: string; name: string } | null;
  latestRecoveryAction: { type: RecoveryActionType; status: RecoveryActionStatus; createdAt: Date } | null;
}

export interface AbandonmentSummary {
  total: number;
  active: number;
  inProgress: number;
  recovered: number;
  notRecovered: number;
  expired: number;
}

export interface AbandonmentListResult {
  items: AbandonmentListItem[];
  summary: AbandonmentSummary;
  pagination: Pagination;
}

export interface RecoveryActionItem {
  id: string;
  type: RecoveryActionType;
  status: RecoveryActionStatus;
  notes: string | null;
  createdAt: Date;
  completedAt: Date | null;
  performedBy: { id: string; name: string } | null;
}

export interface AbandonmentDetail extends AbandonmentListItem {
  reference: { referenceType: string | null; referenceId: string | null };
  recoveryActions: RecoveryActionItem[];
}

export interface CreateRecoveryActionBody {
  type: RecoveryActionType;
  status?: RecoveryActionStatus;
  notes?: string;
}

export interface UpdateAbandonmentStatusBody {
  status: AbandonmentStatus;
}

export interface BulkAssignManagerBody {
  abandonmentIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  managerId?: string;
  managerIds?: string[];
}

export interface BulkAssignSalespersonBody {
  abandonmentIds: string[];
  method: "MANUAL" | "ROUND_ROBIN";
  salespersonId?: string;
  salespersonIds?: string[];
}
