import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyOrderFilters, hasOverlayFilters } from "./orders.live.service.js";
import { validateLiveOrdersQuery } from "./orders.live.validators.js";
import type { LiveOrderListItem } from "./orders.live.types.js";

const SP_A = "0b5a7b6e-3c1d-4d6a-8f21-1c2d3e4f5a6b";
const SP_B = "1b5a7b6e-3c1d-4d6a-8f21-1c2d3e4f5a6b";
const LS_META = "2b5a7b6e-3c1d-4d6a-8f21-1c2d3e4f5a6b";
const LS_WA = "3b5a7b6e-3c1d-4d6a-8f21-1c2d3e4f5a6b";

const item = (over: Partial<LiveOrderListItem> & { id: string }): LiveOrderListItem => ({
  orderNumber: `#${over.id}`, status: "CONFIRMED", source: "SHOPIFY", currency: "INR", totalAmount: "699.00", itemCount: 1, paymentStatus: "PENDING", paymentMode: "COD", externalNumber: null,
  createdAt: new Date("2026-10-05T10:00:00Z"), customer: { leadId: null, leadNumber: null, name: "Pawa Kumar" }, salesperson: null, leadSource: null, linkedInCrm: true, fulfillmentStatus: "UNFULFILLED", hasTracking: false, shippingMethod: null,
  ...over,
} as LiveOrderListItem);

const ORDERS: LiveOrderListItem[] = [
  item({ id: "1", paymentMode: "COD", paymentStatus: "PENDING", source: "SHOPIFY", status: "CONFIRMED", fulfillmentStatus: "UNFULFILLED", totalAmount: "699.00", salesperson: { id: SP_A, name: "A" }, leadSource: { id: LS_META, name: "Meta" } }),
  item({ id: "2", paymentMode: "PREPAID", paymentStatus: "SUCCESS", source: "SHOPIFY", status: "DELIVERED", fulfillmentStatus: "FULFILLED", totalAmount: "1249.00", salesperson: { id: SP_B, name: "B" }, leadSource: { id: LS_WA, name: "WhatsApp" } }),
  item({ id: "3", paymentMode: "COD", paymentStatus: "PENDING", source: "SALESPERSON", status: "CONFIRMED", fulfillmentStatus: "UNFULFILLED", totalAmount: "2600.00", salesperson: { id: SP_A, name: "A" }, leadSource: { id: LS_WA, name: "WhatsApp" } }),
  item({ id: "4", paymentMode: "PREPAID", paymentStatus: "REFUNDED", source: "SHOPIFY", status: "RETURNED", fulfillmentStatus: "FULFILLED", totalAmount: "300.00" }),
  item({ id: "5", paymentMode: null, paymentStatus: null, source: "SHOPIFY", status: "PENDING_PAYMENT", fulfillmentStatus: null, totalAmount: "1000.00", linkedInCrm: false }),
];
const ids = (f: Parameters<typeof applyOrderFilters>[1]) => applyOrderFilters(ORDERS, f).map((o) => o.id);

describe("applyOrderFilters (column filters)", () => {
  it("no filters returns every row", () => {
    assert.equal(hasOverlayFilters({}), false);
    assert.deepEqual(ids({}), ["1", "2", "3", "4", "5"]);
  });
  it("Payment: COD / Prepaid", () => {
    assert.deepEqual(ids({ paymentMode: ["COD"] }), ["1", "3"]);
    assert.deepEqual(ids({ paymentMode: ["PREPAID"] }), ["2", "4"]);
    assert.deepEqual(ids({ paymentMode: "COD" }), ["1", "3"], "a single value (older callers) still works");
  });
  it("Payment status: pending / refunded / no payment (unpaid)", () => {
    assert.deepEqual(ids({ paymentStatus: ["PENDING"] }), ["1", "3"]);
    assert.deepEqual(ids({ paymentStatus: ["REFUNDED"] }), ["4"]);
    assert.deepEqual(ids({ paymentStatus: ["NONE"] }), ["5"]);
  });
  it("Order source, Status, Fulfilment, Salesperson, Lead source", () => {
    assert.deepEqual(ids({ source: ["SALESPERSON"] }), ["3"]);
    assert.deepEqual(ids({ status: ["DELIVERED", "RETURNED"] }), ["2", "4"]);
    assert.deepEqual(ids({ fulfillment: ["UNFULFILLED"] }), ["1", "3"]);
    assert.deepEqual(ids({ salespersonId: [SP_A] }), ["1", "3"]);
    assert.deepEqual(ids({ leadSourceId: [LS_WA] }), ["2", "3"]);
  });
  it("Total range uses the numeric total (inclusive ends, open ends)", () => {
    assert.deepEqual(ids({ totalMin: 0, totalMax: 500 }), ["4"]);
    assert.deepEqual(ids({ totalMin: 500, totalMax: 1000 }), ["1", "5"]);
    assert.deepEqual(ids({ totalMin: 1000, totalMax: 2500 }), ["2", "5"]);
    assert.deepEqual(ids({ totalMin: 2500 }), ["3"]);
    assert.deepEqual(ids({ totalMax: 699 }), ["1", "4"]);
  });
  it("different filters are AND-ed: COD + Shopify + Unfulfilled", () => {
    assert.deepEqual(ids({ paymentMode: ["COD"], source: ["SHOPIFY"], fulfillment: ["UNFULFILLED"] }), ["1"]);
    assert.deepEqual(ids({ paymentMode: ["COD"], source: ["SHOPIFY"], fulfillment: ["FULFILLED"] }), []);
  });
  it("values inside one filter are OR-ed, then AND-ed with the others: (COD or Prepaid) and Shopify", () => {
    assert.deepEqual(ids({ paymentMode: ["COD", "PREPAID"], source: ["SHOPIFY"] }), ["1", "2", "4"]);
    assert.deepEqual(ids({ status: ["CONFIRMED", "DELIVERED"], paymentMode: ["COD"] }), ["1", "3"]);
  });
  it("a row with no value for a filtered field never matches it (an unsynced order has no salesperson / lead source)", () => {
    assert.ok(!ids({ salespersonId: [SP_A, SP_B] }).includes("5"));
    assert.ok(!ids({ leadSourceId: [LS_META, LS_WA] }).includes("4"));
  });
});

describe("live orders query validation (URL/API filter values)", () => {
  const ok = (q: Record<string, unknown>) => validateLiveOrdersQuery({ first: "25", ...q });
  it("accepts comma lists and single values, and drops empties", () => {
    const r = ok({ status: "CONFIRMED,SHIPPED", paymentMode: "COD", source: "SHOPIFY,SALESPERSON", paymentStatus: "PENDING,NONE", fulfillment: "UNFULFILLED" });
    assert.equal(r.error, null);
    assert.deepEqual(r.value?.status, ["CONFIRMED", "SHIPPED"]);
    assert.deepEqual(r.value?.paymentMode, ["COD"]);
    assert.deepEqual(r.value?.paymentStatus, ["PENDING", "NONE"]);
    assert.equal(ok({ status: "" }).value?.status, undefined);
  });
  it("rejects unknown values instead of ignoring them silently", () => {
    assert.ok(ok({ status: "CONFIRMED,NOPE" }).error);
    assert.ok(ok({ paymentMode: "CASH" }).error);
    assert.ok(ok({ salespersonId: "not-a-uuid" }).error);
    assert.ok(ok({ leadSourceId: `${LS_META},x` }).error);
  });
  it("total range: numbers only, not negative, min <= max", () => {
    const r = ok({ totalMin: "500", totalMax: "1000" });
    assert.deepEqual([r.value?.totalMin, r.value?.totalMax], [500, 1000]);
    assert.ok(ok({ totalMin: "-1" }).error);
    assert.ok(ok({ totalMin: "abc" }).error);
    assert.ok(ok({ totalMin: "2000", totalMax: "1000" }).error);
  });
  it("existing params (search, date range, page size) are unaffected", () => {
    const r = ok({ search: "Pawa", dateFrom: "2026-10-01T00:00:00.000Z", dateTo: "2026-10-05T23:59:59.999Z" });
    assert.equal(r.error, null);
    assert.equal(r.value?.search, "Pawa");
    assert.ok(ok({ dateFrom: "2026-10-05T00:00:00.000Z", dateTo: "2026-10-01T00:00:00.000Z" }).error);
  });
});
