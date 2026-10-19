import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderStatus } from "../../../generated/prisma/enums.js";
import { addSale, ASSIST_WINDOW_DAYS, creditFor, csvCell, emptySales, mergeSales, ordersCsv, salesOut, SOLD_STATUSES, type SoldOrder } from "./manager.sales.js";

const order = (over: Partial<SoldOrder> = {}): SoldOrder => ({
  id: "o1",
  orderNumber: "CRM-1",
  externalNumber: null,
  source: "CRM",
  status: OrderStatus.CONFIRMED,
  currency: "INR",
  userId: "u1",
  credit: "CONFIRMED",
  at: new Date("2026-10-15T20:00:00.000Z"), // 01:30 on Oct 16 in IST
  totalCents: 69_900,
  refundedCents: 0,
  cents: 69_900,
  collectedCents: 0,
  mode: "COD",
  paymentStatus: "PENDING",
  items: [{ key: "p1", name: "Masala", sku: "M1", units: 2, cents: 69_900 }],
  ...over,
});

describe("sales tallies", () => {
  it("only sold statuses are eligible; cancelled, returned and refunded never are", () => {
    for (const s of [OrderStatus.CANCELLED, OrderStatus.RETURNED, OrderStatus.REFUNDED, OrderStatus.DRAFT, OrderStatus.PENDING_PAYMENT]) {
      assert.ok(!SOLD_STATUSES.includes(s), s);
    }
  });

  it("zero orders gives zeros, never NaN or Infinity", () => {
    const out = salesOut(emptySales());
    assert.deepEqual(out, {
      orders: 0, codOrders: 0, prepaidOrders: 0, revenue: 0, assistedOrders: 0, assistedRevenue: 0, collected: 0, codRevenue: 0, codCollected: 0, prepaidRevenue: 0, prepaidCollected: 0, aov: 0,
    });
  });

  it("splits COD / Prepaid, keeps unknown-payment orders in the totals only, and computes AOV from order value", () => {
    const t = emptySales();
    addSale(t, { cents: 69_900, collectedCents: 0, mode: "COD" }); // COD not yet collected
    addSale(t, { cents: 64_900, collectedCents: 64_900, mode: "PREPAID" });
    addSale(t, { cents: 10_001, collectedCents: 0, mode: null });
    const out = salesOut(t);
    assert.equal(out.orders, 3);
    assert.equal(out.codOrders, 1);
    assert.equal(out.prepaidOrders, 1);
    assert.equal(out.revenue, 1448.01);
    assert.equal(out.codRevenue, 699);
    assert.equal(out.codCollected, 0, "COD order value is not cash until its payment is SUCCESS");
    assert.equal(out.collected, 649);
    assert.equal(out.aov, 482.67); // 1448.01 / 3, rounded to the paisa
  });

  it("merging per-person tallies equals tallying everything at once (no double counting)", () => {
    const a = emptySales();
    const b = emptySales();
    const all = emptySales();
    const sales = [
      { cents: 100, collectedCents: 100, mode: "PREPAID" as const },
      { cents: 250, collectedCents: 0, mode: "COD" as const },
      { cents: 75, collectedCents: 75, mode: "COD" as const },
    ];
    addSale(a, sales[0]);
    addSale(b, sales[1]);
    addSale(b, sales[2]);
    sales.forEach((s) => addSale(all, s));
    mergeSales(a, b);
    assert.deepEqual(a, all);
  });
});

describe("orders CSV", () => {
  it("neutralises spreadsheet formulas in text cells but leaves numbers alone", () => {
    assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell("+91 98765"), "'+91 98765");
    assert.equal(csvCell("-cmd"), "'-cmd");
    assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(csvCell("Priti"), "Priti");
    assert.equal(csvCell(-12.5), "-12.5");
    assert.equal(csvCell(Number.NaN), "");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell("a,b"), `"a,b"`);
  });

  it("writes a UTF-8 BOM, one row per order, IST dates, and no customer contact fields", () => {
    const csv = ordersCsv(
      [order(), order({ id: "o2", orderNumber: "=evil", mode: "PREPAID", collectedCents: 69_900, paymentStatus: "SUCCESS" })],
      new Map([["u1", "Priti"]]),
      330,
    );
    assert.ok(csv.startsWith("﻿"));
    const lines = csv.slice(1).trim().split("\r\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^Order Number,Shopify Number,Sale At \(IST\),Business Date,Salesperson,Credit,/);
    assert.doesNotMatch(lines[0], /phone|email|address|customer/i);
    assert.match(lines[1], /^CRM-1,,2026-10-16 01:30:00,2026-10-16,Priti,Confirmed in CRM,CONFIRMED,COD,PENDING,CRM,INR,1,2,699,0,699,0,699$/);
    assert.match(lines[2], /^'=evil,.*,Prepaid,SUCCESS,.*,699,0,699,699,0$/);
  });
});

describe("who a sale is credited to", () => {
  const sale = new Date("2026-10-19T08:00:00.000Z");
  const daysBefore = (d: number) => new Date(sale.getTime() - d * 24 * 60 * 60_000);
  const shopify = { at: sale, confirmedBy: null, confirmedByAnySalesperson: false };

  it("a CRM confirmation by the team always wins", () => {
    const c = creditFor({ at: sale, confirmedBy: "rustam", confirmedByAnySalesperson: true }, [{ userId: "priti", at: daysBefore(1) }]);
    assert.deepEqual(c, { userId: "rustam", credit: "CONFIRMED" });
  });

  it("a Shopify order after a telecaller's call is credited to them as ASSISTED", () => {
    assert.deepEqual(creditFor(shopify, [{ userId: "priti", at: daysBefore(2) }]), { userId: "priti", credit: "ASSISTED" });
  });

  it("the most recent contact before the sale wins; contact after the sale does not count", () => {
    const touches = [
      { userId: "priti", at: daysBefore(5) },
      { userId: "roshni", at: daysBefore(1) },
      { userId: "yash", at: new Date(sale.getTime() + 60_000) },
    ];
    assert.equal(creditFor(shopify, touches)?.userId, "roshni");
  });

  it("contact older than the window, or no contact at all, earns nothing", () => {
    assert.equal(creditFor(shopify, [{ userId: "priti", at: daysBefore(ASSIST_WINDOW_DAYS + 1) }]), null);
    assert.equal(creditFor(shopify, []), null);
  });

  it("an order another team's telecaller confirmed is never re-credited here", () => {
    assert.equal(creditFor({ at: sale, confirmedBy: null, confirmedByAnySalesperson: true }, [{ userId: "priti", at: daysBefore(1) }]), null);
  });

  it("assisted sales are tallied separately inside the totals", () => {
    const t = emptySales();
    addSale(t, { cents: 50_000, collectedCents: 0, mode: "COD", credit: "CONFIRMED" });
    addSale(t, { cents: 70_000, collectedCents: 0, mode: "COD", credit: "ASSISTED" });
    const out = salesOut(t);
    assert.equal(out.orders, 2);
    assert.equal(out.assistedOrders, 1);
    assert.equal(out.assistedRevenue, 700);
  });
});
