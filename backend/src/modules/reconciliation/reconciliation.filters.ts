import type { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import {
  computePaymentBreakdown,
  derivePaymentMode,
  derivePaymentStatus,
  fullName,
  paymentStatusWhere,
  searchWhere,
  type PaymentBreakdown,
} from "../orders/orders.filters.js";
import { fromCents, sumCents, toCents } from "../shopify/shopify.money.js";
import type {
  ListReconciliationQuery,
  ReconciliationOrderRow,
  ReconciliationStatus,
  ReconciliationSummary,
} from "./reconciliation.types.js";

export function buildReconciliationWhere(
  query: ListReconciliationQuery,
  leadScope: Prisma.LeadWhereInput,
): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [];

  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.search) and.push(searchWhere(query.search));
  if (query.paymentStatus) and.push(paymentStatusWhere(query.paymentStatus));
  if (query.provider) and.push({ payments: { some: { provider: { contains: query.provider, mode: "insensitive" } } } });
  if (query.dateFrom || query.dateTo) {
    and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  }

  return and.length > 0 ? { AND: and } : {};
}

// Data-driven: PAYMENT_MISMATCH only fires when the amounts themselves are inconsistent - a refund
// larger than anything ever collected, or net payments exceeding the order total - never merely
// because a field (provider, reference, etc.) happens to be unavailable.
export function deriveReconciliationStatus(
  totalCents: number,
  breakdown: PaymentBreakdown,
  hasPayments: boolean,
): ReconciliationStatus {
  const { paidCents, refundedCents, failedCents, grossReceivedCents } = breakdown;

  if (refundedCents > grossReceivedCents) return "PAYMENT_MISMATCH";
  if (paidCents > totalCents) return "PAYMENT_MISMATCH";

  if (!hasPayments) return "PENDING";

  if (paidCents === 0) {
    if (refundedCents > 0) return "REFUNDED";
    if (failedCents > 0) return "FAILED";
    return "PENDING";
  }

  return paidCents >= totalCents ? "PAID" : "PARTIALLY_PAID";
}

export interface ReconciliationPayment {
  status: PaymentStatus;
  method: PaymentMethod | null;
  amount: { toString(): string };
  refundedAmount: { toString(): string } | null;
  provider: string | null;
  transactionReference: string | null;
  createdAt: Date;
}

export interface ReconciliationOrderInput {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  createdAt: Date;
  currency: string;
  totalAmount: { toString(): string };
  discountAmount: { toString(): string };
  lead: { id: string; leadNumber: string; firstName: string; lastName: string | null };
  payments: ReconciliationPayment[];
}

export function mapReconciliationRow(order: ReconciliationOrderInput): ReconciliationOrderRow {
  const totalCents = toCents(order.totalAmount.toString());
  const breakdown = computePaymentBreakdown(order.payments);
  const outstandingCents = Math.max(totalCents - breakdown.paidCents - breakdown.refundedCents, 0);
  // The most recent payment attempt drives the method/provider/reference shown for the order.
  const latestPayment = [...order.payments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    externalNumber: order.externalNumber,
    createdAt: order.createdAt,
    currency: order.currency,
    customer: {
      leadId: order.lead.id,
      leadNumber: order.lead.leadNumber,
      name: fullName(order.lead.firstName, order.lead.lastName),
    },
    orderAmount: order.totalAmount.toString(),
    discountAmount: order.discountAmount.toString(),
    paidAmount: fromCents(breakdown.paidCents),
    refundedAmount: fromCents(breakdown.refundedCents),
    outstandingAmount: fromCents(outstandingCents),
    paymentMode: derivePaymentMode(order.payments),
    paymentMethod: latestPayment?.method ?? null,
    paymentStatus: derivePaymentStatus(order.payments),
    paymentProvider: latestPayment?.provider ?? null,
    transactionReference: latestPayment?.transactionReference ?? null,
    reconciliationStatus: deriveReconciliationStatus(totalCents, breakdown, order.payments.length > 0),
  };
}

// Totals across every order that made it past the filters (not just the current page), so the
// summary cards stay correct regardless of pagination.
export function buildReconciliationSummary(orders: ReconciliationOrderInput[]): ReconciliationSummary {
  let paidCents = 0;
  let pendingCents = 0;
  let failedCents = 0;
  let refundedCents = 0;
  let outstandingCents = 0;
  let codOrderCount = 0;
  let codCents = 0;
  let prepaidOrderCount = 0;
  let prepaidCents = 0;

  for (const order of orders) {
    const totalCents = toCents(order.totalAmount.toString());
    const breakdown = computePaymentBreakdown(order.payments);
    paidCents += breakdown.paidCents;
    pendingCents += breakdown.pendingCents;
    failedCents += breakdown.failedCents;
    refundedCents += breakdown.refundedCents;
    outstandingCents += Math.max(totalCents - breakdown.paidCents - breakdown.refundedCents, 0);

    const mode = derivePaymentMode(order.payments);
    if (mode === "COD") {
      codOrderCount++;
      codCents += totalCents;
    } else if (mode === "PREPAID") {
      prepaidOrderCount++;
      prepaidCents += totalCents;
    }
  }

  return {
    orderCount: orders.length,
    grossOrderValue: fromCents(sumCents(orders.map((o) => o.totalAmount.toString()))),
    successfulPayments: fromCents(paidCents),
    pendingPayments: fromCents(pendingCents),
    failedPayments: fromCents(failedCents),
    refundedAmount: fromCents(refundedCents),
    netRevenue: fromCents(paidCents - refundedCents),
    outstandingAmount: fromCents(outstandingCents),
    codOrderCount,
    codValue: fromCents(codCents),
    prepaidOrderCount,
    prepaidValue: fromCents(prepaidCents),
  };
}
