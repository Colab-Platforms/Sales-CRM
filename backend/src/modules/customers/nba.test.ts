import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentStatus } from "../../../generated/prisma/enums.js";
import { deriveNextBestAction, type NbaInput, type NbaOrderInput } from "./nba.js";
import type { SegmentResult } from "./segment.js";

function segment(overrides: Partial<SegmentResult> = {}): SegmentResult {
  return {
    segment: "NEW",
    reason: "Customer has no completed repeat order yet.",
    metrics: { orderCount: 0, successfulOrderCount: 0, totalPaid: "0.00", latestOrderAt: null, daysSinceLastOrder: null },
    ...overrides,
  };
}

function order(overrides: Partial<NbaOrderInput> = {}): NbaOrderInput {
  return {
    id: "order-1",
    orderNumber: "ORD-1",
    totalAmount: { toString: () => "1000.00" },
    payments: [{ status: PaymentStatus.SUCCESS, amount: { toString: () => "1000.00" }, refundedAmount: null }],
    latestShipmentStatus: null,
    ...overrides,
  };
}

function input(overrides: Partial<NbaInput> = {}): NbaInput {
  return {
    segment: segment(),
    orders: [],
    totalPaidCents: 0,
    totalOutstandingCents: 0,
    ...overrides,
  };
}

describe("deriveNextBestAction", () => {
  it("is NO_ACTION for a customer with a completed, fully paid order and no other signal", () => {
    const result = deriveNextBestAction(
      input({
        segment: segment({ segment: "NEW", metrics: { orderCount: 1, successfulOrderCount: 1, totalPaid: "1000.00", latestOrderAt: new Date(), daysSinceLastOrder: 2 } }),
        orders: [order()],
        totalPaidCents: 100000,
      }),
    );
    assert.equal(result.action, "NO_ACTION");
    assert.equal(result.priority, "NONE");
    assert.equal(result.recommendedChannel, "NONE");
    assert.equal(result.reason, "No immediate post-sale action is currently required.");
  });

  it("is GENERAL_FOLLOW_UP for a brand-new lead with no successful order", () => {
    const result = deriveNextBestAction(input());
    assert.equal(result.action, "GENERAL_FOLLOW_UP");
    assert.equal(result.priority, "LOW");
    assert.equal(result.recommendedChannel, "CALL");
  });

  it("is FOLLOW_UP_PAYMENT (not GENERAL_FOLLOW_UP) for a lead whose only order attempt failed - still owed money, more specific than a general nudge", () => {
    const result = deriveNextBestAction(
      input({
        orders: [order({ orderNumber: "ORD-FAILED", payments: [{ status: PaymentStatus.FAILED, amount: { toString: () => "500.00" }, refundedAmount: null }] })],
        totalOutstandingCents: 50000,
      }),
    );
    assert.equal(result.action, "FOLLOW_UP_PAYMENT");
    assert.match(result.reason, /ORD-FAILED/);
  });

  it("is GENERAL_FOLLOW_UP for a lead with zero orders (nothing owed, nothing shipped)", () => {
    const result = deriveNextBestAction(input());
    assert.equal(result.action, "GENERAL_FOLLOW_UP");
  });

  it("is FOLLOW_UP_PAYMENT when an order has an outstanding balance, and names the exact amount and order", () => {
    const unpaid = order({
      id: "order-unpaid",
      orderNumber: "ORD-UNPAID",
      totalAmount: { toString: () => "1200.00" },
      payments: [{ status: PaymentStatus.PENDING, amount: { toString: () => "1200.00" }, refundedAmount: null }],
    });
    const result = deriveNextBestAction(input({ orders: [unpaid], totalOutstandingCents: 120000 }));
    assert.equal(result.action, "FOLLOW_UP_PAYMENT");
    assert.equal(result.priority, "HIGH");
    assert.equal(result.recommendedChannel, "CALL");
    assert.equal(result.relatedOrderId, "order-unpaid");
    assert.match(result.reason, /₹1200\.00/);
    assert.match(result.reason, /ORD-UNPAID/);
  });

  it("a fully refunded order is not treated as an outstanding payment", () => {
    // Order total 1000, payment 1000 with 1000 refunded: paid=0, refunded=1000 -> outstanding = max(1000-0-1000,0) = 0 (not owed).
    const fullyRefunded = order({
      totalAmount: { toString: () => "1000.00" },
      payments: [{ status: PaymentStatus.REFUNDED, amount: { toString: () => "1000.00" }, refundedAmount: { toString: () => "1000.00" } }],
    });
    const result = deriveNextBestAction(input({ orders: [fullyRefunded] }));
    assert.notEqual(result.action, "FOLLOW_UP_PAYMENT", "a fully refunded order owes nothing further");
  });

  it("does not flag FOLLOW_UP_PAYMENT for an order with no payment recorded and zero total (nothing owed)", () => {
    const zeroOrder = order({ totalAmount: { toString: () => "0.00" }, payments: [] });
    const result = deriveNextBestAction(input({ orders: [zeroOrder] }));
    assert.notEqual(result.action, "FOLLOW_UP_PAYMENT");
  });

  it("is FOLLOW_UP_DELIVERY when an order is out for delivery", () => {
    const result = deriveNextBestAction(
      input({ orders: [order({ orderNumber: "ORD-OFD", latestShipmentStatus: "OUT_FOR_DELIVERY" })] }),
    );
    assert.equal(result.action, "FOLLOW_UP_DELIVERY");
    assert.equal(result.priority, "HIGH");
    assert.match(result.reason, /ORD-OFD/);
    assert.match(result.reason, /out for delivery/);
  });

  it("is HANDLE_RETURN when an order was returned", () => {
    const result = deriveNextBestAction(input({ orders: [order({ orderNumber: "ORD-RET", latestShipmentStatus: "RETURNED" })] }));
    assert.equal(result.action, "HANDLE_RETURN");
    assert.equal(result.priority, "HIGH");
    assert.match(result.reason, /ORD-RET/);
  });

  it("is TRACK_SHIPMENT when an order is shipped or in transit", () => {
    const shipped = deriveNextBestAction(input({ orders: [order({ latestShipmentStatus: "SHIPPED" })] }));
    assert.equal(shipped.action, "TRACK_SHIPMENT");
    assert.equal(shipped.priority, "MEDIUM");

    const inTransit = deriveNextBestAction(input({ orders: [order({ latestShipmentStatus: "IN_TRANSIT" })] }));
    assert.equal(inTransit.action, "TRACK_SHIPMENT");
  });

  it("prioritizes HANDLE_RETURN over TRACK_SHIPMENT when both a returned and an in-transit order exist", () => {
    const result = deriveNextBestAction(
      input({
        orders: [order({ id: "o1", latestShipmentStatus: "IN_TRANSIT" }), order({ id: "o2", latestShipmentStatus: "RETURNED" })],
      }),
    );
    assert.equal(result.action, "HANDLE_RETURN", "an active return problem outranks passive in-transit tracking");
  });

  it("is INTERESTED_LEAD_FOLLOW_UP for a HOT segment", () => {
    const result = deriveNextBestAction(input({ segment: segment({ segment: "HOT", reason: "..." }) }));
    assert.equal(result.action, "INTERESTED_LEAD_FOLLOW_UP");
    assert.equal(result.priority, "HIGH");
  });

  it("is RETENTION_FOLLOW_UP (LOW) for a DORMANT segment", () => {
    const result = deriveNextBestAction(input({ segment: segment({ segment: "DORMANT" }) }));
    assert.equal(result.action, "RETENTION_FOLLOW_UP");
    assert.equal(result.priority, "LOW");
  });

  it("is RETENTION_FOLLOW_UP (MEDIUM) for an AT_RISK segment - more urgent than DORMANT", () => {
    const result = deriveNextBestAction(input({ segment: segment({ segment: "AT_RISK" }) }));
    assert.equal(result.action, "RETENTION_FOLLOW_UP");
    assert.equal(result.priority, "MEDIUM");
  });

  it("is REPEAT_PURCHASE_FOLLOW_UP for a REPEAT segment", () => {
    const result = deriveNextBestAction(input({ segment: segment({ segment: "REPEAT" }) }));
    assert.equal(result.action, "REPEAT_PURCHASE_FOLLOW_UP");
    assert.equal(result.priority, "LOW");
  });

  it("is HIGH_VALUE_CUSTOMER_FOLLOW_UP for a VIP segment", () => {
    const result = deriveNextBestAction(input({ segment: segment({ segment: "VIP" }) }));
    assert.equal(result.action, "HIGH_VALUE_CUSTOMER_FOLLOW_UP");
    assert.equal(result.priority, "MEDIUM");
  });

  it("never recommends EMAIL or WHATSAPP - only CALL or NONE, since only CALL has a real write path", () => {
    for (const seg of ["NEW", "HOT", "REPEAT", "VIP", "DORMANT", "AT_RISK"] as const) {
      const result = deriveNextBestAction(input({ segment: segment({ segment: seg, metrics: { orderCount: 1, successfulOrderCount: 1, totalPaid: "0", latestOrderAt: null, daysSinceLastOrder: null } }) }));
      assert.ok(result.recommendedChannel === "CALL" || result.recommendedChannel === "NONE");
    }
  });

  describe("priority precedence with multiple simultaneous signals", () => {
    it("payment outstanding outranks an out-for-delivery order, a VIP segment, and an interested signal all at once", () => {
      const result = deriveNextBestAction(
        input({
          segment: segment({ segment: "VIP" }),
          orders: [
            order({ id: "o-ofd", latestShipmentStatus: "OUT_FOR_DELIVERY" }),
            order({ id: "o-unpaid", totalAmount: { toString: () => "500.00" }, payments: [{ status: PaymentStatus.PENDING, amount: { toString: () => "500.00" }, refundedAmount: null }] }),
          ],
          totalOutstandingCents: 50000,
        }),
      );
      assert.equal(result.action, "FOLLOW_UP_PAYMENT");
    });

    it("out-for-delivery outranks a VIP/HOT segment when there is no payment issue", () => {
      const result = deriveNextBestAction(
        input({ segment: segment({ segment: "HOT" }), orders: [order({ latestShipmentStatus: "OUT_FOR_DELIVERY" })] }),
      );
      assert.equal(result.action, "FOLLOW_UP_DELIVERY");
    });

    it("a VIP segment with no operational issue outranks what would otherwise be a plain REPEAT/general signal, because segment already resolved that exclusivity", () => {
      const result = deriveNextBestAction(input({ segment: segment({ segment: "VIP" }) }));
      assert.equal(result.action, "HIGH_VALUE_CUSTOMER_FOLLOW_UP");
    });
  });

  it("handles a customer with no orders and missing optional segment data without crashing", () => {
    const result = deriveNextBestAction(input({ segment: segment({ metrics: { orderCount: 0, successfulOrderCount: 0, totalPaid: "0.00", latestOrderAt: null, daysSinceLastOrder: null } }) }));
    assert.equal(result.action, "GENERAL_FOLLOW_UP");
    assert.equal(result.metrics.daysSinceLastOrder, null);
  });

  it("every result includes a non-empty, human-readable reason", () => {
    const scenarios: NbaInput[] = [
      input(),
      input({ orders: [order({ payments: [{ status: PaymentStatus.PENDING, amount: { toString: () => "10.00" }, refundedAmount: null }] })], totalOutstandingCents: 1000 }),
      input({ orders: [order({ latestShipmentStatus: "OUT_FOR_DELIVERY" })] }),
      input({ orders: [order({ latestShipmentStatus: "RETURNED" })] }),
      input({ orders: [order({ latestShipmentStatus: "SHIPPED" })] }),
      input({ segment: segment({ segment: "HOT" }) }),
      input({ segment: segment({ segment: "DORMANT" }) }),
      input({ segment: segment({ segment: "AT_RISK" }) }),
      input({ segment: segment({ segment: "REPEAT" }) }),
      input({ segment: segment({ segment: "VIP" }) }),
    ];
    for (const scenario of scenarios) {
      const result = deriveNextBestAction(scenario);
      assert.ok(result.reason.length > 0, `expected a reason for ${result.action}`);
    }
  });
});
