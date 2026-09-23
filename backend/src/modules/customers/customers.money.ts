// Money/payment math the customers module needs for Customer 360 (payment summaries, segments,
// NBA). Kept local to this module: the orders/shopify modules that used to own this logic were
// removed from this branch, but Order/Payment/Shipment data itself still lives in the DB and
// customers still needs to summarize it.
import { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";

// Amounts arrive as decimal strings ("649.0"); arithmetic is done in whole cents so sums never drift.
export const toCents = (amount: string | null | undefined): number => (amount == null ? 0 : Math.round(Number(amount) * 100) || 0);

export const fromCents = (cents: number): string => (cents / 100).toFixed(2);

export const sumCents = (amounts: Array<string | null | undefined>): number => amounts.reduce<number>((sum, a) => sum + toCents(a), 0);

export function fullName(firstName: string, lastName: string | null): string {
  return lastName ? `${firstName} ${lastName}` : firstName;
}

// How the customer pays: cash on delivery, or up front by any other method. Null when the method is not known.
export type PaymentMode = "COD" | "PREPAID";

// Filter value for orders/customers that have no payment record yet.
export const NO_PAYMENT = "NONE" as const;
export type PaymentStatusFilter = PaymentStatus | typeof NO_PAYMENT;

// An order can carry several payment attempts. Its single "payment status" is the most
// conclusive outcome among them, so a failed attempt followed by a successful retry reads
// SUCCESS, and a refunded payment reads REFUNDED.
export const PAYMENT_STATUS_PRECEDENCE: PaymentStatus[] = [
  PaymentStatus.REFUNDED,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.SUCCESS,
  PaymentStatus.PROCESSING,
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
];

export function derivePaymentStatus(payments: { status: PaymentStatus }[]): PaymentStatus | null {
  return PAYMENT_STATUS_PRECEDENCE.find((status) => payments.some((p) => p.status === status)) ?? null;
}

// Cash on delivery if any payment is COD; otherwise prepaid if any payment has a known method; otherwise unknown.
export function derivePaymentMode(payments: { method: PaymentMethod | null }[]): PaymentMode | null {
  if (payments.some((p) => p.method === PaymentMethod.COD)) return "COD";
  return payments.some((p) => p.method !== null) ? "PREPAID" : null;
}

export interface PaymentBreakdown {
  // Net money currently held: successful payments, plus the un-refunded remainder of a partial refund.
  paidCents: number;
  pendingCents: number;
  failedCents: number;
  // Money actually returned to the customer.
  refundedCents: number;
  // Everything ever captured before any refund (successful, partially-refunded and fully-refunded
  // payments' original amounts) - used to sanity-check that a refund never exceeds what was collected.
  grossReceivedCents: number;
  successfulPaymentCount: number;
  pendingPaymentCount: number;
  failedPaymentCount: number;
  refundedPaymentCount: number;
}

type BreakdownPayment = {
  status: PaymentStatus;
  amount: { toString(): string };
  refundedAmount: { toString(): string } | null;
};

// The single place money is summed across an order's payment attempts, in integer cents so results
// never drift.
export function computePaymentBreakdown(payments: BreakdownPayment[]): PaymentBreakdown {
  const breakdown: PaymentBreakdown = {
    paidCents: 0,
    pendingCents: 0,
    failedCents: 0,
    refundedCents: 0,
    grossReceivedCents: 0,
    successfulPaymentCount: 0,
    pendingPaymentCount: 0,
    failedPaymentCount: 0,
    refundedPaymentCount: 0,
  };

  for (const payment of payments) {
    const amountCents = toCents(payment.amount.toString());
    const refundedForPayment = payment.refundedAmount ? toCents(payment.refundedAmount.toString()) : 0;

    switch (payment.status) {
      case PaymentStatus.SUCCESS:
        breakdown.paidCents += amountCents;
        breakdown.grossReceivedCents += amountCents;
        breakdown.successfulPaymentCount++;
        break;
      case PaymentStatus.PENDING:
      case PaymentStatus.PROCESSING:
        breakdown.pendingCents += amountCents;
        breakdown.pendingPaymentCount++;
        break;
      case PaymentStatus.FAILED:
        breakdown.failedCents += amountCents;
        breakdown.failedPaymentCount++;
        break;
      case PaymentStatus.REFUNDED:
        breakdown.refundedCents += refundedForPayment || amountCents;
        breakdown.grossReceivedCents += amountCents;
        breakdown.refundedPaymentCount++;
        break;
      case PaymentStatus.PARTIALLY_REFUNDED:
        breakdown.refundedCents += refundedForPayment;
        breakdown.paidCents += Math.max(amountCents - refundedForPayment, 0);
        breakdown.grossReceivedCents += amountCents;
        breakdown.refundedPaymentCount++;
        break;
    }
  }

  return breakdown;
}
