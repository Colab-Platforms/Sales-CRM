import { PaymentStatus } from "../../../generated/prisma/enums.js";
import type { PaymentMethod } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { derivePaymentMode, derivePaymentStatus, fullName } from "../orders/orders.filters.js";
import { fromCents, sumCents, toCents } from "../shopify/shopify.money.js";
import type { CustomerOrderSummary, CustomerPaymentSummary, CustomerProfile } from "./customers.types.js";

// One lead (customer), but only if the user's lead scope allows it. Mirrors orders.filters.ts'
// scopedOrderWhere so a customer id that exists but is out of scope looks the same as a missing one.
export function scopedLeadWhere(leadId: string, leadScope: Prisma.LeadWhereInput): Prisma.LeadWhereInput {
  return Object.keys(leadScope).length > 0 ? { AND: [{ id: leadId }, leadScope] } : { id: leadId };
}

export interface LeadProfileInput {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
  workingStatus: CustomerProfile["workingStatus"];
  priority: CustomerProfile["priority"];
  createdAt: Date;
  lastActivityAt: Date | null;
  lastContactedAt: Date | null;
  source: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
}

export function mapProfile(lead: LeadProfileInput): CustomerProfile {
  return {
    leadId: lead.id,
    leadNumber: lead.leadNumber,
    name: fullName(lead.firstName, lead.lastName),
    mobile: lead.mobile,
    email: lead.email,
    source: lead.source,
    owner: lead.owner,
    workingStatus: lead.workingStatus,
    priority: lead.priority,
    createdAt: lead.createdAt,
    lastActivityAt: lead.lastActivityAt,
    lastContactedAt: lead.lastContactedAt,
  };
}

export interface OrderSummaryInput {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  source: CustomerOrderSummary["source"];
  createdAt: Date;
  currency: string;
  totalAmount: { toString(): string };
  status: CustomerOrderSummary["status"];
  payments: { status: PaymentStatus; method: PaymentMethod | null; amount: { toString(): string }; refundedAmount: { toString(): string } | null }[];
}

export function mapOrderSummary(order: OrderSummaryInput): CustomerOrderSummary {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    externalNumber: order.externalNumber,
    source: order.source,
    createdAt: order.createdAt,
    currency: order.currency,
    totalAmount: order.totalAmount.toString(),
    status: order.status,
    paymentStatus: derivePaymentStatus(order.payments),
    paymentMode: derivePaymentMode(order.payments),
  };
}

// All money is summed in integer cents (via the same helpers the Shopify sync uses) so totals
// across many orders/payments never drift the way repeated float addition would.
export function buildPaymentSummary(orders: OrderSummaryInput[]): CustomerPaymentSummary {
  let paidCents = 0;
  let pendingCents = 0;
  let failedCents = 0;
  let refundedCents = 0;
  let successfulPaymentCount = 0;
  let pendingPaymentCount = 0;
  let failedPaymentCount = 0;
  let refundedPaymentCount = 0;
  let codOrderCount = 0;
  let codCents = 0;
  let prepaidOrderCount = 0;
  let prepaidCents = 0;

  for (const order of orders) {
    const mode = derivePaymentMode(order.payments);
    const orderTotalCents = toCents(order.totalAmount.toString());
    if (mode === "COD") {
      codOrderCount++;
      codCents += orderTotalCents;
    } else if (mode === "PREPAID") {
      prepaidOrderCount++;
      prepaidCents += orderTotalCents;
    }

    for (const payment of order.payments) {
      const amountCents = toCents(payment.amount.toString());
      const refundedForPayment = payment.refundedAmount ? toCents(payment.refundedAmount.toString()) : 0;

      switch (payment.status) {
        case PaymentStatus.SUCCESS:
          paidCents += amountCents;
          successfulPaymentCount++;
          break;
        case PaymentStatus.PENDING:
        case PaymentStatus.PROCESSING:
          pendingCents += amountCents;
          pendingPaymentCount++;
          break;
        case PaymentStatus.FAILED:
          failedCents += amountCents;
          failedPaymentCount++;
          break;
        case PaymentStatus.REFUNDED:
          refundedCents += refundedForPayment || amountCents;
          refundedPaymentCount++;
          break;
        case PaymentStatus.PARTIALLY_REFUNDED:
          refundedCents += refundedForPayment;
          paidCents += Math.max(amountCents - refundedForPayment, 0);
          refundedPaymentCount++;
          break;
      }
    }
  }

  return {
    orderCount: orders.length,
    totalOrderValue: fromCents(sumCents(orders.map((o) => o.totalAmount.toString()))),
    totalPaid: fromCents(paidCents),
    totalPending: fromCents(pendingCents),
    totalFailed: fromCents(failedCents),
    totalRefunded: fromCents(refundedCents),
    successfulPaymentCount,
    pendingPaymentCount,
    failedPaymentCount,
    refundedPaymentCount,
    codOrderCount,
    codValue: fromCents(codCents),
    prepaidOrderCount,
    prepaidValue: fromCents(prepaidCents),
  };
}
