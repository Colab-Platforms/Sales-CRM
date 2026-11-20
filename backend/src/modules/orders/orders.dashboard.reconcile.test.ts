// The Website Orders figures reconcile, and the WhatsApp report's website numbers ARE the dashboard's numbers (one summary, mapped - never recomputed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import { summarize } from "./orders.dashboard.live.metrics.js";
import type { LiveOrder } from "./orders.dashboard.live.source.js";
import { buildStructuredValues } from "../report-automation/report-automation.template-metrics.js";

let n = 0;
const order = (over: Partial<LiveOrder>): LiveOrder => ({ externalId: `id${++n}`, name: `#T${n}`, createdAt: new Date("2026-11-18T05:00:00Z"), localDate: "2026-11-18", customerName: null, phone: null, currency: "INR", totalCents: 100_00, refundedCents: 0, status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.SUCCESS, paymentMode: "PREPAID", ...over });
const prepaid = (c: number, over: Partial<LiveOrder> = {}) => order({ totalCents: c, paymentStatus: PaymentStatus.SUCCESS, paymentMode: "PREPAID", ...over });
const cod = (c: number, over: Partial<LiveOrder> = {}) => order({ totalCents: c, paymentStatus: PaymentStatus.PENDING, paymentMode: "COD", ...over });
const free = () => order({ totalCents: 0, paymentStatus: null, paymentMode: null });

describe("website order figures reconcile", () => {
  const day = [prepaid(500_00), prepaid(250_00), cod(300_00), cod(150_00), cod(549_00, { status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.FAILED }), free()];
  const s = summarize(day);

  it("COD + prepaid + other (no payment method) = total orders", () => {
    assert.equal(s.totalOrders, 6);
    assert.equal(s.cod, 3);
    assert.equal(s.prepaid, 2);
    assert.equal(s.otherPayment, 1);
    assert.equal(s.cod + s.prepaid + s.otherPayment, s.totalOrders);
  });

  it("revenue excludes cancelled orders and is the sum of COD revenue + prepaid revenue (a zero-value order adds nothing)", () => {
    assert.equal(s.cancelled, 1);
    assert.equal(s.cancelledValue, 549);
    assert.equal(s.totalValue, 500 + 250 + 300 + 150);
    assert.equal(s.codRevenue + s.prepaidRevenue, s.totalValue);
  });

  it("a cancelled order stays in the order count and in its COD / prepaid count, but never in revenue", () => {
    const only = summarize([cod(549_00, { status: OrderStatus.CANCELLED })]);
    assert.deepEqual([only.totalOrders, only.cod, only.totalValue, only.codRevenue], [1, 1, 0, 0]);
  });

  it("an empty day reconciles at zero", () => {
    const z = summarize([]);
    assert.deepEqual([z.totalOrders, z.cod, z.prepaid, z.otherPayment, z.totalValue], [0, 0, 0, 0, 0]);
  });
});

describe("the WhatsApp summary is the dashboard's summary", () => {
  it("every website figure in the message is the dashboard card, with revenue in whole rupees (Indian grouping, no sign - the template carries it)", () => {
    const orders = [prepaid(1_20_000_00), cod(60_137_00), cod(5_000_00)];
    const s = summarize(orders);
    const v = buildStructuredValues("18 Nov 2026", { website: { totalOrders: s.totalOrders, totalRevenue: s.totalValue, codOrders: s.cod, prepaidOrders: s.prepaid }, abandoned: null });
    assert.deepEqual([v.web_total_orders, v.web_cod_orders, v.web_prepaid_orders, v.web_total_revenue], [String(s.totalOrders), String(s.cod), String(s.prepaid), "1,85,137"]);
    assert.equal(Number(v.web_cod_orders) + Number(v.web_prepaid_orders), Number(v.web_total_orders), "reconciles when no order lacks a payment method");
  });
});
