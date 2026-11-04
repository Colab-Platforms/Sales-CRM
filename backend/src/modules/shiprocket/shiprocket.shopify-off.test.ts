// Run with: npx tsx --test src/modules/shiprocket/shiprocket.shopify-off.test.ts
//
// A CRM-created COD order saved with "Shopify sync OFF" goes through the real Shiprocket code (create shipment, AWB, tracking webhook).
// No database, no Shopify, no Shiprocket: the order/shipment tables are an in-memory stand-in and Shiprocket is a fake that records what it was sent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import OrdersService from "../orders/orders.service.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import ShiprocketShipmentsService from "./shiprocket.shipments.service.js";
import { processShiprocketEvent } from "./shiprocket.webhook.processor.js";
import { ADMIN, CONFIG, DIMS, ORDER, fakeDb, fakeShiprocket } from "./shiprocket.testutil.js";

describe("CRM-created COD order with Shopify sync OFF -> Shiprocket", () => {
  it("no Shopify order or draft is created: the push is skipped and Shopify is never contacted", async () => {
    const db = { order: { findFirst: async () => ({ ...ORDER }), findUnique: async () => ({ ...ORDER, payments: [] }) }, $executeRaw: async () => { throw new Error("claim must not be reached"); } };
    const svc = new OrdersService(db as never, () => assert.fail("Shopify must not be contacted"));
    const r = await svc.pushOrderToShopify(null, ORDER.id);
    assert.equal(r.status, "skipped");
    assert.equal(ORDER.externalId, null);
  });

  it("the existing shipment action sends the CRM order to Shiprocket with no Shopify identifier, then saves the ids, AWB, courier and tracking", async () => {
    const { runner, shipments, activities } = fakeDb();
    const { api, sent } = fakeShiprocket();
    const svc = new ShiprocketShipmentsService(runner as never, { config: () => CONFIG, client: () => api, now: () => new Date("2026-11-04T07:00:00Z") });

    // 1. create the shipment (admin; a Telecaller/Manager reach this the same way, scoped to their leads)
    const created = await svc.createShipment(ADMIN as never, ORDER.id, DIMS);
    assert.equal(sent.length, 1);
    const req = sent[0]!;
    assert.match(req.order_id, /^CRM-TEST-0001$/, "the CRM order number is Shiprocket's channel order id");
    assert.equal(req.payment_method, "COD");
    assert.equal(req.sub_total, 1249, "the whole order total is collected on delivery");
    assert.equal(req.shipping_charges, 50);
    assert.equal(req.pickup_location, "warehouse");
    assert.equal(req.billing_customer_name, "Priya");
    assert.equal(req.billing_last_name, "Shah");
    assert.equal(req.billing_phone, "9876500000");
    assert.equal(req.billing_pincode, "411001");
    assert.equal(req.billing_city, "Pune");
    assert.equal(req.billing_state, "Maharashtra");
    assert.deepEqual(req.order_items, [{ name: "Herbal Masala - Paan / 120", sku: "AW-HM-PN-120", units: 1, selling_price: 1199, discount: 0, tax: 0 }]);
    assert.equal(req.weight, 0.5);
    assert.doesNotMatch(JSON.stringify(req), /shopify|gid:\/\//i, "nothing about Shopify is sent to Shiprocket");

    // 2. Shiprocket's answer is saved
    assert.equal(created.shiprocketOrderId, "SR-ORD-555");
    assert.equal(shipments[0]!.externalId, "SR-SHIP-777");
    assert.equal(shipments[0]!.externalSource, "SHIPROCKET");
    assert.equal(shipments[0]!.status, "CREATED");
    assert.equal(shipments[0]!.channelOrderId, req.order_id);

    // 3. AWB + courier
    const shipped = await svc.assignAwb(ADMIN as never, created.id, 9);
    assert.equal(shipped.awb, "AWB-TEST-123");
    assert.equal(shipped.courier, "Test Courier");
    assert.equal(shipments[0]!.status, "AWB_ASSIGNED");
    assert.ok(activities.some((a) => a.type === "SHIPMENT_CREATED") && activities.some((a) => a.type === "SHIPMENT_AWB_ASSIGNED"));

    // 4. tracking updates arrive by webhook, matched by AWB (no Shopify id involved) and never regress
    const { store } = memoryStore();
    let n = 0;
    const deliver = async (status: string) => {
      const rec = await store.record({ eventType: "tracking", externalEventId: `evt-${++n}`, payload: { awb: "AWB-TEST-123", current_status: status, order_id: req.order_id, sr_order_id: 555, courier_name: "Test Courier" }, ignored: false } as never);
      return processShiprocketEvent(rec.id, { store, runner: runner as never, now: () => new Date("2026-11-04T09:00:00Z") });
    };
    assert.equal(await deliver("In Transit"), "processed");
    assert.equal(shipments[0]!.status, "IN_TRANSIT");
    assert.equal(shipments[0]!.providerStatus, "In Transit");
    assert.equal(await deliver("Delivered"), "processed");
    assert.equal(shipments[0]!.status, "DELIVERED");
    assert.equal(await deliver("In Transit"), "processed", "a late older status is accepted as an event but cannot move a delivered shipment back");
    assert.equal(shipments[0]!.status, "DELIVERED");
    assert.ok(activities.some((a) => a.type === "SHIPMENT_STATUS_CHANGED"));
  });
});
