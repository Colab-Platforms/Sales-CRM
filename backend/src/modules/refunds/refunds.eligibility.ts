import { PaymentStatus } from "../../../generated/prisma/enums.js";

// Which payments can be refunded THROUGH CASHFREE later. This only decides whether a refund REQUEST may be raised; it calls nothing.
// Shopify-collected, COD and any other non-Cashfree payment is never refundable through this workflow, and there is no fallback provider.

export interface EligibilityPayment {
  externalSource: string | null;
  status: PaymentStatus;
  providerPaymentId: string | null;
  metadata: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The Cashfree order id recorded on the payment (Payment.metadata.cashfree.cashfreeOrderId), or null. */
export function cashfreeOrderIdOf(payment: Pick<EligibilityPayment, "metadata">): string | null {
  const id = asRecord(asRecord(payment.metadata).cashfree).cashfreeOrderId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

export const NOT_CASHFREE_REASON = "This payment was not collected through Cashfree, so a refund cannot be requested for it here.";

export function refundIneligibleReason(payment: EligibilityPayment): string | null {
  if (payment.externalSource !== "CASHFREE") return NOT_CASHFREE_REASON;
  if (payment.status !== PaymentStatus.SUCCESS && payment.status !== PaymentStatus.PARTIALLY_REFUNDED) {
    return `Only a successful payment can be refunded (this payment is ${payment.status.toLowerCase().replace("_", " ")}).`;
  }
  if (!payment.providerPaymentId || payment.providerPaymentId.trim() === "") return "The Cashfree payment id is not recorded for this payment, so it cannot be refunded.";
  if (!cashfreeOrderIdOf(payment)) return "The Cashfree order reference is not recorded for this payment, so it cannot be refunded.";
  return null;
}
