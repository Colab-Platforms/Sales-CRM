import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canApply, defaultSelection, lastSyncText, manualItems, syncableItems } from "./order-sync-form";
import type { SyncPreview } from "@/lib/api-client/types/orders.types";

const preview = (over: Partial<SyncPreview> = {}): SyncPreview => ({
  orderId: "o", orderNumber: "CRM-1", shopifyOrderId: "5", shopifyOrderName: "#AWL1", comparable: true, note: null, stateToken: "abcdef123456", lastSyncedAt: null, orderState: null,
  summary: { inSync: 1, differences: 3, syncable: 2, manualReview: 1 },
  items: [
    { key: "customer.link", group: "customer", label: "Shopify customer", crm: "A", shopify: "none", status: "DIFFERENT", action: "customer.link", blocked: null },
    { key: "tags", group: "order", label: "Tags", crm: "CRM", shopify: "", status: "DIFFERENT", action: "tags.add", blocked: null },
    { key: "total", group: "financial", label: "Order total", crm: "699.00", shopify: "649.00", status: "DIFFERENT", action: null, blocked: "manual" },
    { key: "items", group: "order", label: "Items", crm: "x", shopify: "x", status: "SYNCED", action: null, blocked: null },
  ], ...over,
});

describe("order sync dialog rules", () => {
  it("only server-approved differences are selectable; financial ones are listed as manual", () => {
    const p = preview();
    assert.deepEqual(syncableItems(p).map((i) => i.key), ["customer.link", "tags"]);
    assert.deepEqual(manualItems(p).map((i) => i.key), ["total"]);
    assert.deepEqual(defaultSelection(p), ["customer.link", "tags.add"]);
  });
  it("Apply needs a comparison, a ticked allowed change, the explicit confirmation, and nothing already running", () => {
    const p = preview();
    assert.equal(canApply(p, ["tags.add"], true, false), true);
    assert.equal(canApply(p, ["tags.add"], false, false), false, "no confirmation");
    assert.equal(canApply(p, [], true, false), false, "nothing ticked");
    assert.equal(canApply(p, ["tags.add"], true, true), false, "a sync is already running");
    assert.equal(canApply(p, ["shipping.address"], true, false), false, "not an allowed change for this order");
    assert.equal(canApply(null, ["tags.add"], true, false), false);
    assert.equal(canApply(preview({ comparable: false }), ["tags.add"], true, false), false);
    assert.equal(canApply(preview({ stateToken: null }), ["tags.add"], true, false), false);
  });
  it("last sync text", () => {
    assert.equal(lastSyncText(null, String), "Never synced from the CRM");
    assert.equal(lastSyncText("2026-10-26T10:00:00Z", (i) => i.slice(0, 10)), "Last successful sync: 2026-10-26");
  });
});
