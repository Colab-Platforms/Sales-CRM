import { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";

// Which payments can be refunded THROUGH CASHFREE (the only prepaid provider). This only decides whether a refund REQUEST may be raised; it calls nothing.
//
// A prepaid payment qualifies whether it was created in the CRM (a Cashfree payment link, externalSource CASHFREE) or came from Shopify (a Shopify
// transaction whose gateway is Cashfree). Either way it needs the SAME Cashfree references before anything can be refunded:
//   - Cashfree's order_id         -> metadata.cashfree.cashfreeOrderId
//   - the Cashfree cf_payment_id  -> Payment.providerPaymentId for a CRM payment, metadata.cashfree.cfPaymentId for a Shopify one
//     (a Shopify payment's providerPaymentId is SHOPIFY's payment id such as "#AWL1.1", never a cf_payment_id)
// A Shopify-synced payment starts without them; they are looked up and VERIFIED against Cashfree (see refunds.resolve.ts) before it becomes refundable.
// Other gateways (PhonePe, Shopflo, manual, ...) and COD are never refundable here, and there is no fallback provider.

export interface EligibilityPayment {
  externalSource: string | null;
  status: PaymentStatus;
  providerPaymentId: string | null;
  metadata: unknown;
  /** Gateway name as recorded (Shopify: the transaction's gateway, e.g. "Cashfree"). */
  provider?: string | null;
  method?: PaymentMethod | null;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Cashfree's order id recorded on the payment (Payment.metadata.cashfree.cashfreeOrderId), or null. */
export function cashfreeOrderIdOf(payment: Pick<EligibilityPayment, "metadata">): string | null {
  return nonEmpty(asRecord(asRecord(payment.metadata).cashfree).cashfreeOrderId);
}

/** The Cashfree cf_payment_id of the payment, from the right place for where the payment came from; null when not recorded. */
export function cashfreePaymentIdOf(payment: Pick<EligibilityPayment, "externalSource" | "providerPaymentId" | "metadata">): string | null {
  if (payment.externalSource === "CASHFREE") return nonEmpty(payment.providerPaymentId);
  return nonEmpty(asRecord(asRecord(payment.metadata).cashfree).cfPaymentId);
}

/** Shopify's own refundable amount for the order, as last read from Shopify (Order.metadata.shopifyRefundable), or null when it was never read / is malformed. */
export function shopifyRefundableOf(orderMetadata: unknown): { amount: string; currency: string } | null {
  const snapshot = asRecord(asRecord(orderMetadata).shopifyRefundable);
  const amount = nonEmpty(snapshot.amount);
  const currency = nonEmpty(snapshot.currency);
  return amount && currency && /^\d+(\.\d{1,2})?$/.test(amount) ? { amount, currency } : null;
}

/** The outcome of the last automatic Cashfree verification recorded on a Shopify payment (Payment.metadata.cashfreeVerification), if any. */
export function cashfreeVerificationOf(metadata: unknown): { status: "FAILED" | "VERIFIED"; reason: string | null; checkedAt: string | null } | null {
  const v = asRecord(asRecord(metadata).cashfreeVerification);
  return v.status === "FAILED" || v.status === "VERIFIED" ? { status: v.status, reason: nonEmpty(v.reason), checkedAt: nonEmpty(v.checkedAt) } : null;
}

/** Why a Shopify Cashfree payment without verified references is not refundable: the recorded failure, or that verification has not run yet. */
export function shopifyUnverifiedReason(metadata: unknown): string {
  const v = cashfreeVerificationOf(metadata);
  if (v?.status === "FAILED") return `Cashfree verification failed: ${(v.reason ?? "the payment could not be matched at Cashfree").replace(/[.\s]+$/, "")}.`;
  return "The Cashfree payment of this Shopify order has not been verified yet, so it cannot be refunded here.";
}

/** A prepaid payment collected through Cashfree: a CRM Cashfree link, or a Shopify transaction whose gateway is Cashfree (and not marked COD). */
export function isCashfreePayment(payment: Pick<EligibilityPayment, "externalSource" | "provider" | "method">): boolean {
  if (payment.method === PaymentMethod.COD) return false;
  if (payment.externalSource === "CASHFREE") return true;
  return payment.externalSource === "SHOPIFY" && /cashfree/i.test(payment.provider ?? "");
}

export const NOT_CASHFREE_REASON = "This payment was not collected through Cashfree, so a refund cannot be requested for it here.";
export const COD_REASON = "This is a cash-on-delivery payment, which is not refunded through Cashfree.";

/** A Shopify-synced Cashfree payment whose Cashfree references are not recorded yet: they can be looked up and verified. */
export function canResolveCashfreeIds(payment: EligibilityPayment): boolean {
  return (
    payment.externalSource === "SHOPIFY" &&
    isCashfreePayment(payment) &&
    (payment.status === PaymentStatus.SUCCESS || payment.status === PaymentStatus.PARTIALLY_REFUNDED) &&
    (!cashfreeOrderIdOf(payment) || !cashfreePaymentIdOf(payment))
  );
}

/**
 * Whether a payment was retired by a COD -> Prepaid upgrade (its row is kept for history; the successful prepaid payment replaced it). It is not a refund candidate and
 * is not listed with the refundable payments.
 */
export function isSupersededPayment(metadata: unknown): boolean {
  return Object.keys(asRecord(asRecord(metadata).retiredByPrepaidUpgrade)).length > 0;
}

/*
 * THE refund eligibility rule (see refundIneligibleReason below): a refund can be requested for an eligible PAID PREPAID CASHFREE payment - successful (or partly refunded),
 * its Cashfree references verified, not COD, not fully refunded - while a refundable amount remains. The ORDER'S STATUS is not part of it: an active order is refundable, and
 * the manager's approval of the refund is what cancels the order (see RefundsService.approve).
 */
export function refundIneligibleReason(payment: EligibilityPayment): string | null {
  if (payment.method === PaymentMethod.COD) return COD_REASON;
  if (!isCashfreePayment(payment)) return NOT_CASHFREE_REASON;
  if (payment.status === PaymentStatus.REFUNDED) return "This payment has already been fully refunded.";
  if (payment.status !== PaymentStatus.SUCCESS && payment.status !== PaymentStatus.PARTIALLY_REFUNDED) {
    return `Only a successful payment can be refunded (this payment is ${payment.status.toLowerCase().replace("_", " ")}).`;
  }
  if (!cashfreePaymentIdOf(payment) || !cashfreeOrderIdOf(payment)) {
    return payment.externalSource === "SHOPIFY"
      ? shopifyUnverifiedReason(payment.metadata)
      : !cashfreePaymentIdOf(payment)
        ? "The Cashfree payment id is not recorded for this payment, so it cannot be refunded."
        : "The Cashfree order reference is not recorded for this payment, so it cannot be refunded.";
  }
  return null;
}
