import type { RefundRequestStatus, RefundRequestView } from "./api-client/types/refunds.types";

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
