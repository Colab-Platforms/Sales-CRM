// Run with: ../backend/node_modules/.bin/tsx --test components/orders/orders-column-filters.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activeTotalPreset, filtersToApi, filtersToParams, hasActiveColumnFilters, isColumnActive, localDay, parseColumnFilters, presetRange, EMPTY_FILTERS } from "./orders-column-filters";

const SP = "0b5a7b6e-3c1d-4d6a-8f21-1c2d3e4f5a6b";
const parse = (qs: string, now?: Date) => parseColumnFilters(new URLSearchParams(qs), now);

describe("URL <-> filter state", () => {
  it("round-trips a combined filter (Payment COD + Source Shopify + Status/fulfilment Unfulfilled)", () => {
    const f = parse("paymentMode=COD&source=SHOPIFY&fulfillment=UNFULFILLED");
    assert.deepEqual([f.paymentMode, f.source, f.fulfillment], [["COD"], ["SHOPIFY"], ["UNFULFILLED"]]);
    assert.ok(hasActiveColumnFilters(f));
    const params = filtersToParams({ paymentMode: f.paymentMode, source: f.source, fulfillment: f.fulfillment });
    assert.deepEqual(params, { paymentMode: "COD", source: "SHOPIFY", fulfillment: "UNFULFILLED" });
  });
  it("multi-select values are comma lists; unknown / duplicate values are dropped, never sent to the API", () => {
    const f = parse(`paymentMode=COD,PREPAID,CASH,COD&status=CONFIRMED,NOPE&salespersonId=${SP},bad`);
    assert.deepEqual(f.paymentMode, ["COD", "PREPAID"]);
    assert.deepEqual(f.status, ["CONFIRMED"]);
    assert.deepEqual(f.salespersonId, [SP]);
    assert.deepEqual(filtersToApi(f).paymentMode, ["COD", "PREPAID"]);
  });
  it("clearing a filter removes its param; an empty page state has no active filters (Clear filters restores all)", () => {
    assert.deepEqual(filtersToParams({ paymentMode: [], status: [] }), { paymentMode: undefined, status: undefined });
    assert.equal(hasActiveColumnFilters(EMPTY_FILTERS), false);
    assert.equal(hasActiveColumnFilters(parse("")), false);
  });
  it("per-column active state drives the funnel indicator", () => {
    const f = parse("paymentStatus=PENDING&totalMin=500");
    assert.equal(isColumnActive(f, "payment"), true);
    assert.equal(isColumnActive(f, "total"), true);
    assert.equal(isColumnActive(f, "source"), false);
    assert.equal(isColumnActive(parse("fulfillment=UNFULFILLED"), "status"), true);
  });
  it("total filter: numbers only; presets are recognised; the API gets the numeric bounds", () => {
    const f = parse("totalMin=500&totalMax=1000");
    assert.equal(activeTotalPreset(f), "500-1000");
    assert.equal(activeTotalPreset(parse("totalMin=2500")), "2500+");
    assert.equal(activeTotalPreset(parse("totalMin=123&totalMax=456")), null);
    assert.equal(parse("totalMin=abc").totalMin, undefined);
    assert.deepEqual([filtersToApi(f).totalMin, filtersToApi(f).totalMax], ["500", "1000"]);
  });
});

describe("date filter (local calendar days, no UTC off-by-one)", () => {
  // 00:30 local time on 1 Oct: toISOString() would already say 30 Sep in any zone east of UTC.
  const now = new Date(2026, 9, 1, 0, 30, 0);
  it("localDay uses the viewer's local date", () => {
    assert.equal(localDay(now), "2026-10-01");
  });
  it("presets", () => {
    assert.deepEqual(presetRange("today", now), { dateFrom: "2026-10-01", dateTo: "2026-10-01" });
    assert.deepEqual(presetRange("yesterday", now), { dateFrom: "2026-09-30", dateTo: "2026-09-30" });
    assert.deepEqual(presetRange("7d", now), { dateFrom: "2026-09-25", dateTo: "2026-10-01" });
    assert.deepEqual(presetRange("30d", now), { dateFrom: "2026-09-02", dateTo: "2026-10-01" });
    assert.deepEqual(presetRange("month", now), { dateFrom: "2026-10-01", dateTo: "2026-10-01" });
  });
  it("a preset in the URL stays relative on refresh; a custom range is kept as typed; choosing one clears the other", () => {
    assert.deepEqual([parse("datePreset=7d", now).dateFrom, parse("datePreset=7d", now).dateTo], ["2026-09-25", "2026-10-01"]);
    const custom = parse("dateFrom=2026-09-10&dateTo=2026-09-12");
    assert.deepEqual([custom.datePreset, custom.dateFrom, custom.dateTo], [undefined, "2026-09-10", "2026-09-12"]);
    assert.deepEqual(filtersToParams({ datePreset: "30d" }), { datePreset: "30d", dateFrom: undefined, dateTo: undefined });
    assert.deepEqual(filtersToParams({ dateFrom: "2026-09-10", dateTo: "2026-09-12" }), { dateFrom: "2026-09-10", dateTo: "2026-09-12", datePreset: undefined });
  });
  it("month boundaries (leap-year day, new year) are right", () => {
    assert.deepEqual(presetRange("yesterday", new Date(2028, 2, 1, 9)), { dateFrom: "2028-02-29", dateTo: "2028-02-29" });
    assert.deepEqual(presetRange("7d", new Date(2026, 0, 3, 9)), { dateFrom: "2025-12-28", dateTo: "2026-01-03" });
  });
});
