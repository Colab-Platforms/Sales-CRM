import type { AbandonmentStatus, AbandonmentType, RecoveryActionStatus, RecoveryActionType } from "../../../generated/prisma/enums.js";
import type { Pagination } from "../orders/orders.types.js";

// Abandoned-checkout queue ("/dashboard/abandoned-leads"). Reads the Abandonment/RecoveryAction tables
// E6's Customer 360 timeline already renders (customers.timeline.ts) - this is the first module that
// writes and lists them directly, rather than only rendering them inside one lead's history.

export interface ListAbandonmentsQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: AbandonmentStatus;
  type?: AbandonmentType;
  dateFrom?: Date;
  dateTo?: Date;
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
  lead: { id: string; leadNumber: string; name: string; mobile: string | null; email: string | null };
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
