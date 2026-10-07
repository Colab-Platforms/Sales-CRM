import { toCents } from "../shopify/shopify.money.js";
import { getRefundablePaymentAmount, type RefundablePaymentAmount } from "../orders/orders.filters.js";
import { shopifyRefundableOf } from "./refunds.eligibility.js";

// What a NEW refund request may still ask for on one payment.
//
// For a CRM-created (Cashfree link) payment that is the CRM's own balance: amount - refunded - held by open requests.
//
// For a payment that came from SHOPIFY the order also lives in Shopify, which has its own idea of what can still be refunded (what it has already refunded, what the
// gateway allows, ...). The CRM must never allow more than Shopify says is available, so the balance is the LOWER of the CRM's balance and Shopify's remaining
// amount (Shopify's reported refundable amount minus what open CRM requests already hold). The Shopify figure is read from Shopify itself after every sync of the
// order (see refunds.autoverify.ts) and re-read right before a refund is sent; nothing about it is hard-coded. If it is not known (never read, or in another
// currency) the payment is NOT refundable - an unknown limit is never treated as "no limit".

export const SHOPIFY_UNCONFIRMED_REASON = "Shopify's refundable amount for this order has not been confirmed yet, so it cannot be refunded here.";
export const SHOPIFY_CURRENCY_REASON = "Shopify reports the refundable amount in a different currency than this payment, so it cannot be refunded here.";

export interface BalancePayment {
  amount: { toString(): string };
  refundedAmount: { toString(): string } | null;
  currency: string;
  externalSource: string | null;
}

export interface RefundBalance {
  calc: RefundablePaymentAmount;
  /** Shopify's refundable amount for the order in cents (null when the payment is not from Shopify, or it is unknown). */
  shopifyCents: number | null;
  /** The CRM balance limited by Shopify's remaining amount: what a new request may ask for. */
  refundableCents: number;
  /** true when Shopify's figure (not the CRM's own balance) is what limits the amount. */
  limitedByShopify: boolean;
  /** Set when a Shopify payment's refundable amount is unknown or unusable: not refundable until it is read again. */
  blockedReason: string | null;
}

export function refundBalance(payment: BalancePayment, activeRequests: { amount: { toString(): string } }[], orderMetadata: unknown): RefundBalance {
  const calc = getRefundablePaymentAmount(payment, activeRequests);
  if (payment.externalSource !== "SHOPIFY") return { calc, shopifyCents: null, refundableCents: calc.refundableCents, limitedByShopify: false, blockedReason: null };

  const snapshot = shopifyRefundableOf(orderMetadata);
  const cents = snapshot ? toCents(snapshot.amount) : NaN;
  if (!snapshot || !Number.isInteger(cents) || cents < 0) return { calc, shopifyCents: null, refundableCents: 0, limitedByShopify: false, blockedReason: SHOPIFY_UNCONFIRMED_REASON };
  if (snapshot.currency !== payment.currency) return { calc, shopifyCents: null, refundableCents: 0, limitedByShopify: false, blockedReason: SHOPIFY_CURRENCY_REASON };

  const remaining = Math.max(cents - calc.reservedCents, 0);
  return { calc, shopifyCents: cents, refundableCents: Math.min(calc.refundableCents, remaining), limitedByShopify: remaining < calc.refundableCents, blockedReason: null };
}
