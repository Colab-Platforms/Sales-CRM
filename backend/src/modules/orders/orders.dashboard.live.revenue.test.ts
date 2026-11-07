import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import { summarize } from "./orders.dashboard.live.metrics.js";
import type { LiveOrder } from "./orders.dashboard.live.source.js";

const o = (over: Partial<LiveOrder>): LiveOrder => ({ externalId: "1", name: "#1", createdAt: new Date("2026-10-27T05:00:00Z"), localDate: "2026-10-27", customerName: null, phone: null, currency: "INR", totalCents: 100_000, refundedCents: 0, status: OrderStatus.CONFIRMED, paymentStatus: null, paymentMode: null, ...over });

describe("website dashboard summary: the revenue / collected cards always have a number", () => {
  const orders = [
    o({ externalId: "1", paymentMode: "COD", totalCents: 69_900 }),
    o({ externalId: "2", paymentMode: "COD", totalCents: 50_000, status: OrderStatus.CANCELLED }), // cancelled: not revenue
    o({ externalId: "3", paymentMode: "PREPAID", totalCents: 77_800, paymentStatus: PaymentStatus.SUCCESS }),
    o({ externalId: "4", paymentMode: "PREPAID", totalCents: 100_000, paymentStatus: PaymentStatus.PARTIALLY_REFUNDED, refundedCents: 30_000 }),
    o({ externalId: "5", paymentMode: "PREPAID", totalCents: 20_000, paymentStatus: PaymentStatus.PENDING }), // not collected
    o({ externalId: "6", paymentMode: "COD", totalCents: 10_000, currency: "USD" }), // never valued
  ];
  const s = summarize(orders);
  it("COD and prepaid revenue are separate and exclude cancelled orders", () => {
    assert.equal(s.codRevenue, 699);
    assert.equal(s.prepaidRevenue, 778 + 1000 + 200);
  });
  it("collected = paid in full + partially refunded net of the refund; pending is not collected", () => assert.equal(s.collected, 778 + 700));
  it("every summary number is a finite number (the cause of '₹NaN' was these three being undefined)", () => {
    for (const [k, v] of Object.entries(s)) assert.ok(typeof v === "number" && Number.isFinite(v), k);
    for (const k of ["codRevenue", "prepaidRevenue", "collected"]) assert.ok(k in s);
  });
  it("the pre-existing figures are exactly what they were", () => {
    assert.deepEqual([s.totalOrders, s.cod, s.prepaid, s.paid, s.pendingPayment, s.cancelled], [6, 3, 3, 1, 1, 1]);
    assert.equal(s.totalValue, (69_900 + 77_800 + 100_000 + 20_000) / 100);
  });
  it("an empty selection is a valid all-zero summary", () => {
    assert.deepEqual(summarize([]), { totalOrders: 0, totalValue: 0, cod: 0, prepaid: 0, paid: 0, pendingPayment: 0, cancelled: 0, cancelledValue: 0, fulfilled: 0, codRevenue: 0, prepaidRevenue: 0, collected: 0 });
  });
});
