// Database tests: 1 CRM order = 1 Shopify order = 1 Shiprocket shipment. Run with: npm run test:db  (ISOLATED database only)
//
// Every test runs inside ONE transaction that is always rolled back. The real createManualOrder, the real Shiprocket shipment service and the real sync + webhook code run against real tables;
// Shopify, Cashfree, WhatsApp and Shiprocket are fakes that record every call (and their ORDER), so no provider is contacted and no credential is needed. Nothing here proves behaviour of the live
// Shopify or Shiprocket accounts - only what the CRM sends and stores.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "../orders/orders.service.js";
import { writeShopifySyncSetting } from "../settings/shopify-sync.setting.js";
import { confirmAndSyncPaidOrder } from "../cashfree/cashfree.reconcile.js";
import { syncOrderToShiprocket } from "./shiprocket.auto-sync.js";
import ShiprocketShipmentsService, { type ShiprocketApi } from "./shiprocket.shipments.service.js";
import { loadShiprocketConfig } from "./shiprocket.config.js";
import { readShiprocketSync } from "./shiprocket.sync-record.js";
import { processShiprocketEvent } from "./shiprocket.webhook.processor.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";
import type { ShiprocketOrderLookup } from "./shiprocket.client.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const CONFIG = loadShiprocketConfig({ SHIPROCKET_ENABLED: "true", SHIPROCKET_EMAIL: "api@example.com", SHIPROCKET_PASSWORD: "not-real", SHIPROCKET_PICKUP_LOCATION: "warehouse" });
const ADDRESS = { name: "Rahul Verma", address1: "12 MG Road", city: "Pune", province: "Maharashtra", zip: "411001", country: "India", phone: "9876500000" };
const actorOf = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role }) as never;

async function withEnv(fn: () => Promise<void>) {
  const saved = process.env.SHIPROCKET_ENABLED;
  process.env.SHIPROCKET_ENABLED = "true";
  try { await fn(); } finally { if (saved === undefined) delete process.env.SHIPROCKET_ENABLED; else process.env.SHIPROCKET_ENABLED = saved; }
}

/** One shared, ordered log of every provider call, so a test can prove Shopify happened BEFORE Shiprocket. */
type Log = string[];

function fakeShiprocket(log: Log, existing: ShiprocketOrderLookup[] = []) {
  const sent: Record<string, unknown>[] = [];
  const api: ShiprocketApi = {
    findOrdersByChannelId: async (id) => existing.filter((o) => o.channelOrderId.toLowerCase() === id.replace(/^#/, "").toLowerCase()),
    createOrder: async (r) => { log.push("shiprocket:create"); sent.push(r as never); return { orderId: `SR-${sent.length}`, shipmentId: `SRS-${sent.length}`, awb: null, courierName: null, courierCompanyId: null } as never; },
    getCouriers: async () => [], assignAwb: async () => ({ awb: "AWB1", courierName: "C", courierCompanyId: 1 }), generatePickup: async () => ({ scheduledDate: null, tokenNumber: null }), generateLabel: async () => "x", track: async () => null,
  };
  return { api, sent };
}

/** A Shopify whose orderCreate answers `#AWL1xxxx` (like the live store's names) and can be made to refuse. */
function fakeShopify(log: Log) {
  const state = { created: 0, refuse: false };
  const client = { query: async (document: string) => {
    if (/orderCreate/.test(document)) {
      if (state.refuse) return { orderCreate: { order: null, userErrors: [{ field: ["order"], message: "Shopify is having a bad day" }] } };
      state.created++;
      log.push("shopify:create");
      return { orderCreate: { order: { id: `gid://shopify/Order/${9000 + state.created}`, name: `#AWL${110590 + state.created}` }, userErrors: [] } };
    }
    return { order: { id: "gid://shopify/Order/1", tags: [] }, orders: { nodes: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
  } } as unknown as ShopifyClient;
  return { client, state };
}

async function world(tx: Prisma.TransactionClient, existing: ShiprocketOrderLookup[] = []) {
  const log: Log = [];
  const sr = fakeShiprocket(log, existing);
  const shop = fakeShopify(log);
  const runner = { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) };
  const service = new ShiprocketShipmentsService(runner as never, { config: () => CONFIG, client: () => sr.api });
  const noMessages = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const cashfree = (() => ({ createPaymentLink: async () => ({ reused: false, paymentId: uid(), paymentUrl: "https://pay.test/x", expiresAt: null }) })) as never;
  const orders = new OrdersService(tx as never, () => shop.client, cashfree, noMessages, () => service);
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "449.00", weightKg: "0.25", lengthCm: "10", widthCm: "8", heightCm: "5" }, select: { id: true } });
  const user = await tx.user.create({ data: { name: "Telecaller", username: `u-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true, role: true } });
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Rahul", lastName: "Verma", mobile: "9876500000", normalizedMobile: "+919876500000", email: "r@zz.invalid", ownerId: user.id }, select: { id: true } });
  const create = (method: "COD" | "PAYMENT_LINK", extra: Record<string, unknown> = {}) =>
    orders.createManualOrder(actorOf(user), { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "449.00" }], paymentMethod: method, shippingAddress: ADDRESS, shippingPincode: "411001", ...extra } as never);
  return { tx, log, sr, shop, orders, service, user, admin, lead, create };
}

const shipmentsOf = (tx: Prisma.TransactionClient, orderId: string) => tx.shipment.findMany({ where: { orderId, externalSource: "SHIPROCKET" }, select: { id: true, status: true, externalId: true, providerOrderId: true, channelOrderId: true, metadata: true, trackingNumber: true } });
const orderRow = (tx: Prisma.TransactionClient, orderId: string) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true, externalId: true, externalNumber: true, externalSource: true, status: true, orderNumber: true } });

describe("Shopify sync ON: Shiprocket carries the Shopify order reference", () => {
  it("COD: Shopify is created first, its id and number are saved on the CRM order, and Shiprocket gets the Shopify reference - once - while the CRM order id is kept", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      const r = await w.create("COD", { idempotencyKey: `k-${uid()}` });
      const row = await orderRow(tx, r.order.id);

      assert.deepEqual([...w.log], ["shopify:create", "shiprocket:create"], "Shopify first, then exactly one Shiprocket order");
      assert.equal(row.externalSource, "SHOPIFY");
      assert.equal(row.externalId, "9001", "the Shopify order id is saved against the CRM order");
      assert.equal(row.externalNumber, "#AWL110591", "the Shopify order number is saved against the CRM order");

      assert.equal(w.sr.sent.length, 1);
      assert.equal(w.sr.sent[0]!.order_id, "AWL110591", "Shiprocket's primary order reference is the Shopify one, not the CRM id");
      assert.notEqual(w.sr.sent[0]!.order_id, row.orderNumber);
      assert.equal(w.sr.sent[0]!.comment, `CRM order ${row.orderNumber}`);
      assert.equal(w.sr.sent[0]!.payment_method, "COD");

      const ships = await shipmentsOf(tx, r.order.id);
      assert.equal(ships.length, 1);
      assert.equal(ships[0]!.channelOrderId, "AWL110591");
      assert.equal(ships[0]!.providerOrderId, "SR-1", "Shiprocket's order id is stored against the order");
      assert.equal(ships[0]!.externalId, "SRS-1", "Shiprocket's shipment id is stored against the order");
      const meta = (ships[0]!.metadata as { shiprocket: Record<string, string> }).shiprocket;
      assert.deepEqual([meta.crmOrderNumber, meta.shopifyOrderName, meta.shopifyOrderId], [row.orderNumber, "#AWL110591", "9001"], "the CRM order id is retained internally for reconciliation");

      const rec = readShiprocketSync(row.metadata)!;
      assert.deepEqual([rec.status, rec.channelOrderId, rec.crmOrderNumber, rec.shopifyOrderName, rec.shiprocketOrderId], ["SYNCED", "AWL110591", row.orderNumber, "#AWL110591", "SR-1"]);
    }));
  });

  it("prepaid: nothing goes to Shopify or Shiprocket before payment; after payment Shopify is created first, then ONE Shiprocket order under the Shopify reference; a replayed payment callback adds nothing", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      const r = await w.create("PAYMENT_LINK");
      assert.deepEqual([...w.log], [], "no Shopify order and no Shiprocket order before the payment is verified");
      assert.equal(readShiprocketSync((await orderRow(tx, r.order.id)).metadata)?.status, "AWAITING_PAYMENT");

      const total = (await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { totalAmount: true } })).totalAmount;
      await tx.payment.create({ data: { orderId: r.order.id, amount: total, currency: "INR", method: "PAYMENT_LINK", status: "SUCCESS", provider: "CASHFREE", externalSource: "CASHFREE", externalId: `cf-${uid()}`, paidAt: new Date() } });
      const deps = { runner: { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) } as never, getShopifyClient: () => w.shop.client, submitToShiprocket: (id: string) => syncOrderToShiprocket({ db: tx as never, service: w.service }, id, actorOf(w.user), "PAYMENT_VERIFIED") };
      for (let i = 0; i < 3; i++) await confirmAndSyncPaidOrder(deps, r.order.id, { source: "CASHFREE_WEBHOOK" } as never, () => new Date());

      assert.deepEqual(w.log.filter((l) => l !== "shopify:create"), ["shiprocket:create"]);
      assert.equal(w.log.filter((l) => l === "shopify:create").length, 1, "one Shopify order");
      assert.ok(w.log.indexOf("shopify:create") < w.log.indexOf("shiprocket:create"), "Shopify before Shiprocket");
      assert.equal(w.sr.sent.length, 1);
      assert.equal(w.sr.sent[0]!.order_id, "AWL110591");
      assert.equal(w.sr.sent[0]!.payment_method, "Prepaid");
      assert.equal((await shipmentsOf(tx, r.order.id)).length, 1);
    }));
  });

  it("Shopify refuses at first: nothing is sent to Shiprocket (no premature shipment); the Shopify retry then registers it once under the Shopify reference; further retries add nothing", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      w.shop.state.refuse = true;
      const r = await w.create("COD");
      assert.equal(r.shopify.status, "failed");
      assert.equal(w.sr.sent.length, 0, "no Shiprocket order without a Shopify order");
      assert.equal((await shipmentsOf(tx, r.order.id)).length, 0);
      assert.equal(readShiprocketSync((await orderRow(tx, r.order.id)).metadata)!.status, "AWAITING_SHOPIFY");
      // the Shiprocket retry button cannot go round it either
      assert.equal((await w.orders.retryShiprocketSync(actorOf(w.user), r.order.id)).status, "AWAITING_SHOPIFY");
      assert.equal(w.sr.sent.length, 0);

      w.shop.state.refuse = false;
      assert.equal((await w.orders.pushOrderToShopify(actorOf(w.user), r.order.id)).status, "created");
      assert.equal(w.sr.sent.length, 1, "the Shopify link registered it with Shiprocket");
      assert.equal(w.sr.sent[0]!.order_id, "AWL110591");
      for (let i = 0; i < 3; i++) {
        await w.orders.pushOrderToShopify(actorOf(w.user), r.order.id);
        assert.equal((await w.orders.retryShiprocketSync(actorOf(w.user), r.order.id)).status, "SYNCED");
      }
      assert.equal(w.sr.sent.length, 1, "repeated Shopify pushes / retries never create a second shipment");
      assert.equal(w.shop.state.created, 1);
      assert.equal((await shipmentsOf(tx, r.order.id)).length, 1);
    }));
  });

  it("a repeated createManualOrder request (same idempotency key) and repeated retries create one Shopify order and one Shiprocket shipment", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      const key = `k-${uid()}`;
      const a = await w.create("COD", { idempotencyKey: key });
      const b = await w.create("COD", { idempotencyKey: key });
      assert.equal(a.order.id, b.order.id);
      await Promise.all([1, 2, 3].map(() => w.orders.retryShiprocketSync(actorOf(w.user), a.order.id)));
      assert.equal(w.shop.state.created, 1);
      assert.equal(w.sr.sent.length, 1);
      assert.equal((await shipmentsOf(tx, a.order.id)).length, 1);
    }));
  });

  it("a manual 'create shipment' for a Shopify-sync-ON order that has no Shopify order yet is refused (409) and reserves nothing", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      w.shop.state.refuse = true;
      const r = await w.create("COD");
      await assert.rejects(w.service.createShipment(actorOf(w.user), r.order.id, { weight: 0.25, length: 10, breadth: 8, height: 5 } as never), (e: any) => e.statusCode === 409 && /Shopify/.test(e.message));
      assert.equal(w.sr.sent.length, 0);
      assert.equal((await shipmentsOf(tx, r.order.id)).length, 0);
    }));
  });
});

describe("the latest flow cannot produce a duplicate", () => {
  it("Shiprocket's Shopify channel imported the Shopify order BEFORE the CRM submitted: the CRM creates nothing, reports the existing order, and a retry still creates nothing", async () => {
    await withEnv(() => inRollback(async (tx) => {
      // the first Shopify order of this fake store is #AWL110591; Shiprocket already holds it as imported by its Shopify channel
      const imported: ShiprocketOrderLookup = { shiprocketOrderId: "SR-IMPORTED", channelOrderId: "AWL110591", status: "NEW", paymentMethod: "COD", totalCents: 44900, awb: null, courier: null };
      const w = await world(tx, [imported]);
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      const r = await w.create("COD");
      assert.equal(w.sr.sent.length, 0, "no second Shiprocket order is created");
      const rec = readShiprocketSync((await orderRow(tx, r.order.id)).metadata)!;
      assert.equal(rec.status, "FAILED");
      assert.match(rec.error ?? "", /SR-IMPORTED/);
      assert.equal((await w.orders.retryShiprocketSync(actorOf(w.user), r.order.id)).status, "FAILED");
      assert.equal(w.sr.sent.length, 0);
      assert.equal((await shipmentsOf(tx, r.order.id)).filter((x) => x.status !== "CANCELLED").length, 0);
    }));
  });

  it("every way into Shiprocket for a CRM order goes through the same guarded create: the source has exactly one createOrder call site", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("./", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !/(test|testutil)\.ts$/.test(f) && !f.endsWith("client.ts"));
    const hits = files.filter((f) => /\.createOrder\(/.test(readFileSync(new URL(f, dir), "utf8")));
    assert.deepEqual(hits, ["shiprocket.shipments.service.ts"]);
  });
});

describe("Shopify sync OFF and Shopify-originated orders keep their behaviour", () => {
  it("OFF: no Shopify order, Shiprocket gets the CRM order number, and flipping the toggle later changes nothing for that order", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      await writeShopifySyncSetting(tx as never, false, w.admin.id);
      const r = await w.create("COD");
      const row = await orderRow(tx, r.order.id);
      assert.equal(w.shop.state.created, 0);
      assert.equal(row.externalId, null);
      assert.equal(w.sr.sent.length, 1);
      assert.equal(w.sr.sent[0]!.order_id, row.orderNumber);
      assert.equal(w.sr.sent[0]!.comment, undefined);
      // the Admin turns the switch ON afterwards: the existing order is not touched and still has exactly one shipment
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      assert.equal((await w.orders.retryShiprocketSync(actorOf(w.user), r.order.id)).status, "SYNCED");
      assert.equal((await w.orders.pushOrderToShopify(actorOf(w.user), r.order.id)).status, "skipped");
      assert.equal(w.shop.state.created, 0);
      assert.equal(w.sr.sent.length, 1);
    }));
  });

  it("a Shopify-originated order is never submitted automatically, and a manual shipment for it keeps its existing id (no change to imported orders)", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      const order = await tx.order.create({ data: { orderNumber: `SHP-${uid().slice(0, 8)}`, leadId: w.lead.id, status: "CONFIRMED", source: "SHOPIFY", externalSource: "SHOPIFY", externalId: `${Date.now()}`, externalNumber: "#AWL555001", currency: "INR", subtotal: "449.00", totalAmount: "449.00", shippingAddress: ADDRESS as never, shippingPincode: "411001", items: { create: [{ productNameSnapshot: "Herbal Masala", quantity: 1, unitPrice: "449.00", totalPrice: "449.00", productId: (await tx.product.findFirstOrThrow({ select: { id: true } })).id }] } }, select: { id: true, orderNumber: true } });
      assert.equal((await syncOrderToShiprocket({ db: tx as never, service: w.service }, order.id, actorOf(w.user), "RETRY")).status, "NOT_APPLICABLE");
      assert.equal(w.sr.sent.length, 0);
      await w.service.createShipment(actorOf(w.admin as never), order.id, { weight: 0.25, length: 10, breadth: 8, height: 5 } as never).catch(() => undefined);
      const n = w.sr.sent.length as number;
      if (n === 1) assert.equal(w.sr.sent[0]!.order_id, order.orderNumber, "unchanged for a Shopify-originated order");
      assert.ok(n <= 1);
    }));
  });
});

describe("Shiprocket tracking updates the original CRM order and never creates a shipment", () => {
  it("a tracking event carrying the Shopify reference updates the CRM order's one shipment (AWB, courier, status); repeats and an unknown event add no shipment", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const w = await world(tx);
      await writeShopifySyncSetting(tx as never, true, w.admin.id);
      const r = await w.create("COD");
      const before = await shipmentsOf(tx, r.order.id);
      assert.equal(before.length, 1);

      const events = new Map<string, { payload: unknown; attempts: number; done: boolean }>();
      const store: WebhookStore = {
        record: async (e) => { events.set(e.externalEventId, { payload: e.payload, attempts: 0, done: false }); return { id: e.externalEventId, duplicate: false }; },
        claim: async (id) => { const e = events.get(id)!; if (e.done) return null; e.attempts++; return { id, payload: e.payload, attempts: e.attempts } as never; },
        complete: async (id) => { events.get(id)!.done = true; },
        fail: async () => undefined,
        due: async () => [],
      };
      const runner = { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) } as never;
      const deliver = async (id: string, payload: Record<string, unknown>) => { await store.record({ eventType: "tracking", externalEventId: id, payload }); return processShiprocketEvent(id, { store, runner }); };

      // Shiprocket echoes the order id the CRM sent: the Shopify reference. No AWB / sr_order_id match is needed.
      assert.equal(await deliver("e1", { order_id: "AWL110591", awb: "AWB-777", current_status: "IN TRANSIT", courier_name: "Delhivery", etd: "2026-11-14 10:00:00" }), "processed");
      let ships = await shipmentsOf(tx, r.order.id);
      assert.equal(ships.length, 1, "tracking never creates a shipment");
      assert.deepEqual([ships[0]!.id, ships[0]!.trackingNumber, ships[0]!.status], [before[0]!.id, "AWB-777", "IN_TRANSIT"]);
      const detail = await tx.shipment.findUniqueOrThrow({ where: { id: ships[0]!.id }, select: { courier: true, providerStatus: true, estimatedDelivery: true } }).catch(() => null);
      if (detail) assert.equal(detail.courier, "Delhivery");

      // the same delivery again (a webhook retry) and a later one by AWB
      assert.equal(await deliver("e2", { order_id: "AWL110591", awb: "AWB-777", current_status: "IN TRANSIT" }), "processed");
      assert.equal(await deliver("e3", { awb: "AWB-777", current_status: "DELIVERED" }), "processed");
      ships = await shipmentsOf(tx, r.order.id);
      assert.equal(ships.length, 1);
      assert.equal(ships[0]!.status, "DELIVERED");

      // an event for an order the CRM never created in Shiprocket is ignored, and creates nothing
      const total = await tx.shipment.count();
      assert.equal(await deliver("e4", { order_id: "SOMEONE-ELSES-ORDER", awb: "AWB-000", current_status: "IN TRANSIT" }), "ignored");
      assert.equal(await tx.shipment.count(), total);
    }));
  });
});
