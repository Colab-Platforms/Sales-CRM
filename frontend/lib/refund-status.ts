import type { RefundExecutionStatus, RefundRequestStatus, RefundRequestView } from "./api-client/types/refunds.types";

// Wording that keeps APPROVAL and an actual REFUND apart: nothing in this workflow returns money, so nothing here says "refunded".
export const REFUND_STATUS_LABELS: Record<RefundRequestStatus, string> = {
  PENDING: "Pending approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export const REFUND_STATUS_NOTE: Record<RefundRequestStatus, string> = {
  PENDING: "Waiting for a manager or admin to review it.",
  APPROVED: "Approved — refund has not been issued yet.",
  REJECTED: "Rejected — no refund will be issued.",
};

export const REFUND_STATUS_STYLES: Record<RefundRequestStatus, string> = {
  PENDING: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  APPROVED: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  REJECTED: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

export const APPROVAL_DISCLAIMER = "Approval authorizes the refund. The payment provider refund is executed separately.";

export const REASON_MAX = 1000;

const toCents = (text: string): number | null => {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
};

export interface RefundFormErrors {
  amount?: string;
  reason?: string;
}

/**
 * Early feedback only. The SERVER recomputes the refundable balance from the database and is the only authority: this never decides
 * what may be refunded, it just saves a round trip for obvious mistakes.
 */
export function validateRefundForm(amountText: string, reasonText: string, refundableAmount: string): RefundFormErrors {
  const errors: RefundFormErrors = {};
  const cents = toCents(amountText);
  const max = toCents(refundableAmount) ?? 0;
  if (amountText.trim() === "") errors.amount = "Enter the refund amount.";
  else if (cents === null) errors.amount = "Enter a valid amount (up to 2 decimals).";
  else if (cents <= 0) errors.amount = "The refund amount must be greater than 0.";
  else if (cents > max) errors.amount = `At most ${refundableAmount} can still be refunded on this payment.`;
  const reason = reasonText.trim();
  if (!reason) errors.reason = "A reason is required.";
  else if (reason.length > REASON_MAX) errors.reason = `The reason must be at most ${REASON_MAX} characters.`;
  return errors;
}

export const canRequestRefund = (role: string | undefined): boolean => role === "SALESPERSON" || role === "MANAGER" || role === "ADMIN";
export const isApprover = (role: string | undefined): boolean => role === "MANAGER" || role === "ADMIN";

/** Approve / Reject are offered only to a MANAGER or ADMIN, on a PENDING request they did not raise themselves. (The server enforces all three.) */
export function canDecide(role: string | undefined, userId: string | undefined, request: Pick<RefundRequestView, "status" | "requestedBy">): boolean {
  return isApprover(role) && request.status === "PENDING" && !!userId && request.requestedBy.id !== userId;
}

type StateInput = { status: RefundRequestStatus; executionStatus?: RefundExecutionStatus | null; failureReason?: string | null };

/**
 * What to show for a request. The approval decision and the provider execution are separate: APPROVED alone is "refund has not been issued yet",
 * PROCESSING is "Refund processing", and only a COMPLETED execution (confirmed by Cashfree) is "Refund completed".
 */
export function refundDisplay(r: StateInput): { label: string; note: string; style: string } {
  if (r.status === "APPROVED") {
    switch (r.executionStatus ?? null) {
      case "PROCESSING":
        return { label: "Refund processing", note: "Sent to Cashfree — waiting for Cashfree to confirm. Not refunded yet.", style: REFUND_STATUS_STYLES.PENDING };
      case "COMPLETED":
        return { label: "Refund completed", note: "Cashfree confirmed the refund.", style: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" };
      case "FAILED":
        return { label: "Refund failed", note: `The refund was not issued${r.failureReason ? `: ${r.failureReason}` : ""}. It can be retried.`, style: REFUND_STATUS_STYLES.REJECTED };
      default:
        break;
    }
  }
  return { label: REFUND_STATUS_LABELS[r.status], note: REFUND_STATUS_NOTE[r.status], style: REFUND_STATUS_STYLES[r.status] };
}

/** Execute Refund: an approver, on an approved request that is not started / failed, never the requester's own. (The server enforces all of it.) */
export function canExecute(role: string | undefined, userId: string | undefined, r: Pick<RefundRequestView, "status" | "requestedBy"> & { executionStatus?: RefundExecutionStatus | null; orderStatus?: string | null }): boolean {
  const state = r.executionStatus ?? null;
  // A refund is only executed for a CANCELLED order (the server enforces it too).
  return isApprover(role) && r.status === "APPROVED" && (state === null || state === "FAILED") && !!userId && r.requestedBy.id !== userId && r.orderStatus === "CANCELLED";
}

/** Approving a refund CANCELS its order (unless it is already cancelled): the manager must see and accept that. */
export const approvalCancelsOrder = (r: { orderStatus?: string | null }): boolean => !!r.orderStatus && r.orderStatus !== "CANCELLED";

/** The wording of the manager's approval, in one place (the dialog and the queue button use it). */
export function approvalCopy(r: { orderStatus?: string | null; orderNumber?: string }): { button: string; title: string; warning: string; confirm: string } {
  if (approvalCancelsOrder(r)) {
    return {
      button: "Approve & Cancel Order",
      title: "Approve refund and cancel the order?",
      warning: `Approving this refund will CANCEL order ${r.orderNumber ?? ""}. If the order can not be cancelled, the refund is not approved. The customer is not refunded until an admin executes the refund.`.replace("order  ", "the order "),
      confirm: "Approve & Cancel Order",
    };
  }
  return { button: "Approve", title: "Approve refund request?", warning: "The order is already cancelled. Approving does not refund the customer now; the refund is executed separately.", confirm: "Confirm approval" };
}

/** Check refund status: an approver, while the refund is processing. */
export const canRefreshExecution = (role: string | undefined, r: Pick<RefundRequestView, "status"> & { executionStatus?: RefundExecutionStatus | null }): boolean => isApprover(role) && r.status === "APPROVED" && r.executionStatus === "PROCESSING";
