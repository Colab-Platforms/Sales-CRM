// Database tests: tracking events land on the Shiprocket order they belong to. Run with: npm run test:db  (ISOLATED database only)
// A CRM sale can have two live Shiprocket orders (the CRM's own CRM-... order and the AWL... order Shiprocket's Shopify channel imported). Each has its own events and its own CRM record; an event of one must
// never be applied to the other, and cancelling the idle twin must never touch the tracked parcel. Each test runs in one transaction that is rolled back; nothing external is contacted.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { processShiprocketEvent } from "./shiprocket.webhook.processor.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try { await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 }); } catch (error) { if (!(error instanceof Rollback)) throw error; }
}
after(() => prisma.$disconnect());
const uid = () => randomUUID();

async function world(tx: Prisma.TransactionClient) {
  const user = await tx.user.create({ data: { name: "T", username: `u-${uid()}`, role: Role.SALESPERSON }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Rahul", lastName: "V", mobile: "9876500000", normalizedMobile: "+919876500000", ownerId: user.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "P", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "549.00" }, select: { id: true } });
  let n = 0;
  const order = async (source: "SALESPERSON" | "SHOPIFY" = "SALESPERSON") => {
    n++;
    const shopify = `#AWL3${Math.floor(Math.random() * 1e6)}${n}`;
    const row = await tx.order.create({ data: { orderNumber: `CRM-T${n}-${uid().slice(0, 4)}`, leadId: lead.id, status: "CONFIRMED", source, currency: "INR", subtotal: "549.00", totalAmount: "549.00", externalSource: "SHOPIFY", externalId: `${Date.now()}${n}`, externalNumber: shopify, items: { create: [{ productNameSnapshot: "P", quantity: 1, unitPrice: "549.00", totalPrice: "549.00", productId: product.id }] } }, select: { id: true, orderNumber: true, externalNumber: true } });
    return { ...row, ref: shopify.slice(1) };
  };
  const shipment = (orderId: string, o: { channel: string; provider: string; awb?: string | null; status?: "CREATED" | "AWB_ASSIGNED" | "IN_TRANSIT" }) =>
    tx.shipment.create({ data: { orderId, externalSource: "SHIPROCKET", status: o.status ?? "CREATED", externalId: `SH-${uid().slice(0, 8)}`, providerOrderId: o.provider, channelOrderId: o.channel, trackingNumber: o.awb ?? null, metadata: { shiprocket: { created: true } } }, select: { id: true } });

  const events = new Map<string, { payload: unknown; attempts: number; done: boolean }>();
  const store: WebhookStore = {
    record: async (e) => { events.set(e.externalEventId, { payload: e.payload, attempts: 0, done: false }); return { id: e.externalEventId, duplicate: false }; },
    claim: async (id) => { const e = events.get(id)!; if (e.done) return null; e.attempts++; return { id, payload: e.payload, attempts: e.attempts } as never; },
    complete: async (id) => { events.get(id)!.done = true; }, fail: async () => undefined, due: async () => [],
  };
  const runner = { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) } as never;
  const deliver = async (payload: Record<string, unknown>) => { const id = `ev-${uid()}`; await store.record({ eventType: "tracking", externalEventId: id, payload }); return processShiprocketEvent(id, { store, runner }); };
  const rows = (orderId: string) => tx.shipment.findMany({ where: { orderId, externalSource: "SHIPROCKET" }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, trackingNumber: true, providerOrderId: true, channelOrderId: true, courier: true, externalId: true } });
  return { tx, order, shipment, deliver, rows };
}

describe("tracking ownership: one record per Shiprocket order", () => {
  it("an AWL tracking event with a separate idle CRM-ref order: the tracked parcel gets its OWN record with its real ids; the idle CRM-ref shipment is not touched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const o = await w.order();
      const idle = await w.shipment(o.id, { channel: o.orderNumber, provider: "SR-IDLE-1" });
      assert.equal(await w.deliver({ order_id: o.ref, sr_order_id: "SR-AWL-9", shipment_id: "SHP-AWL-9", awb: "AWB-9", current_status: "IN TRANSIT", courier_name: "Delhivery" }), "processed");
      const all = await w.rows(o.id);
      assert.equal(all.length, 2, "the CRM now holds one record per live Shiprocket order");
      const idleRow = all.find((r) => r.id === idle.id)!;
      assert.deepEqual([idleRow.status, idleRow.trackingNumber, idleRow.providerOrderId], ["CREATED", null, "SR-IDLE-1"], "the idle CRM-ref shipment did not adopt the other order's tracking");
      const tracked = all.find((r) => r.id !== idle.id)!;
      assert.deepEqual([tracked.providerOrderId, tracked.externalId, tracked.channelOrderId, tracked.trackingNumber, tracked.status, tracked.courier], ["SR-AWL-9", "SHP-AWL-9", o.ref, "AWB-9", "IN_TRANSIT", "Delhivery"]);
      const meta = ((await tx.shipment.findUniqueOrThrow({ where: { id: tracked.id }, select: { metadata: true } })).metadata as { shiprocket: Record<string, unknown> }).shiprocket;
      assert.equal(meta.crmOrderNumber, o.orderNumber);
      assert.equal(meta.shopifyOrderName, o.externalNumber);
    });
  });

  it("active AWL shipment keeps updating its own record; a repeated delivery and a retry add no record and change nothing twice", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const o = await w.order();
      const idle = await w.shipment(o.id, { channel: o.orderNumber, provider: "SR-IDLE-2" });
      const first = { order_id: o.ref, sr_order_id: "SR-AWL-2", awb: "AWB-2", current_status: "PICKED UP", courier_name: "Delhivery" };
      await w.deliver(first);
      await w.deliver(first);                                                      // the very same delivery again
      await w.deliver({ ...first, current_status: "OUT FOR DELIVERY" });
      await w.deliver({ awb: "AWB-2", current_status: "DELIVERED" });              // later events often carry only the AWB
      const all = await w.rows(o.id);
      assert.equal(all.length, 2);
      assert.equal(all.find((r) => r.providerOrderId === "SR-AWL-2")!.status, "DELIVERED");
      const idleRow = all.find((r) => r.id === idle.id)!;
      assert.deepEqual([idleRow.status, idleRow.trackingNumber], ["CREATED", null]);
      const acts = await tx.activity.count({ where: { orderId: o.id, source: "SHIPROCKET_WEBHOOK" } });
      assert.ok(acts >= 1 && acts <= 4, "each real change is recorded once (a repeat records nothing)");
    });
  });

  it("cancelling the idle CRM-ref order cancels only that order's record - the tracked AWL shipment keeps its status, AWB and ids", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const o = await w.order();
      const idle = await w.shipment(o.id, { channel: o.orderNumber, provider: "SR-IDLE-3" });
      await w.deliver({ order_id: o.ref, sr_order_id: "SR-AWL-3", awb: "AWB-3", current_status: "IN TRANSIT", courier_name: "Delhivery" });
      assert.equal(await w.deliver({ order_id: o.orderNumber, sr_order_id: "SR-IDLE-3", current_status: "CANCELED" }), "processed");
      assert.equal(await w.deliver({ order_id: o.orderNumber, sr_order_id: "SR-IDLE-3", current_status: "CANCELED" }), "processed", "a repeated cancellation");
      const all = await w.rows(o.id);
      assert.equal(all.find((r) => r.id === idle.id)!.status, "CANCELLED");
      const tracked = all.find((r) => r.providerOrderId === "SR-AWL-3")!;
      assert.deepEqual([tracked.status, tracked.trackingNumber], ["IN_TRANSIT", "AWB-3"]);
      // a cancellation event of the idle order that carries the TRACKED order's AWB must still not reach the tracked record
      assert.equal(await w.deliver({ order_id: o.orderNumber, sr_order_id: "SR-IDLE-3", awb: "AWB-3", current_status: "CANCELED" }), "processed");
      assert.equal((await w.rows(o.id)).find((r) => r.providerOrderId === "SR-AWL-3")!.status, "IN_TRANSIT");
    });
  });

  it("a record that already (wrongly) holds the other order's AWB is not updated by the other order's events, and does not stop the real order from being tracked", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const o = await w.order();
      const polluted = await w.shipment(o.id, { channel: o.orderNumber, provider: "SR-IDLE-4", awb: "AWB-4", status: "IN_TRANSIT" });
      assert.equal(await w.deliver({ order_id: o.ref, sr_order_id: "SR-AWL-4", awb: "AWB-4", current_status: "DELIVERED" }), "processed");
      const all = await w.rows(o.id);
      assert.equal(all.length, 2);
      assert.equal(all.find((r) => r.id === polluted.id)!.status, "IN_TRANSIT", "the other order's DELIVERED did not overwrite this record");
      assert.equal(all.find((r) => r.providerOrderId === "SR-AWL-4")!.status, "DELIVERED");
    });
  });

  it("existing correctly mapped shipments are unchanged: one shipment under the Shopify reference, events update it by ids, reference or AWB, and no extra record appears", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const o = await w.order();
      const own = await w.shipment(o.id, { channel: o.ref, provider: "SR-OWN-5" });
      await w.deliver({ order_id: o.ref, awb: "AWB-5", current_status: "AWB ASSIGNED" });                  // first event: only the reference is known to the CRM
      await w.deliver({ order_id: o.ref, sr_order_id: "SR-OWN-5", awb: "AWB-5", current_status: "IN TRANSIT" });
      await w.deliver({ awb: "AWB-5", current_status: "DELIVERED" });
      const all = await w.rows(o.id);
      assert.equal(all.length, 1);
      assert.deepEqual([all[0]!.id, all[0]!.status, all[0]!.trackingNumber], [own.id, "DELIVERED", "AWB-5"]);
      // the CRM-number reference (old flow) still maps by itself
      const o2 = await w.order();
      const old = await w.shipment(o2.id, { channel: o2.orderNumber, provider: "SR-OLD-5" });
      await w.deliver({ order_id: o2.orderNumber, sr_order_id: "SR-OLD-5", awb: "AWB-6", current_status: "PICKED UP" });
      assert.deepEqual((await w.rows(o2.id)).map((r) => [r.id, r.status]), [[old.id, "SHIPPED"]]);
    });
  });

  it("never guesses: an unknown reference, a Shopify-originated order, a cancelled/returned unknown parcel and a true twin under the same reference record nothing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const before = await tx.shipment.count();
      assert.equal(await w.deliver({ order_id: "AWL-NOBODY", sr_order_id: "SR-X", awb: "AWB-X", current_status: "IN TRANSIT" }), "ignored");
      const fromShopify = await w.order("SHOPIFY");
      assert.equal(await w.deliver({ order_id: fromShopify.ref, sr_order_id: "SR-Y", awb: "AWB-Y", current_status: "IN TRANSIT" }), "ignored");
      const o = await w.order();
      assert.equal(await w.deliver({ order_id: o.ref, sr_order_id: "SR-Z", awb: "AWB-Z", current_status: "CANCELED" }), "ignored");
      assert.equal(await w.deliver({ order_id: o.ref, sr_order_id: "SR-Z", awb: "AWB-Z", current_status: "DELIVERED", is_return: 1 }), "ignored");
      await w.shipment(o.id, { channel: o.ref, provider: "SR-HELD" });   // the CRM already holds a shipment under this very reference
      assert.equal(await w.deliver({ order_id: o.ref, sr_order_id: "SR-TWIN", awb: "AWB-T", current_status: "IN TRANSIT" }), "ignored");
      assert.equal(await tx.shipment.count(), before + 1, "only the shipment the test itself created exists");
    });
  });
});
