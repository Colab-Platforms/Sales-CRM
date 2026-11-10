// Run with: npx tsx --test src/modules/shiprocket/shiprocket.duplicate-report.test.ts   (no database, no Shiprocket: fakes only)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ShiprocketOrderLookup } from "./shiprocket.client.js";
import { buildDuplicateReport, classifyPair, phaseOf, toCsv, type Side } from "./shiprocket.duplicate-report.js";

const ORDER = { orderNumber: "CRM-AAA-0001", shopifyName: "#AWL110598", totalCents: 44900 };
const side = (over: Partial<Side> = {}): Side => ({ origin: "CRM_RECORDED", shiprocketOrderId: "SR-A", shiprocketShipmentId: "S-A", reference: "CRM-AAA-0001", status: "NEW", awb: null, courier: null, createdAt: "2026-11-01T07:00:00Z", paymentMethod: "COD", totalCents: 44900, phase: "IDLE", crm: null, ...over });
const other = (over: Partial<Side> = {}) => side({ origin: "SHIPROCKET_ONLY", shiprocketOrderId: "SR-B", shiprocketShipmentId: null, reference: "AWL110598", ...over });
const tracked = (over: Partial<Side> = {}) => ({ status: "PICKUP SCHEDULED", awb: "AWB1", courier: "Delhivery", phase: "IN_MOTION" as const, ...over });

describe("phase of a parcel", () => {
  it("reads Shiprocket's wording and the AWB; anything unclear is UNKNOWN, never guessed", () => {
    assert.equal(phaseOf({ status: "DELIVERED", awb: "x" }), "DELIVERED");
    assert.equal(phaseOf({ status: "IN TRANSIT", awb: "x" }), "IN_MOTION");
    assert.equal(phaseOf({ status: "PICKED UP", awb: null }), "IN_MOTION");
    assert.equal(phaseOf({ status: "READY TO SHIP", awb: "x" }), "HAS_AWB");
    assert.equal(phaseOf({ status: "NEW", awb: null }), "IDLE");
    assert.equal(phaseOf({ status: "READY TO SHIP", awb: null }), "IDLE");
    assert.equal(phaseOf({ status: "RTO DELIVERED", awb: "x" }), "UNKNOWN");
    assert.equal(phaseOf({ status: "UNDELIVERED", awb: "x" }), "UNKNOWN");
    assert.equal(phaseOf({ status: null, awb: null }), "UNKNOWN");
    assert.equal(phaseOf({ status: "SOMETHING NEW", awb: null }), "UNKNOWN");
  });
});

describe("classification of a pair", () => {
  it("SAFE_TO_CANCEL: the idle twin (no AWB, NEW) next to a tracked, confirmed shipment - whichever side the CRM reference is on", () => {
    const crmIdleShopifyTracked = classifyPair(ORDER, side(), other(tracked()));
    assert.equal(crmIdleShopifyTracked.classification, "SAFE_TO_CANCEL");
    assert.equal(crmIdleShopifyTracked.keep, "B", "the tracked one is kept even though the CRM reference is on the other");
    assert.match(crmIdleShopifyTracked.notes.join(" "), /re-run the reconciliation/);
    const crmTrackedShopifyIdle = classifyPair(ORDER, side(tracked()), other());
    assert.equal(crmTrackedShopifyIdle.classification, "SAFE_TO_CANCEL");
    assert.equal(crmTrackedShopifyIdle.keep, "A");
    assert.match(crmTrackedShopifyIdle.recommendedAction, /Nothing was cancelled/);
  });

  it("never SAFE_TO_CANCEL when the tracked side is not confirmed: wrong amount, or an unrelated reference", () => {
    const wrongAmount = classifyPair(ORDER, side(), other({ ...tracked(), totalCents: 54900 }));
    assert.equal(wrongAmount.classification, "NEEDS_MANUAL_REVIEW");
    assert.match(wrongAmount.notes.join(" "), /549\.00/);
    const strange = classifyPair(ORDER, side(), other({ ...tracked(), reference: "SOMETHING-ELSE" }));
    assert.equal(strange.classification, "NEEDS_MANUAL_REVIEW");
    const unknownAmount = classifyPair(ORDER, side(), other({ ...tracked(), totalCents: null }));
    assert.equal(unknownAmount.classification, "NEEDS_MANUAL_REVIEW");
  });

  it("ACTIVE_SHIPMENT: both sides have an AWB - nothing is ever recommended for cancellation", () => {
    const r = classifyPair(ORDER, side(tracked()), other(tracked({ awb: "AWB2" })));
    assert.equal(r.classification, "ACTIVE_SHIPMENT");
    assert.equal(r.keep, null);
    assert.doesNotMatch(r.recommendedAction, /may cancel/);
  });

  it("DELIVERED: keeps the delivered side and names an idle twin for a person to cancel; two delivered sides need review", () => {
    const r = classifyPair(ORDER, side({ phase: "DELIVERED", status: "DELIVERED", awb: "AWB1" }), other());
    assert.equal(r.classification, "DELIVERED");
    assert.equal(r.keep, "A");
    assert.match(r.recommendedAction, /Manually cancel the idle duplicate SR-B/);
    assert.equal(classifyPair(ORDER, side({ phase: "DELIVERED" }), other({ phase: "DELIVERED" })).classification, "NEEDS_MANUAL_REVIEW");
  });

  it("NEEDS_MANUAL_REVIEW: both idle, a missing id, an RTO / unknown status", () => {
    const both = classifyPair(ORDER, side(), other());
    assert.equal(both.classification, "NEEDS_MANUAL_REVIEW");
    assert.equal(both.keep, "A", "suggested only: the CRM-recorded one");
    assert.equal(classifyPair(ORDER, side({ shiprocketOrderId: null }), other()).classification, "NEEDS_MANUAL_REVIEW");
    assert.equal(classifyPair(ORDER, side(), other({ phase: "UNKNOWN", status: "RTO IN TRANSIT" })).classification, "NEEDS_MANUAL_REVIEW");
  });
});

describe("building the report (read-only)", () => {
  const dbRow = (n: number, over: Record<string, unknown> = {}) => ({
    id: `o${n}`, orderNumber: `CRM-${n}`, externalId: `70${n}`, externalNumber: `#AWL2${n}`, totalAmount: "449.00",
    shipments: [{ id: `s${n}`, status: "CREATED", externalId: `SRS-${n}`, providerOrderId: `SR-${n}`, channelOrderId: `CRM-${n}`, trackingNumber: null, courier: null, trackingUrl: null, providerStatus: null, pickupScheduledAt: null, shippedAt: null, deliveredAt: null, createdAt: new Date("2026-11-01T07:00:00Z") }],
    ...over,
  });
  const remote = (ref: string, id: string, over: Partial<ShiprocketOrderLookup> = {}): ShiprocketOrderLookup => ({ shiprocketOrderId: id, channelOrderId: ref, status: "NEW", paymentMethod: "COD", totalCents: 44900, awb: null, courier: null, createdAt: "2026-11-01T07:05:00Z", ...over });

  it("finds pairs through Shiprocket searches, classifies each, skips single orders and records failed lookups - sending only searches", async () => {
    const rows = [dbRow(1), dbRow(2), dbRow(3), dbRow(4), dbRow(5)];
    const calls: string[] = [];
    const table: Record<string, ShiprocketOrderLookup[]> = {
      "CRM-1": [remote("CRM-1", "SR-1")], "AWL21": [remote("AWL21", "SR-X1", { awb: "AWB9", status: "PICKUP SCHEDULED", courier: "Delhivery" })],   // idle CRM order + tracked twin -> SAFE_TO_CANCEL
      "CRM-2": [remote("CRM-2", "SR-2", { awb: "AWB2", status: "IN TRANSIT" })], "AWL22": [remote("AWL22", "SR-X2", { awb: "AWB3", status: "PICKUP SCHEDULED" })], // both tracked -> ACTIVE
      "CRM-3": [remote("CRM-3", "SR-3", { awb: "AWB4", status: "DELIVERED" })], "AWL23": [remote("AWL23", "SR-X3")],                                      // delivered + idle twin
      "CRM-4": [remote("CRM-4", "SR-4")],                                                                                                                 // single order: not a duplicate
      "CRM-5": [remote("CRM-5", "SR-5")], "AWL25": [remote("AWL25", "SR-X5")],                                                                            // both idle -> manual
    };
    const lookup = async (id: string) => { calls.push(id); if (id === "FAIL") throw new Error("nope"); return table[id] ?? []; };
    const db = { order: { findMany: async () => rows as never } };
    const report = await buildDuplicateReport(db, { lookup, concurrency: 2 });
    assert.equal(report.checkedOrders, 5);
    assert.equal(report.pairs.length, 4);
    assert.deepEqual(report.totals, { SAFE_TO_CANCEL: 1, ACTIVE_SHIPMENT: 1, DELIVERED: 1, NEEDS_MANUAL_REVIEW: 1 });
    const safe = report.pairs.find((p) => p.classification === "SAFE_TO_CANCEL")!;
    assert.equal(safe.crmOrderNumber, "CRM-1");
    assert.equal(safe.keep, "B");
    assert.equal(safe.b.awb, "AWB9");
    assert.equal(safe.b.createdAt, "2026-11-01T07:05:00Z");
    assert.equal(safe.shopifyOrderNumber, "#AWL21");
    assert.ok(calls.every((c) => /^(CRM-\d|AWL2\d)$/.test(c)), "only channel-id searches were made");

    const failing = await buildDuplicateReport(db, { lookup: async () => { throw new Error("Shiprocket down"); } });
    assert.equal(failing.pairs.length, 0);
    assert.equal(failing.lookupErrors.length, 5, "a failed lookup is reported, never guessed into a classification");
  });

  it("two live shipments in the CRM itself form a pair even when Shiprocket search returns nothing extra", async () => {
    const row = dbRow(7, { shipments: [dbRow(7).shipments[0], { ...dbRow(7).shipments[0], id: "s7b", externalId: "SRS-7b", providerOrderId: "SR-7b", channelOrderId: "CRM-7-x2" }] });
    const report = await buildDuplicateReport({ order: { findMany: async () => [row] as never } }, { lookup: async () => [] });
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0]!.classification, "NEEDS_MANUAL_REVIEW");
  });

  it("the CSV has one row per pair, both shipment records, and neutralises spreadsheet formulas", () => {
    const pair = { ...classifyPair(ORDER, side(), other(tracked())), crmOrderNumber: "CRM-AAA-0001", crmOrderId: "o", shopifyOrderNumber: "=cmd()", shopifyOrderId: "1", orderTotalCents: 44900, a: side(), b: other(tracked()) };
    const csv = toCsv({ checkedOrders: 1, pairs: [pair], totals: { SAFE_TO_CANCEL: 1, ACTIVE_SHIPMENT: 0, DELIVERED: 0, NEEDS_MANUAL_REVIEW: 0 }, lookupErrors: [] });
    const lines = csv.trim().split("\r\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes("a_shiprocket_order_id") && lines[0]!.includes("b_awb"));
    assert.ok(csv.includes("SR-A") && csv.includes("SR-B") && csv.includes("AWB1"));
    assert.ok(csv.includes("'=cmd()"), "a formula-looking value is neutralised");
  });
});
