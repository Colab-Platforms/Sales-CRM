// E6.8 Next Best Action: a pure, deterministic function that turns a customer's real CRM state
// (their E6.7 segment, already-computed, plus their orders' current payment/shipment state) into
// one recommended next action. No AI, no invented signals, no autonomous communication - this only
// ever *recommends* what a human rep should do next, and explains why in plain language.
//
// Configuration: NBA introduces NO new time/value thresholds of its own. Every timing/value rule
// (VIP threshold, dormant/at-risk windows, repeat-order count) is inherited transitively through the
// `segment` result this module is given - see segment.config.ts. Centralizing a second, empty
// config file here would just create a second place to look for the same numbers.
//
// Channel: the CRM's only channel with an actual, working write path today is a logged phone Call
// (the Call model). There is no email-sending integration anywhere in this codebase, and WhatsApp/E7
// is explicitly out of scope. EMAIL and WHATSAPP stay in the type union for a future channel to fill
// in, but this derivation never recommends them - only "CALL" (something a rep can actually do right
// now) or "NONE" (no contact needed).
import type { PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { computePaymentBreakdown } from "../orders/orders.filters.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import type { SegmentResult } from "./segment.js";

export type NbaAction =
  | "FOLLOW_UP_PAYMENT"
  | "TRACK_SHIPMENT"
  | "FOLLOW_UP_DELIVERY"
  | "HANDLE_RETURN"
  | "RETENTION_FOLLOW_UP"
  | "REPEAT_PURCHASE_FOLLOW_UP"
  | "HIGH_VALUE_CUSTOMER_FOLLOW_UP"
  | "INTERESTED_LEAD_FOLLOW_UP"
  | "GENERAL_FOLLOW_UP"
  | "NO_ACTION";

export type NbaPriority = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type NbaChannel = "CALL" | "EMAIL" | "WHATSAPP" | "NONE";

export interface NbaMetrics {
  outstandingAmount: string;
  totalPaid: string;
  orderCount: number;
  successfulOrderCount: number;
  daysSinceLastOrder: number | null;
}

export interface NbaResult {
  action: NbaAction;
  priority: NbaPriority;
  reason: string;
  recommendedChannel: NbaChannel;
  relatedOrderId: string | null;
  metrics: NbaMetrics;
}

export interface NbaOrderInput {
  id: string;
  orderNumber: string;
  totalAmount: { toString(): string };
  payments: { status: PaymentStatus; amount: { toString(): string }; refundedAmount: { toString(): string } | null }[];
  // The order's current/most-recently-updated shipment status, if any shipment has synced.
  latestShipmentStatus: ShipmentStatus | null;
}

export interface NbaInput {
  // The customer's already-derived E6.7 segment - never re-derived here.
  segment: SegmentResult;
  // Most-recent-first, the same convention as the rest of this module.
  orders: NbaOrderInput[];
  totalPaidCents: number;
  totalOutstandingCents: number;
}

const IN_TRANSIT_STATUSES = new Set<ShipmentStatus>(["SHIPPED", "IN_TRANSIT"]);
const money = (cents: number) => `₹${fromCents(cents)}`;

function outstandingCentsFor(order: NbaOrderInput): number {
  const totalCents = toCents(order.totalAmount.toString());
  const breakdown = computePaymentBreakdown(order.payments);
  return Math.max(totalCents - breakdown.paidCents - breakdown.refundedCents, 0);
}

// Rule evaluation order (first match wins) and why it differs from the task's suggested draft order:
//   1. FOLLOW_UP_PAYMENT     - an order is actually owed money right now.
//   2. FOLLOW_UP_DELIVERY    - a parcel is out for delivery today (time-sensitive coordination).
//   3. HANDLE_RETURN         - a parcel came back and needs active resolution (refund/replacement).
//   4. TRACK_SHIPMENT        - a parcel is shipped/in transit (informational, nothing broken).
//      Returns are placed ABOVE "in transit" tracking, reversing the task's suggested draft order:
//      a returned parcel is an active problem to resolve, while "in transit" is a passive, working-
//      as-expected state - resolving a return is clearly the more urgent of the two.
//   5. Otherwise, the customer's segment (already mutually exclusive - see segment.ts) maps directly
//      to one action. VIP already outranks HOT/DORMANT/AT_RISK/REPEAT inside the segment itself, so
//      no extra ordering is needed here.
export function deriveNextBestAction(input: NbaInput): NbaResult {
  const { segment, orders } = input;
  const metrics: NbaMetrics = {
    outstandingAmount: fromCents(input.totalOutstandingCents),
    totalPaid: fromCents(input.totalPaidCents),
    orderCount: segment.metrics.orderCount,
    successfulOrderCount: segment.metrics.successfulOrderCount,
    daysSinceLastOrder: segment.metrics.daysSinceLastOrder,
  };

  const unpaidOrder = orders.find((o) => outstandingCentsFor(o) > 0);
  if (unpaidOrder) {
    return {
      action: "FOLLOW_UP_PAYMENT",
      priority: "HIGH",
      reason: `Customer has an outstanding payment of ${money(outstandingCentsFor(unpaidOrder))} on order ${unpaidOrder.orderNumber}.`,
      recommendedChannel: "CALL",
      relatedOrderId: unpaidOrder.id,
      metrics,
    };
  }

  const outForDeliveryOrder = orders.find((o) => o.latestShipmentStatus === "OUT_FOR_DELIVERY");
  if (outForDeliveryOrder) {
    return {
      action: "FOLLOW_UP_DELIVERY",
      priority: "HIGH",
      reason: `Order ${outForDeliveryOrder.orderNumber} is currently out for delivery.`,
      recommendedChannel: "CALL",
      relatedOrderId: outForDeliveryOrder.id,
      metrics,
    };
  }

  const returnedOrder = orders.find((o) => o.latestShipmentStatus === "RETURNED");
  if (returnedOrder) {
    return {
      action: "HANDLE_RETURN",
      priority: "HIGH",
      reason: `Order ${returnedOrder.orderNumber} was returned and needs resolution.`,
      recommendedChannel: "CALL",
      relatedOrderId: returnedOrder.id,
      metrics,
    };
  }

  const inTransitOrder = orders.find((o) => o.latestShipmentStatus !== null && IN_TRANSIT_STATUSES.has(o.latestShipmentStatus));
  if (inTransitOrder) {
    return {
      action: "TRACK_SHIPMENT",
      priority: "MEDIUM",
      reason: `Order ${inTransitOrder.orderNumber} is in transit.`,
      recommendedChannel: "CALL",
      relatedOrderId: inTransitOrder.id,
      metrics,
    };
  }

  switch (segment.segment) {
    case "HOT":
      return {
        action: "INTERESTED_LEAD_FOLLOW_UP",
        priority: "HIGH",
        reason: "Customer currently has an active interested-lead signal recorded in the CRM.",
        recommendedChannel: "CALL",
        relatedOrderId: null,
        metrics,
      };
    case "DORMANT":
      return {
        action: "RETENTION_FOLLOW_UP",
        priority: "LOW",
        reason: "Customer previously purchased but has been inactive for the configured period.",
        recommendedChannel: "CALL",
        relatedOrderId: null,
        metrics,
      };
    case "AT_RISK":
      return {
        action: "RETENTION_FOLLOW_UP",
        priority: "MEDIUM",
        reason: "Customer previously purchased but has not ordered within the configured risk window.",
        recommendedChannel: "CALL",
        relatedOrderId: null,
        metrics,
      };
    case "REPEAT":
      return {
        action: "REPEAT_PURCHASE_FOLLOW_UP",
        priority: "LOW",
        reason: "Customer has completed multiple successful orders.",
        recommendedChannel: "CALL",
        relatedOrderId: null,
        metrics,
      };
    case "VIP":
      return {
        action: "HIGH_VALUE_CUSTOMER_FOLLOW_UP",
        priority: "MEDIUM",
        reason: "Customer meets the configured VIP threshold.",
        recommendedChannel: "CALL",
        relatedOrderId: null,
        metrics,
      };
    case "NEW":
    default: {
      // Reached only when no order currently owes money (FOLLOW_UP_PAYMENT above already catches a
      // failed/pending payment attempt, since that order still has an outstanding balance) and no
      // shipment needs attention. A NEW segment then means either a lead with zero orders, or one
      // whose only order(s) resolved to $0 owed without ever actually collecting money (e.g. a fully
      // discounted order) - both still need a sales push. A customer who already paid and whose order
      // is fully resolved does not.
      if (segment.metrics.successfulOrderCount === 0) {
        return {
          action: "GENERAL_FOLLOW_UP",
          priority: "LOW",
          reason: "Customer has not yet completed a paid order; general sales follow-up is recommended.",
          recommendedChannel: "CALL",
          relatedOrderId: null,
          metrics,
        };
      }
      return {
        action: "NO_ACTION",
        priority: "NONE",
        reason: "No immediate post-sale action is currently required.",
        recommendedChannel: "NONE",
        relatedOrderId: null,
        metrics,
      };
    }
  }
}
