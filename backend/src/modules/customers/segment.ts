// E6.7 Customer Segments: a pure, deterministic function from real Lead/Order/Payment/
// InterestedLeadPeriod data to one of six lifecycle segments. No segment is ever invented from data
// that doesn't exist - see the two rejected signals noted below.
//
// Signals considered and why two were deliberately left out:
//   - lead.workingStatus: used (INTERESTED -> HOT signal).
//   - InterestedLeadPeriod (status ACTIVE): used (HOT signal) - a genuine, human/business-process
//     driven "this lead is actively being worked as a hot prospect" signal (E1-E5's Interested Leads
//     feature), not a system byproduct.
//   - order count / successful payment status / order dates: used throughout.
//   - lead.lastActivityAt: NOT used for HOT. It is bumped by routine Shopify sync on nearly every
//     touch (see shopify.persist.ts's resolveLead), so treating "recently touched" as "high intent"
//     would tag most actively-syncing customers as HOT and make the label meaningless.
//   - lead.lastContactedAt: NOT used. No write path in this codebase ever sets it (checked: it is
//     only ever read, never written), so it is always null in practice - building a rule on it would
//     be claiming a signal that does not actually exist yet.
import { PaymentStatus, type LeadWorkingStatus } from "../../../generated/prisma/enums.js";
import { derivePaymentStatus, fromCents } from "./customers.money.js";
import { SEGMENT_THRESHOLDS } from "./segment.config.js";

export type CustomerSegment = "NEW" | "HOT" | "REPEAT" | "VIP" | "DORMANT" | "AT_RISK";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SegmentMetrics {
  orderCount: number;
  successfulOrderCount: number;
  totalPaid: string;
  latestOrderAt: Date | null;
  daysSinceLastOrder: number | null;
}

export interface SegmentResult {
  segment: CustomerSegment;
  reason: string;
  metrics: SegmentMetrics;
}

export interface SegmentOrderInput {
  createdAt: Date;
  payments: { status: PaymentStatus }[];
}

export interface SegmentInput {
  workingStatus: LeadWorkingStatus;
  // Whether the lead currently has an InterestedLeadPeriod with status ACTIVE.
  hasActiveInterestedPeriod: boolean;
  orders: SegmentOrderInput[];
  // Total successfully collected money across the customer's orders, in integer cents - pass the
  // same figure customers.filters.ts' buildPaymentSummary already computed, so the two can never
  // disagree about what "paid" means.
  totalPaidCents: number;
  // Injectable for deterministic tests; defaults to the real clock.
  now?: Date;
}

function isSuccessfulOrder(order: SegmentOrderInput): boolean {
  const status = derivePaymentStatus(order.payments);
  return status === PaymentStatus.SUCCESS || status === PaymentStatus.PARTIALLY_REFUNDED;
}

const money = (cents: number) => `₹${fromCents(cents)}`;

// Segments are mutually exclusive; the first rule matched below wins, in this order:
//   VIP > HOT > DORMANT > AT_RISK > REPEAT > NEW
// VIP is a persistent value tier so it always wins. HOT (a live intent signal) outranks the two
// inactivity labels since it is the most time-sensitive, actionable state for a rep to see. NEW is
// the fallback when nothing else matches.
export function deriveCustomerSegment(input: SegmentInput): SegmentResult {
  const now = input.now ?? new Date();
  const orderCount = input.orders.length;
  const successfulOrderCount = input.orders.filter(isSuccessfulOrder).length;

  const latestOrderAt =
    orderCount === 0
      ? null
      : input.orders.reduce((latest, o) => (o.createdAt > latest ? o.createdAt : latest), input.orders[0].createdAt);
  const daysSinceLastOrder = latestOrderAt ? Math.floor((now.getTime() - latestOrderAt.getTime()) / MS_PER_DAY) : null;

  const metrics: SegmentMetrics = {
    orderCount,
    successfulOrderCount,
    totalPaid: fromCents(input.totalPaidCents),
    latestOrderAt,
    daysSinceLastOrder,
  };

  const isVip =
    input.totalPaidCents >= SEGMENT_THRESHOLDS.vipMinTotalPaidCents ||
    successfulOrderCount >= SEGMENT_THRESHOLDS.vipMinSuccessfulOrders;
  if (isVip) {
    return {
      segment: "VIP",
      reason: `Customer meets the configured high-value customer threshold (${money(SEGMENT_THRESHOLDS.vipMinTotalPaidCents)}+ paid, or ${SEGMENT_THRESHOLDS.vipMinSuccessfulOrders}+ successful orders).`,
      metrics,
    };
  }

  // HOT is checked before DORMANT/AT_RISK: a currently-active, human-driven intent signal is a more
  // urgent, actionable thing to surface than a stale inactivity label - e.g. a previously-dormant
  // customer a rep has just re-engaged and marked Interested again should show as HOT, not DORMANT.
  const isHot = input.workingStatus === "INTERESTED" || input.hasActiveInterestedPeriod;
  if (isHot) {
    return {
      segment: "HOT",
      reason: "Customer has an active high-intent signal recorded in the CRM (marked Interested).",
      metrics,
    };
  }

  const hasPurchasedBefore = successfulOrderCount >= 1 && daysSinceLastOrder !== null;
  if (hasPurchasedBefore && daysSinceLastOrder! >= SEGMENT_THRESHOLDS.dormantMinDaysSinceLastOrder) {
    return {
      segment: "DORMANT",
      reason: `No order activity within the configured dormant period (${SEGMENT_THRESHOLDS.dormantMinDaysSinceLastOrder}+ days since the last order).`,
      metrics,
    };
  }

  if (hasPurchasedBefore && daysSinceLastOrder! >= SEGMENT_THRESHOLDS.atRiskMinDaysSinceLastOrder) {
    return {
      segment: "AT_RISK",
      reason: `Customer previously purchased but has not ordered within the configured risk window (${SEGMENT_THRESHOLDS.atRiskMinDaysSinceLastOrder}+ days).`,
      metrics,
    };
  }

  if (successfulOrderCount >= SEGMENT_THRESHOLDS.repeatMinSuccessfulOrders) {
    return {
      segment: "REPEAT",
      reason: "Customer has completed more than one successful order.",
      metrics,
    };
  }

  return {
    segment: "NEW",
    reason: "Customer has no completed repeat order yet.",
    metrics,
  };
}
