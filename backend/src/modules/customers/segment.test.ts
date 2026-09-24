import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentStatus } from "../../../generated/prisma/enums.js";
import { SEGMENT_THRESHOLDS } from "./segment.config.js";
import { deriveCustomerSegment, type SegmentInput, type SegmentOrderInput } from "./segment.js";

const NOW = new Date("2026-09-20T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function order(daysAgoCreated: number, status: PaymentStatus | null): SegmentOrderInput {
  return { createdAt: daysAgo(daysAgoCreated), payments: status ? [{ status }] : [] };
}

function input(overrides: Partial<SegmentInput> = {}): SegmentInput {
  return {
    workingStatus: "NEW",
    hasActiveInterestedPeriod: false,
    orders: [],
    totalPaidCents: 0,
    now: NOW,
    ...overrides,
  };
}

describe("deriveCustomerSegment", () => {
  it("is NEW for a brand-new lead with no orders and no interest signal", () => {
    const result = deriveCustomerSegment(input());
    assert.equal(result.segment, "NEW");
    assert.equal(result.reason, "Customer has no completed repeat order yet.");
    assert.deepEqual(result.metrics, { orderCount: 0, successfulOrderCount: 0, totalPaid: "0.00", latestOrderAt: null, daysSinceLastOrder: null });
  });

  it("is NEW for a lead with only a failed or pending payment (never actually paid)", () => {
    const failed = deriveCustomerSegment(input({ orders: [order(5, PaymentStatus.FAILED)] }));
    assert.equal(failed.segment, "NEW");
    assert.equal(failed.metrics.successfulOrderCount, 0);

    const pending = deriveCustomerSegment(input({ orders: [order(5, PaymentStatus.PENDING)] }));
    assert.equal(pending.segment, "NEW");
  });

  it("is NEW for a lead whose only order has no payment record at all", () => {
    const result = deriveCustomerSegment(input({ orders: [order(5, null)] }));
    assert.equal(result.segment, "NEW");
    assert.equal(result.metrics.orderCount, 1);
    assert.equal(result.metrics.successfulOrderCount, 0);
  });

  it("is HOT when the lead's working status is INTERESTED, even with no orders", () => {
    const result = deriveCustomerSegment(input({ workingStatus: "INTERESTED" }));
    assert.equal(result.segment, "HOT");
    assert.match(result.reason, /high-intent/);
  });

  it("is HOT when there is an active InterestedLeadPeriod, regardless of working status", () => {
    const result = deriveCustomerSegment(input({ workingStatus: "FOLLOW_UP", hasActiveInterestedPeriod: true }));
    assert.equal(result.segment, "HOT");
  });

  it("is REPEAT once a second order actually collects money", () => {
    const result = deriveCustomerSegment(
      input({ orders: [order(5, PaymentStatus.SUCCESS), order(30, PaymentStatus.SUCCESS)] }),
    );
    assert.equal(result.segment, "REPEAT");
    assert.equal(result.reason, "Customer has completed more than one successful order.");
    assert.equal(result.metrics.successfulOrderCount, 2);
  });

  it("a partially refunded order still counts toward REPEAT (money was collected), a fully refunded one does not", () => {
    const partial = deriveCustomerSegment(
      input({ orders: [order(5, PaymentStatus.SUCCESS), order(30, PaymentStatus.PARTIALLY_REFUNDED)] }),
    );
    assert.equal(partial.segment, "REPEAT");

    const fullyRefunded = deriveCustomerSegment(
      input({ orders: [order(5, PaymentStatus.SUCCESS), order(30, PaymentStatus.REFUNDED)] }),
    );
    assert.equal(fullyRefunded.segment, "NEW", "only one order ever actually collected money");
    assert.equal(fullyRefunded.metrics.successfulOrderCount, 1);
  });

  it("is VIP once total paid crosses the configured threshold, even with a single order", () => {
    const result = deriveCustomerSegment(input({ orders: [order(5, PaymentStatus.SUCCESS)], totalPaidCents: SEGMENT_THRESHOLDS.vipMinTotalPaidCents }));
    assert.equal(result.segment, "VIP");
    assert.match(result.reason, /high-value/);
  });

  it("is not yet VIP one rupee below the threshold", () => {
    const result = deriveCustomerSegment(input({ orders: [order(5, PaymentStatus.SUCCESS)], totalPaidCents: SEGMENT_THRESHOLDS.vipMinTotalPaidCents - 1 }));
    assert.notEqual(result.segment, "VIP");
  });

  it("is VIP by order frequency alone, even with low total spend", () => {
    const orders = Array.from({ length: SEGMENT_THRESHOLDS.vipMinSuccessfulOrders }, (_, i) => order(5 + i, PaymentStatus.SUCCESS));
    const result = deriveCustomerSegment(input({ orders, totalPaidCents: 100 }));
    assert.equal(result.segment, "VIP");
  });

  it("VIP overrides HOT, DORMANT and AT_RISK - it is a persistent value tier", () => {
    const vipButInterested = deriveCustomerSegment(
      input({ workingStatus: "INTERESTED", orders: [order(5, PaymentStatus.SUCCESS)], totalPaidCents: SEGMENT_THRESHOLDS.vipMinTotalPaidCents }),
    );
    assert.equal(vipButInterested.segment, "VIP");

    const vipButDormant = deriveCustomerSegment(
      input({ orders: [order(200, PaymentStatus.SUCCESS)], totalPaidCents: SEGMENT_THRESHOLDS.vipMinTotalPaidCents }),
    );
    assert.equal(vipButDormant.segment, "VIP");
  });

  it("is AT_RISK exactly at the configured boundary, and not yet at one day fewer", () => {
    const atBoundary = deriveCustomerSegment(input({ orders: [order(SEGMENT_THRESHOLDS.atRiskMinDaysSinceLastOrder, PaymentStatus.SUCCESS)] }));
    assert.equal(atBoundary.segment, "AT_RISK");

    const oneDayBefore = deriveCustomerSegment(input({ orders: [order(SEGMENT_THRESHOLDS.atRiskMinDaysSinceLastOrder - 1, PaymentStatus.SUCCESS)] }));
    assert.notEqual(oneDayBefore.segment, "AT_RISK");
  });

  it("is DORMANT exactly at the configured boundary, taking precedence over AT_RISK", () => {
    const atBoundary = deriveCustomerSegment(input({ orders: [order(SEGMENT_THRESHOLDS.dormantMinDaysSinceLastOrder, PaymentStatus.SUCCESS)] }));
    assert.equal(atBoundary.segment, "DORMANT");

    const oneDayBefore = deriveCustomerSegment(input({ orders: [order(SEGMENT_THRESHOLDS.dormantMinDaysSinceLastOrder - 1, PaymentStatus.SUCCESS)] }));
    assert.equal(oneDayBefore.segment, "AT_RISK");
  });

  it("HOT takes precedence over DORMANT/AT_RISK - a re-engaged customer is not shown as merely inactive", () => {
    const result = deriveCustomerSegment(
      input({ workingStatus: "INTERESTED", orders: [order(SEGMENT_THRESHOLDS.dormantMinDaysSinceLastOrder + 10, PaymentStatus.SUCCESS)] }),
    );
    assert.equal(result.segment, "HOT");
  });

  it("never applies AT_RISK/DORMANT to a lead that has never actually paid", () => {
    const result = deriveCustomerSegment(input({ orders: [order(500, PaymentStatus.FAILED)] }));
    assert.equal(result.segment, "NEW", "no successful order ever, so there is nothing to be 'at risk' of losing");
  });

  it("uses the most recent order's date across several orders of mixed age", () => {
    const result = deriveCustomerSegment(
      input({ orders: [order(200, PaymentStatus.SUCCESS), order(10, PaymentStatus.SUCCESS), order(90, PaymentStatus.FAILED)] }),
    );
    assert.equal(result.metrics.daysSinceLastOrder, 10);
    assert.equal(result.segment, "REPEAT");
  });
});
