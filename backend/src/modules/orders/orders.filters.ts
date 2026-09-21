import { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { toCents } from "../shopify/shopify.money.js";
import { NO_PAYMENT, type ListOrdersQuery, type PaymentMode, type PaymentStatusFilter } from "./orders.types.js";

// An order can carry several payment attempts. Its single "payment status" is the most
// conclusive outcome among them, so a failed attempt followed by a successful retry reads
// SUCCESS, and a refunded payment reads REFUNDED. Listing, filtering and the detail view
// all use this one rule so they can never disagree.
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

// Database-side equivalent of derivePaymentStatus().
export function paymentStatusWhere(status: PaymentStatusFilter): Prisma.OrderWhereInput {
  if (status === NO_PAYMENT) {
    return { payments: { none: {} } };
  }

  const outranking = PAYMENT_STATUS_PRECEDENCE.slice(0, PAYMENT_STATUS_PRECEDENCE.indexOf(status));
  const conditions: Prisma.OrderWhereInput[] = [{ payments: { some: { status } } }];
  if (outranking.length > 0) {
    conditions.push({ payments: { none: { status: { in: outranking } } } });
  }
  return { AND: conditions };
}

// Every word must match at least one field, so "priya 98765" or "ORD-1001 priya" both work.
const MAX_SEARCH_TERMS = 5;

export function searchWhere(search: string): Prisma.OrderWhereInput {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);

  return {
    AND: terms.map((term): Prisma.OrderWhereInput => {
      const contains = { contains: term, mode: "insensitive" as const };
      return {
        OR: [
          { orderNumber: contains },
          { externalNumber: contains },
          { lead: { leadNumber: contains } },
          { lead: { firstName: contains } },
          { lead: { lastName: contains } },
          { lead: { mobile: contains } },
          { lead: { email: contains } },
          { payments: { some: { transactionReference: contains } } },
        ],
      };
    }),
  };
}

// "Salesperson" on an order is whoever booked it; website/API orders have nobody, so they
// fall back to the current owner of the original lead.
export function salespersonWhere(userId: string): Prisma.OrderWhereInput {
  return { OR: [{ createdById: userId }, { createdById: null, lead: { ownerId: userId } }] };
}

export function buildOrderWhere(query: ListOrdersQuery, leadScope: Prisma.LeadWhereInput): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [];

  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.search) and.push(searchWhere(query.search));
  if (query.status) and.push({ status: query.status });
  if (query.source) and.push({ source: query.source });
  if (query.paymentStatus) and.push(paymentStatusWhere(query.paymentStatus));
  if (query.salespersonId) and.push(salespersonWhere(query.salespersonId));
  if (query.dateFrom || query.dateTo) {
    and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  }

  return and.length > 0 ? { AND: and } : {};
}

// One order, but only if the user's lead scope allows it.
export function scopedOrderWhere(id: string, leadScope: Prisma.LeadWhereInput): Prisma.OrderWhereInput {
  return Object.keys(leadScope).length > 0 ? { AND: [{ id }, { lead: leadScope }] } : { id };
}

export function fullName(firstName: string, lastName: string | null): string {
  return lastName ? `${firstName} ${lastName}` : firstName;
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
// never drift. Shared by the customer payment summary and the reconciliation module so neither can
// disagree with the other about what "paid" or "refunded" means.
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
