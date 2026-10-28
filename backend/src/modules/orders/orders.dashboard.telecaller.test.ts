import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderStatus } from "../../../generated/prisma/enums.js";
import { addSale, emptySales, salesOut, type SoldOrder } from "../manager/manager.sales.js";
import { summarizeTelecaller } from "./orders.dashboard.telecaller.js";
import { resolveDashboardRange, tzOffsetOf } from "./orders.dashboard.range.js";
import { validateTelecaller } from "./orders.dashboard.validators.js";

type S = Pick<SoldOrder, "cents" | "collectedCents" | "mode" | "credit" | "status" | "paymentStatus">;
const s = (over: Partial<S>): S => ({ cents: 100_000, collectedCents: 0, mode: "COD", credit: "CONFIRMED", status: OrderStatus.CONFIRMED, paymentStatus: null, ...over });
const sold: S[] = [
  s({ cents: 69_900, mode: "COD" }), // COD, not collected
  s({ cents: 69_900, mode: "COD", collectedCents: 69_900, paymentStatus: "SUCCESS", status: OrderStatus.DELIVERED }), // COD collected + delivered
  s({ cents: 77_800, collectedCents: 77_800, mode: "PREPAID", paymentStatus: "SUCCESS", credit: "ASSISTED", status: OrderStatus.SHIPPED }),
  s({ cents: 70_000, collectedCents: 70_000, mode: "PREPAID", paymentStatus: "PARTIALLY_REFUNDED", credit: "ASSISTED" }), // net of a refund already
  s({ cents: 50_000, mode: null, paymentStatus: "PENDING" }), // no payment method yet: in totals, in neither split
];

describe("Telecaller Performance uses the Reports' own tallies", () => {
  const reports = salesOut((() => { const t = emptySales(); for (const x of sold) addSale(t, x); return t; })());
  const { summary: m, invalidAmounts } = summarizeTelecaller(sold);

  it("orders, COD / prepaid counts, the three revenues and collected are exactly Reports' for the same orders", () => {
    assert.deepEqual([m.totalOrders, m.cod, m.prepaid], [reports.orders, reports.codOrders, reports.prepaidOrders]);
    assert.deepEqual([m.totalRevenue, m.codRevenue, m.prepaidRevenue, m.collected], [reports.revenue, reports.codRevenue, reports.prepaidRevenue, reports.collected]);
    assert.equal(m.assistedOrders, reports.assistedOrders);
    assert.equal(invalidAmounts, 0);
  });
  it("COD and prepaid are separate, and an order with no payment method is in the total only", () => {
    assert.deepEqual([m.cod, m.prepaid, m.totalOrders], [2, 2, 5]);
    assert.equal(m.codRevenue + m.prepaidRevenue + 500, m.totalRevenue);
  });
  it("paid + pending = total; fulfilled counts shipped / delivered; each order once", () => {
    assert.deepEqual([m.paid, m.pendingPayment, m.paid + m.pendingPayment], [3, 2, 5]);
    assert.equal(m.fulfilled, 2);
    assert.deepEqual([m.confirmedOrders, m.assistedOrders], [3, 2]);
  });
  it("a missing / invalid amount is left out and reported - never counted as a fake zero, never NaN", () => {
    const r = summarizeTelecaller([...sold, s({ cents: Number.NaN }), s({ collectedCents: Number.POSITIVE_INFINITY })]);
    assert.equal(r.invalidAmounts, 2);
    assert.deepEqual(r.summary, m);
    for (const v of Object.values(r.summary)) assert.ok(Number.isFinite(v));
  });
  it("an empty set is a valid all-zero summary", () => {
    const r = summarizeTelecaller([]);
    assert.ok(Object.values(r.summary).every((v) => v === 0));
    assert.equal(r.invalidAmounts, 0);
  });
});

describe("date range and filters", () => {
  it("the dashboard's India-time range becomes the Reports' offset window (UTC+5:30)", () => {
    const r = resolveDashboardRange({ range: "custom", from: "2026-10-27", to: "2026-10-27" }, new Date("2026-10-28T06:00:00Z"));
    assert.equal(tzOffsetOf(r), 330);
    assert.equal(r.start.toISOString(), "2026-10-26T18:30:00.000Z"); // 27 Oct 00:00 IST
  });
  it("accepts the Reports' filters and rejects unknown values", () => {
    assert.ok(!validateTelecaller({ range: "yesterday", paymentMode: "COD", orderStatus: "DELIVERED" }).error);
    for (const bad of [{ paymentMode: "CARD" }, { orderStatus: "CANCELLED" }, { salespersonId: "x" }, { range: "never" }]) assert.ok(validateTelecaller(bad).error, JSON.stringify(bad));
  });
});
