import type { LeadWorkingStatus, PaymentMethod, PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { computePaymentBreakdown, derivePaymentMode, derivePaymentStatus, fullName } from "../orders/orders.filters.js";
import type { ShipmentDetail } from "../orders/orders.types.js";
import { fromCents, sumCents, toCents } from "../shopify/shopify.money.js";
import { deriveNextBestAction, type NbaOrderInput } from "./nba.js";
import { deriveCustomerSegment } from "./segment.js";
import type {
  CustomerListItem,
  CustomerOrderSummary,
  CustomerPaymentSummary,
  CustomerProfile,
  CustomerSegmentInfo,
  ListCustomersQuery,
  NextBestActionInfo,
} from "./customers.types.js";

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

export interface ShipmentSummaryInput {
  id: string;
  status: ShipmentStatus;
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  createdAt: Date;
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
  // Expected pre-sorted most-recent-first (same convention as the order list itself).
  shipments: ShipmentSummaryInput[];
}

export function mapOrderSummary(order: OrderSummaryInput): CustomerOrderSummary {
  const latest = order.shipments[0];
  const latestShipment: ShipmentDetail | null = latest
    ? {
        id: latest.id,
        status: latest.status,
        courier: latest.courier,
        trackingNumber: latest.trackingNumber,
        trackingUrl: latest.trackingUrl,
        shippedAt: latest.shippedAt,
        expectedDeliveryAt: latest.expectedDeliveryAt,
        deliveredAt: latest.deliveredAt,
        returnedAt: latest.returnedAt,
        createdAt: latest.createdAt,
      }
    : null;

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
    latestShipment,
  };
}

// All money is summed in integer cents (via computePaymentBreakdown, the same per-order math the
// reconciliation module uses) so totals across many orders/payments never drift, and a customer's
// payment summary can never disagree with the reconciliation view about the same orders.
export function buildPaymentSummary(orders: OrderSummaryInput[]): CustomerPaymentSummary {
  let paidCents = 0;
  let pendingCents = 0;
  let failedCents = 0;
  let refundedCents = 0;
  let outstandingCents = 0;
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

    const breakdown = computePaymentBreakdown(order.payments);
    paidCents += breakdown.paidCents;
    pendingCents += breakdown.pendingCents;
    failedCents += breakdown.failedCents;
    refundedCents += breakdown.refundedCents;
    outstandingCents += Math.max(orderTotalCents - breakdown.paidCents - breakdown.refundedCents, 0);
    successfulPaymentCount += breakdown.successfulPaymentCount;
    pendingPaymentCount += breakdown.pendingPaymentCount;
    failedPaymentCount += breakdown.failedPaymentCount;
    refundedPaymentCount += breakdown.refundedPaymentCount;
  }

  return {
    orderCount: orders.length,
    totalOrderValue: fromCents(sumCents(orders.map((o) => o.totalAmount.toString()))),
    totalPaid: fromCents(paidCents),
    totalPending: fromCents(pendingCents),
    totalFailed: fromCents(failedCents),
    totalRefunded: fromCents(refundedCents),
    totalOutstanding: fromCents(outstandingCents),
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

// ---- E6.7: Customer Segments & Post-Sale Management ----

// The customer's lifecycle segment, built from the exact same orders/paymentSummary the rest of
// Customer 360 already computed - never a second, independent calculation of "paid" or "orders".
export function buildSegmentInfo(
  lead: { workingStatus: LeadWorkingStatus },
  hasActiveInterestedPeriod: boolean,
  orders: OrderSummaryInput[],
  paymentSummary: CustomerPaymentSummary,
  now?: Date,
): CustomerSegmentInfo {
  return deriveCustomerSegment({
    workingStatus: lead.workingStatus,
    hasActiveInterestedPeriod,
    orders: orders.map((o) => ({ createdAt: o.createdAt, payments: o.payments })),
    totalPaidCents: toCents(paymentSummary.totalPaid),
    now,
  });
}

export function buildCustomerListWhere(query: ListCustomersQuery, leadScope: Prisma.LeadWhereInput): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [];

  if (Object.keys(leadScope).length > 0) and.push(leadScope);
  if (query.ownerId) and.push({ ownerId: query.ownerId });
  if (query.dateFrom || query.dateTo) and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  if (query.search) {
    const contains = { contains: query.search, mode: "insensitive" as const };
    and.push({ OR: [{ firstName: contains }, { lastName: contains }, { leadNumber: contains }, { mobile: contains }, { email: contains }] });
  }

  return and.length > 0 ? { AND: and } : {};
}

// ---- E6.8: Next Best Action ----

// Built from the exact same orders/segment/paymentSummary already computed - the recommendation can
// never disagree with the segment or payment summary shown alongside it.
export function buildNbaInfo(orders: OrderSummaryInput[], segmentInfo: CustomerSegmentInfo, paymentSummary: CustomerPaymentSummary): NextBestActionInfo {
  const nbaOrders: NbaOrderInput[] = orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    totalAmount: o.totalAmount,
    payments: o.payments,
    latestShipmentStatus: o.shipments[0]?.status ?? null,
  }));

  return deriveNextBestAction({
    segment: segmentInfo,
    orders: nbaOrders,
    totalPaidCents: toCents(paymentSummary.totalPaid),
    totalOutstandingCents: toCents(paymentSummary.totalOutstanding),
  });
}

export interface CustomerListLeadInput {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  mobile: string | null;
  workingStatus: LeadWorkingStatus;
  owner: { id: string; name: string } | null;
  hasActiveInterestedPeriod: boolean;
}

// `orders` must already be sorted most-recent-first (the same convention as everywhere else in this
// module), so `orders[0]` is the customer's current/latest order.
export function mapCustomerListItem(lead: CustomerListLeadInput, orders: OrderSummaryInput[], now?: Date): CustomerListItem {
  const paymentSummary = buildPaymentSummary(orders);
  const segmentInfo = buildSegmentInfo(lead, lead.hasActiveInterestedPeriod, orders, paymentSummary, now);
  const nba = buildNbaInfo(orders, segmentInfo, paymentSummary);
  const latest = orders[0];
  const latestSummary = latest ? mapOrderSummary(latest) : null;

  return {
    leadId: lead.id,
    leadNumber: lead.leadNumber,
    name: fullName(lead.firstName, lead.lastName),
    mobile: lead.mobile,
    segment: segmentInfo.segment,
    segmentReason: segmentInfo.reason,
    orderCount: orders.length,
    totalPaid: paymentSummary.totalPaid,
    outstandingAmount: paymentSummary.totalOutstanding,
    lastOrderAt: latest?.createdAt ?? null,
    currentOrderStatus: latest?.status ?? null,
    currentPaymentStatus: latestSummary?.paymentStatus ?? null,
    currentShipmentStatus: latestSummary?.latestShipment?.status ?? null,
    owner: lead.owner,
    nbaAction: nba.action,
    nbaPriority: nba.priority,
    nbaReason: nba.reason,
  };
}
