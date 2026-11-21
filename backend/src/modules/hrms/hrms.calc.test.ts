import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { aggregateLeads, aggregateOrders, aggregatePayments, aggregateProducts, aggregateSales, mergeTelecallerWindows, type LeadFact, type OrderFact, type PaymentFact, type TelecallerWindowRow } from "./hrms.aggregate.js";
import { listDays, resolveHrmsRange } from "./hrms.range.js";
import { splitWindows } from "./hrms.service.js";

// 21 Nov 2026, 13:30 IST (08:00Z)
const NOW = new Date("2026-11-21T08:00:00Z");
const r = (q: Parameters<typeof resolveHrmsRange>[0], earliest: string | null = null) => resolveHrmsRange(q, NOW, earliest);

describe("date ranges (Asia/Kolkata)", () => {
  test("presets", () => {
    const cases: [string, string, string][] = [
      ["today", "2026-11-21", "2026-11-21"],
      ["yesterday", "2026-11-20", "2026-11-20"],
      ["last_7_days", "2026-11-15", "2026-11-21"],
      ["last_30_days", "2026-10-23", "2026-11-21"],
      ["this_month", "2026-11-01", "2026-11-21"],
      ["last_month", "2026-10-01", "2026-10-31"],
    ];
    for (const [range, from, to] of cases) {
      const x = r({ range });
      assert.equal(x.from, from, range);
      assert.equal(x.to, to, range);
      assert.equal(x.timezone, "Asia/Kolkata");
    }
  });
  test("default is yesterday", () => assert.equal(r({}).from, "2026-11-20"));
  test("day boundaries are IST midnight: 00:00 IST = 18:30Z the day before", () => {
    const x = r({ range: "today" });
    assert.equal(x.start.toISOString(), "2026-11-20T18:30:00.000Z");
    assert.equal(x.end.toISOString(), "2026-11-21T18:30:00.000Z");
  });
  test("just after IST midnight is already the next IST day even though UTC is not", () => {
    const x = resolveHrmsRange({ range: "today" }, new Date("2026-11-20T18:31:00Z"));
    assert.equal(x.from, "2026-11-21");
  });
  test("last_month across a year boundary", () => {
    const x = resolveHrmsRange({ range: "last_month" }, new Date("2027-01-10T05:00:00Z"));
    assert.equal(x.from, "2026-12-01");
    assert.equal(x.to, "2026-12-31");
  });
  test("all_time starts at the earliest data day; empty CRM = today", () => {
    assert.equal(r({ range: "all_time" }, "2025-03-04").from, "2025-03-04");
    assert.equal(r({ range: "all_time" }, null).from, "2026-11-21");
  });
  test("custom accepts any length (no 92-day cap) and validates", () => {
    const x = r({ range: "custom", from: "2023-01-01", to: "2026-11-21" });
    assert.equal(x.days, 1421);
    for (const q of [{ range: "custom" }, { range: "custom", from: "2026-13-01", to: "2026-13-02" }, { range: "custom", from: "2026-11-05", to: "2026-11-01" }, { range: "custom", from: "2026-11-01", to: "2026-11-22" }, { range: "custom", from: "1999-01-01", to: "2000-01-01" }]) {
      assert.throws(() => r(q), /./);
    }
  });
  test("listDays and splitWindows cover a range exactly, in windows of at most 92 days", () => {
    assert.equal(listDays("2026-02-27", "2026-03-02").length, 4);
    const w = splitWindows("2026-01-01", "2026-12-31");
    assert.equal(w[0]!.from, "2026-01-01");
    assert.equal(w[w.length - 1]!.to, "2026-12-31");
    assert.ok(w.every((x) => listDays(x.from, x.to).length <= 92));
    assert.equal(w.reduce((a, x) => a + listDays(x.from, x.to).length, 0), 365);
  });
});

const order = (o: Partial<OrderFact> & { totalCents: number }): OrderFact => ({
  at: new Date("2026-11-20T06:00:00Z"),
  status: "CONFIRMED",
  source: "CRM",
  discountCents: 0,
  couponId: null,
  couponCode: null,
  leadSourceId: null,
  payments: [],
  items: [],
  ...o,
});
const pay = (p: Partial<OrderFact["payments"][number]> & { amountCents: number }) => ({ method: "COD", status: "PENDING", refundedCents: 0, ...p });
const days = ["2026-11-19", "2026-11-20", "2026-11-21"];

describe("sales: revenue, cancelled/refunded and collected stay distinct", () => {
  const orders: OrderFact[] = [
    order({ totalCents: 100000, payments: [pay({ method: "COD", status: "PENDING", amountCents: 100000 })] }), // COD, cash not collected
    order({ totalCents: 50000, payments: [pay({ method: "UPI", status: "SUCCESS", amountCents: 50000 })] }), // prepaid, collected
    order({ totalCents: 30000, status: "DELIVERED", payments: [pay({ method: "COD", status: "SUCCESS", amountCents: 30000 })] }), // COD, cash confirmed
    order({ totalCents: 20000, payments: [pay({ method: "UPI", status: "PARTIALLY_REFUNDED", amountCents: 20000, refundedCents: 5000 })] }), // 5000 refunded
    order({ totalCents: 70000, status: "CANCELLED" }),
    order({ totalCents: 10000, status: "RETURNED" }),
    order({ totalCents: 40000, status: "PENDING_PAYMENT" }),
    order({ totalCents: 60000, status: "REFUNDED", payments: [pay({ method: "UPI", status: "REFUNDED", amountCents: 60000, refundedCents: 60000 })] }),
  ];
  const s = aggregateSales(orders, days);
  test("counts", () => {
    assert.deepEqual(s.orders, { placed: 8, sold: 4, cancelled: 1, returned: 1, refundedInFull: 1, pendingPayment: 1 });
  });
  test("revenue is sold orders net of refunds; cancelled/returned/refunded are not in it", () => {
    assert.equal(s.revenue.gross, 2000); // 1000+500+300+200
    assert.equal(s.revenue.refunded, 50);
    assert.equal(s.revenue.net, 1950);
    assert.equal(s.revenue.averageOrderValue, 487.5);
    assert.equal(s.notSoldValue.cancelled, 700);
    assert.equal(s.notSoldValue.refundedInFull, 600);
  });
  test("collected counts only confirmed money: unconfirmed COD is outstanding", () => {
    assert.equal(s.collection.collected, 500 + 300 + 150); // UPI 500, COD confirmed 300, partially refunded UPI 200-50
    assert.equal(s.collection.outstanding, 1000);
    assert.equal(s.byPaymentMode.cod.orders, 2);
    assert.equal(s.byPaymentMode.cod.collected, 300);
    assert.equal(s.byPaymentMode.cod.outstanding, 1000);
  });
  test("byDay is zero-filled and sums to the total", () => {
    assert.deepEqual(s.byDay.map((d) => d.orders), [0, 4, 0]);
    assert.equal(s.byDay.reduce((a, d) => a + d.netRevenue, 0), s.revenue.net);
  });
  test("a day without orders has a genuine 0; no orders at all gives null average, not 0", () => {
    const e = aggregateSales([], days);
    assert.equal(e.revenue.net, 0);
    assert.equal(e.revenue.averageOrderValue, null);
  });
  test("business date: an order at 19:00Z on the 19th is the 20th in IST", () => {
    const x = aggregateSales([order({ totalCents: 1000, at: new Date("2026-11-19T19:00:00Z") })], days);
    assert.deepEqual(x.byDay.map((d) => d.orders), [0, 1, 0]);
  });
});

describe("orders", () => {
  test("status, payment status and mode", () => {
    const o = aggregateOrders(
      [order({ totalCents: 1000, payments: [pay({ method: "COD", status: "SUCCESS", amountCents: 1000 })] }), order({ totalCents: 2000, status: "CANCELLED" }), order({ totalCents: 500, status: "SHIPPED", payments: [pay({ method: "UPI", status: "SUCCESS", amountCents: 500 })] })],
      days,
    );
    assert.equal(o.placed, 3);
    assert.equal(o.totalValue, 35);
    assert.equal(o.byStatus.find((s) => s.status === "CANCELLED")!.orders, 1);
    assert.equal(o.byPaymentMode.cod, 1);
    assert.equal(o.byPaymentMode.prepaid, 1);
    assert.equal(o.fulfilment.fulfilled, 1);
    assert.equal(o.fulfilment.cancelled, 1);
    assert.equal(o.byPaymentStatus.find((s) => s.status === "NONE")!.orders, 1);
  });
});

describe("products", () => {
  test("variants roll up, custom lines are an unnamed bucket, non-sold orders are excluded", () => {
    const item = (productId: string | null, name: string, units: number, totalCents: number, custom = false) => ({ productId, name, sku: null, units, totalCents, custom });
    const p = aggregateProducts([
      order({ totalCents: 30000, items: [item("p1", "Oil", 2, 20000), item("p2", "Soap", 1, 10000)] }),
      order({ totalCents: 20000, items: [item("p1", "Oil", 1, 10000), item(null, "typed by agent Ramesh", 1, 10000, true)] }),
      order({ totalCents: 99999, status: "CANCELLED", items: [item("p1", "Oil", 9, 99999)] }),
    ]);
    assert.equal(p.soldOrders, 2);
    assert.deepEqual(p.items.map((i) => [i.name, i.unitsSold, i.orders, i.grossRevenue]), [["Oil", 3, 2, 300], ["Soap", 1, 1, 100]]);
    assert.deepEqual(p.customItems, { unitsSold: 1, orders: 1, grossRevenue: 100 });
    assert.equal(p.totals.grossRevenue, 500);
    assert.ok(!JSON.stringify(p).includes("Ramesh"));
  });
});

describe("payments", () => {
  const d = (s: string) => new Date(s);
  const base = (x: Partial<PaymentFact> & { amountCents: number }): PaymentFact => ({ status: "SUCCESS", method: "UPI", provider: "CASHFREE", refundedCents: 0, paidAt: null, failedAt: null, refundedAt: null, createdAt: d("2026-11-20T05:00:00Z"), ...x });
  const start = d("2026-11-19T18:30:00Z");
  const end = d("2026-11-20T18:30:00Z");
  const a = aggregatePayments(
    [
      base({ amountCents: 100000, paidAt: d("2026-11-20T05:00:00Z") }),
      base({ amountCents: 50000, method: "COD", provider: null, paidAt: d("2026-11-20T10:00:00Z") }),
      base({ amountCents: 70000, method: "COD", status: "PENDING", createdAt: d("2026-11-20T04:00:00Z") }), // not collected
      base({ amountCents: 20000, status: "FAILED", failedAt: d("2026-11-20T03:00:00Z") }),
      base({ amountCents: 40000, status: "PARTIALLY_REFUNDED", refundedCents: 10000, paidAt: d("2026-11-20T02:00:00Z"), refundedAt: d("2026-11-20T09:00:00Z") }),
      base({ amountCents: 15000, paidAt: d("2026-11-10T02:00:00Z"), createdAt: d("2026-11-10T02:00:00Z") }), // paid before the range
      base({ amountCents: 12345 }), // confirmed but no paidAt
    ],
    start,
    end,
    ["2026-11-20"],
  );
  test("captured excludes unconfirmed COD, failed and out-of-range", () => {
    assert.equal(a.captured.amount, 1000 + 500 + 400);
    assert.equal(a.captured.payments, 3);
  });
  test("refunds, net, pending, failed", () => {
    assert.equal(a.refunds.amount, 100);
    assert.equal(a.net, 1900 - 100);
    assert.equal(a.pending.cod.amount, 700);
    assert.equal(a.failed.amount, 200);
  });
  test("undated confirmed money is reported separately, never dropped into a day", () => {
    assert.equal(a.undated.capturedAmount, 123.45);
    assert.equal(a.byDay[0]!.captured, 1900);
  });
});

describe("leads", () => {
  const lead = (x: Partial<LeadFact>): LeadFact => ({ createdAt: new Date("2026-11-20T06:00:00Z"), workingStatus: "NEW", lifecycleStage: "NEW", ownerId: "u1", sourceId: "s1", contacted: false, ...x });
  const l = aggregateLeads([lead({}), lead({ workingStatus: "CONVERTED", contacted: true }), lead({ workingStatus: "DEACTIVATED", ownerId: null }), lead({ sourceId: null, workingStatus: "CONVERTED" })], [{ id: "s1", name: "Meta Ads", type: "META" }], days);
  test("conversion excludes deactivated leads", () => {
    assert.equal(l.newLeads, 4);
    assert.equal(l.workable, 3);
    assert.equal(l.converted, 2);
    assert.equal(l.conversionRate, 66.67);
    assert.equal(l.unassigned, 1);
  });
  test("by source, including leads with no source", () => {
    assert.deepEqual(l.bySource.map((s) => [s.name, s.newLeads, s.converted]), [["Meta Ads", 3, 1], ["No source", 1, 1]]);
  });
  test("no leads: conversion rate null, not 0", () => assert.equal(aggregateLeads([], [], days).conversionRate, null));
});

describe("telecaller windows", () => {
  const row = (o: Partial<TelecallerWindowRow>): TelecallerWindowRow => ({
    id: "u1", name: "Asha", accountStatus: "ACTIVE", leads: 1, contacted: 1, interested: 0, converted: 0, calls: 10, connected: 6, notConnected: 3, failed: 1, uniqueLeads: 4, talkTimeSec: 600, productiveMs: 1000,
    orders: 1, codOrders: 1, prepaidOrders: 0, assistedOrders: 0, revenue: 1000, assistedRevenue: 0, collected: 400, codRevenue: 1000, codCollected: 400, prepaidRevenue: 0, prepaidCollected: 0, ...o,
  });
  test("one window keeps uniqueLeadsCalled; several windows add up and null it", () => {
    const one = mergeTelecallerWindows([[row({})]]);
    assert.equal(one[0]!.employeeId, "u1");
    assert.equal(JSON.stringify(one).includes("username"), false);
    const many = mergeTelecallerWindows([[row({})], [row({ revenue: 500, calls: 5 })]]);
    assert.equal(many.length, 1);
    assert.equal(JSON.stringify(many[0]).includes('"uniqueLeadsCalled":null'), true);
  });
});
