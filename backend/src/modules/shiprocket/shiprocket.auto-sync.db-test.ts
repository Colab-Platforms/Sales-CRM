// Database integration tests for the automatic Shiprocket submission of CRM-created orders. Run with: npm run test:db  (ISOLATED database only)
//
// Every test runs inside ONE transaction that is always rolled back. The real createManualOrder, the real Shiprocket shipment service and the real sync code run against real tables;
// Shopify, Cashfree, WhatsApp and Shiprocket are fakes that count calls, so no provider is ever contacted and no credential is needed.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "../orders/orders.service.js";
import OrderEditService from "../orders/orders.edit.service.js";
import { writeShopifySyncSetting } from "../settings/shopify-sync.setting.js";
import { confirmAndSyncPaidOrder } from "../cashfree/cashfree.reconcile.js";
import { syncOrderToShiprocket } from "./shiprocket.auto-sync.js";
import ShiprocketShipmentsService, { type ShiprocketApi } from "./shiprocket.shipments.service.js";
import { loadShiprocketConfig } from "./shiprocket.config.js";
import { readShiprocketSync } from "./shiprocket.sync-record.js";

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
const ENV_ON = { SHIPROCKET_ENABLED: "true" };
const ADDRESS = { name: "Priya Shah", address1: "12 MG Road", city: "Pune", province: "Maharashtra", zip: "411001", country: "India", phone: "9876500000" };

/** Process env for the duration of one test (the order service reads Shiprocket's parcel defaults from it). */
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const keys = ["SHIPROCKET_ENABLED"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try { await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function fakeShiprocket(script: { fail?: () => Error | null } = {}) {
  const sent: { order_id: string; payment_method: string; sub_total: number; weight: number; length: number; breadth: number; height: number }[] = [];
  const api: ShiprocketApi = {
    createOrder: async (r) => { const f = script.fail?.(); if (f) throw f; sent.push(r as never); return { orderId: `SR-${sent.length}`, shipmentId: `SRS-${sent.length}`, awb: null, courierName: null, courierCompanyId: null } as never; },
    getCouriers: async () => [], assignAwb: async () => ({ awb: "AWB1", courierName: "C", courierCompanyId: 1 }), generatePickup: async () => ({ scheduledDate: null, tokenNumber: null }), generateLabel: async () => "x", track: async () => null,
  };
  return { api, sent };
}

function fakeShopify() {
  const created: string[] = [];
  const client = { query: async (document: string) => {
    if (/orderCreate/.test(document)) { created.push("x"); return { orderCreate: { order: { id: `gid://shopify/Order/${created.length}`, name: `#T${created.length}` }, userErrors: [] } }; }
    return { order: { id: "gid://shopify/Order/1", tags: [] }, orders: { nodes: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
  } } as unknown as ShopifyClient;
  return { client, created };
}

async function world(tx: Prisma.TransactionClient, sr: ReturnType<typeof fakeShiprocket>) {
  const shop = fakeShopify();
  const runner = { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) };
  const service = new ShiprocketShipmentsService(runner as never, { config: () => CONFIG, client: () => sr.api });
  const noMessages = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const cashfree = (() => ({ createPaymentLink: async () => ({ reused: false, paymentId: uid(), paymentUrl: "https://pay.test/x", expiresAt: null }) })) as never;
  const orders = new OrdersService(tx as never, () => shop.client, cashfree, noMessages, () => service);
  // product-level measurements, as the Shiprocket catalogue import / Shopify-linked products leave them
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "1199.00", weightKg: "0.25", lengthCm: "10", widthCm: "8", heightCm: "5" }, select: { id: true } });
  const product2 = await tx.product.create({ data: { name: "Calcium", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "299.00", weightKg: "0.75", lengthCm: "14", widthCm: "6", heightCm: "9" }, select: { id: true } });
  const user = async (role: Role) => tx.user.create({ data: { name: `${role} user`, username: `u-${uid()}`, role }, select: { id: true, username: true, role: true } });
  const lead = async (ownerId: string, groupId?: string) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "+919876500000", email: "p@zz.invalid", ownerId, ...(groupId ? { groupId } : {}) }, select: { id: true } });
  const create = (u: { id: string; username: string; role: Role }, leadId: string, method: "COD" | "PAYMENT_LINK", extra: Record<string, unknown> = {}) =>
    orders.createManualOrder({ id: u.id, username: u.username, role: u.role } as never, { leadId, items: [{ productId: product.id, quantity: 1, unitPrice: "1199.00" }], paymentMethod: method, shippingAddress: ADDRESS, shippingPincode: "411001", ...extra } as never);
  return { tx, shop, orders, service, runner, user, lead, create, product, product2 };
}

/** Creator + a lead each of the three roles may create an order for. */
async function creators(w: Awaited<ReturnType<typeof world>>) {
  const tele = await w.user(Role.SALESPERSON);
  const admin = await w.user(Role.ADMIN);
  const manager = await w.user(Role.MANAGER);
  const group = await w.tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
  return [
    { label: "Telecaller", u: tele, leadId: (await w.lead(tele.id)).id },
    { label: "Admin", u: admin, leadId: (await w.lead(admin.id)).id },
    { label: "Manager", u: manager, leadId: (await w.lead(manager.id, group.id)).id },
  ];
}
const shipmentsOf = (tx: Prisma.TransactionClient, orderId: string) => tx.shipment.findMany({ where: { orderId, externalSource: "SHIPROCKET" }, select: { status: true, externalId: true, providerOrderId: true, channelOrderId: true } });
const metaOf = async (tx: Prisma.TransactionClient, orderId: string) => (await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true, externalId: true, externalNumber: true, status: true, orderNumber: true } }));
/** The Shiprocket order id a CRM order is registered under: its Shopify reference when Shopify sync linked it, the CRM order number otherwise. */
const expectedRef = (row: { orderNumber: string; externalId: string | null; externalNumber: string | null }) => (row.externalId && row.externalNumber ? row.externalNumber.replace(/^#/, "") : row.orderNumber);

describe("full COD order creation: Telecaller / Admin / Manager x Shopify sync ON / OFF", () => {
  for (const shopifyOn of [false, true]) {
    it(`Shopify sync ${shopifyOn ? "ON" : "OFF"}: each order reaches Shiprocket exactly once; Shopify gets one order only when ON`, async () => {
      await withEnv(ENV_ON, () => inRollback(async (tx) => {
        const sr = fakeShiprocket();
        const w = await world(tx, sr);
        await writeShopifySyncSetting(tx as never, shopifyOn, (await w.user(Role.ADMIN)).id);
        let expectedShopify = 0;
        for (const c of await creators(w)) {
          const r = await w.create(c.u, c.leadId, "COD", { idempotencyKey: `k-${uid()}` });
          const row = await metaOf(tx, r.order.id);
          const ships = await shipmentsOf(tx, r.order.id);
          assert.equal(ships.length, 1, `${c.label}: one Shiprocket shipment`);
          assert.equal(ships[0]!.channelOrderId, expectedRef(row), shopifyOn ? "Shopify ON: the Shopify order reference is the Shiprocket order id" : "Shopify OFF: the CRM order number is the Shiprocket order id");
          assert.ok(ships[0]!.externalId && !ships[0]!.externalId.startsWith("pending:"));
          assert.equal(sr.sent.at(-1)!.order_id, expectedRef(row));
          assert.equal(readShiprocketSync(row.metadata)!.crmOrderNumber, row.orderNumber, "the CRM order number is kept for reconciliation");
          assert.equal(sr.sent.at(-1)!.payment_method, "COD");
          const rec = readShiprocketSync(row.metadata)!;
          assert.equal(rec.status, "SYNCED");
          assert.equal(rec.attempts, 1, "created on the first attempt");
          assert.ok(rec.shiprocketOrderId && rec.syncedAt);
          // Shopify is independent: OFF -> no order and no link; ON -> exactly one
          if (shopifyOn) { expectedShopify++; assert.ok(row.externalId, `${c.label}: Shopify order linked`); } else assert.equal(row.externalId, null, `${c.label}: no Shopify order`);
          assert.equal(w.shop.created.length, expectedShopify);
          assert.equal(row.status, "CONFIRMED");
          // a repeated submission (retry button, repeated request) creates nothing new
          assert.equal((await w.orders.retryShiprocketSync({ id: c.u.id, username: c.u.username, role: c.u.role } as never, r.order.id)).status, "SYNCED");
        }
        assert.equal(sr.sent.length, 3, "Shiprocket received exactly one order per CRM order");
      }));
    });
  }

  it("a repeated createManualOrder request with the same idempotency key creates one order and one Shiprocket order", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const input = { idempotencyKey: `k-${uid()}` };
      const a = await w.create(c!.u, c!.leadId, "COD", input);
      const b = await w.create(c!.u, c!.leadId, "COD", input);
      assert.equal(a.order.id, b.order.id);
      assert.equal(sr.sent.length, 1);
      assert.equal((await shipmentsOf(tx, a.order.id)).length, 1);
    }));
  });
});

describe("prepaid: submitted only after the payment is verified", () => {
  for (const shopifyOn of [false, true]) {
    it(`Shopify sync ${shopifyOn ? "ON" : "OFF"}: nothing before payment; exactly one Shiprocket order after; a replayed payment callback adds none`, async () => {
      await withEnv(ENV_ON, () => inRollback(async (tx) => {
        const sr = fakeShiprocket();
        const w = await world(tx, sr);
        await writeShopifySyncSetting(tx as never, shopifyOn, (await w.user(Role.ADMIN)).id);
        for (const c of await creators(w)) {
          const before = sr.sent.length;
          const r = await w.create(c.u, c.leadId, "PAYMENT_LINK");
          assert.equal((await metaOf(tx, r.order.id)).status, "PENDING_PAYMENT");
          assert.equal(sr.sent.length, before, `${c.label}: unpaid prepaid order is NOT sent to Shiprocket`);
          assert.equal(readShiprocketSync((await metaOf(tx, r.order.id)).metadata)?.status, "AWAITING_PAYMENT");
          assert.equal((await shipmentsOf(tx, r.order.id)).length, 0);

          // the payment is verified (Cashfree result already applied): the shared confirmation step runs
          // (the Cashfree link creation is stubbed here, so the verified payment row is created the way the webhook leaves it)
          const total = (await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { totalAmount: true } })).totalAmount;
          await tx.payment.create({ data: { orderId: r.order.id, amount: total, currency: "INR", method: "PAYMENT_LINK", status: "SUCCESS", provider: "CASHFREE", externalSource: "CASHFREE", externalId: `cf-${uid()}`, paidAt: new Date() } });
          const deps = { runner: { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) } as never, getShopifyClient: () => w.shop.client, submitToShiprocket: (id: string) => syncOrderToShiprocket({ db: tx as never, service: w.service }, id, { id: c.u.id, username: c.u.username, role: c.u.role } as never, "PAYMENT_VERIFIED") };
          for (let i = 0; i < 2; i++) await confirmAndSyncPaidOrder(deps, r.order.id, { source: "CASHFREE_WEBHOOK" } as never, () => new Date());
          assert.equal(sr.sent.length, before + 1, `${c.label}: exactly one Shiprocket order after payment, despite a replayed callback`);
          const row = await metaOf(tx, r.order.id);
          assert.equal(sr.sent.at(-1)!.payment_method, "Prepaid");
          assert.equal(sr.sent.at(-1)!.order_id, expectedRef(row));
          assert.equal(readShiprocketSync(row.metadata)!.status, "SYNCED");
          assert.equal(row.status, "CONFIRMED");
          if (!shopifyOn) assert.equal(row.externalId, null, "Shopify OFF: no Shopify order even after payment");
        }
        assert.equal(w.shop.created.length, shopifyOn ? 3 : 0);
      }));
    });
  }
});

describe("failed and uncertain submissions never produce a duplicate", () => {
  it("a definite refusal: the CRM order is kept, the failure is saved, and one retry creates exactly one Shiprocket order", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      let refuse = true;
      const sr = fakeShiprocket({ fail: () => (refuse ? new ProviderHttpError("SHIPROCKET", 422, "Pickup location not found", false) : null) });
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const r = await w.create(c!.u, c!.leadId, "COD");
      let row = await metaOf(tx, r.order.id);
      assert.equal(row.status, "CONFIRMED", "the CRM order is saved");
      let rec = readShiprocketSync(row.metadata)!;
      assert.equal(rec.status, "FAILED");
      assert.match(rec.error ?? "", /Pickup location not found/);
      refuse = false;
      const actor = { id: c!.u.id, username: c!.u.username, role: c!.u.role } as never;
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      row = await metaOf(tx, r.order.id);
      rec = readShiprocketSync(row.metadata)!;
      assert.deepEqual([rec.status, rec.attempts, rec.error], ["SYNCED", 2, null]);
      assert.equal(sr.sent.length, 1);
      assert.equal((await shipmentsOf(tx, r.order.id)).filter((s) => s.status !== "CANCELLED").length, 1);
    }));
  });

  it("an outage of unknown outcome stays FAILED and is never re-sent automatically or by the retry button", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      let calls = 0;
      const sr = fakeShiprocket({ fail: () => { calls++; return new ProviderHttpError("SHIPROCKET", null, "timeout", true); } });
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const r = await w.create(c!.u, c!.leadId, "COD");
      assert.equal(calls, 1);
      const out = await w.orders.retryShiprocketSync({ id: c!.u.id, username: c!.u.username, role: c!.u.role } as never, r.order.id);
      assert.equal(out.status, "FAILED");
      assert.match(out.reason ?? "", /may already exist in Shiprocket/);
      assert.equal(calls, 1, "no second request was sent to Shiprocket");
      assert.equal(sr.sent.length, 0);
    }));
  });
});

describe("configuration and manual retry of existing orders", () => {
  it("a product with missing dimensions: the order is kept, the exact SKU and fields are reported, nothing is sent; after the product is corrected the retry registers it once", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const actor = { id: c!.u.id, username: c!.u.username, role: c!.u.role } as never;
      await tx.product.update({ where: { id: w.product.id }, data: { widthCm: null, heightCm: "0" } });
      const sku = (await tx.product.findUniqueOrThrow({ where: { id: w.product.id }, select: { sku: true } })).sku;
      const r = await w.create(c!.u, c!.leadId, "COD");
      const row = await metaOf(tx, r.order.id);
      assert.equal(row.status, "CONFIRMED");
      const rec = readShiprocketSync(row.metadata)!;
      assert.equal(rec.status, "FAILED");
      assert.ok((rec.error ?? "").includes(`${sku} (Herbal Masala): breadth, height`), rec.error ?? "");
      assert.equal(sr.sent.length, 0);
      assert.equal((await shipmentsOf(tx, r.order.id)).length, 0);
      await tx.product.update({ where: { id: w.product.id }, data: { widthCm: "8", heightCm: "5" } });
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      assert.equal(sr.sent.length, 1);
      assert.deepEqual([sr.sent[0]!.weight, sr.sent[0]!.length, sr.sent[0]!.breadth, sr.sent[0]!.height], [0.25, 10, 8, 5]);
    }));
  });

  it("an order with two products and different quantities: weight is the sum of weight x quantity, size is the largest of each side; Shopify ON and OFF alike", async () => {
    for (const shopifyOn of [false, true]) {
      await withEnv(ENV_ON, () => inRollback(async (tx) => {
        const sr = fakeShiprocket();
        const w = await world(tx, sr);
        await writeShopifySyncSetting(tx as never, shopifyOn, (await w.user(Role.ADMIN)).id);
        const [c] = await creators(w);
        const r = await w.orders.createManualOrder({ id: c!.u.id, username: c!.u.username, role: c!.u.role } as never, { leadId: c!.leadId, items: [{ productId: w.product.id, quantity: 3, unitPrice: "1199.00" }, { productId: w.product2.id, quantity: 2, unitPrice: "299.00" }], paymentMethod: "COD", shippingAddress: ADDRESS, shippingPincode: "411001" } as never);
        assert.equal(sr.sent.length, 1);
        assert.deepEqual([sr.sent[0]!.weight, sr.sent[0]!.length, sr.sent[0]!.breadth, sr.sent[0]!.height], [2.25, 14, 8, 9], "3x0.25 + 2x0.75; max(10,14) x max(8,6) x max(5,9)");
        assert.equal(sr.sent[0]!.order_id, expectedRef(await metaOf(tx, r.order.id)));
        assert.equal(w.shop.created.length, shopifyOn ? 1 : 0);
        assert.equal((await shipmentsOf(tx, r.order.id)).length, 1);
      }));
    }
  });

  it("Shiprocket not enabled is recorded as NOT_CONFIGURED and the order is still created", async () => {
    await withEnv({}, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const r = await w.create(c!.u, c!.leadId, "COD");
      assert.equal(readShiprocketSync((await metaOf(tx, r.order.id)).metadata)!.status, "NOT_CONFIGURED");
      assert.equal((await metaOf(tx, r.order.id)).status, "CONFIRMED");
      assert.equal(sr.sent.length, 0);
    }));
  });

  it("an order created BEFORE this feature (no Shiprocket record) can be retried once safely; a second retry submits nothing", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      // build the order as an older version stored it: no shiprocketSync and no shopifySyncDecision in the metadata
      const r = await w.create(c!.u, c!.leadId, "COD");
      await tx.shipment.deleteMany({ where: { orderId: r.order.id } });
      await tx.$executeRaw`UPDATE orders SET metadata = metadata - 'shiprocketSync' - 'shopifySyncDecision' WHERE id = ${r.order.id}::uuid`;
      sr.sent.length = 0;
      const actor = { id: c!.u.id, username: c!.u.username, role: c!.u.role } as never;
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      assert.equal(sr.sent.length, 1);
    }));
  });

  it("the retry honours the caller's scope: a Telecaller cannot retry another team's order; a Shopify-originated order is never submitted", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const stranger = await w.user(Role.SALESPERSON);
      const r = await w.create(c!.u, c!.leadId, "COD");
      await assert.rejects(w.orders.retryShiprocketSync({ id: stranger.id, username: stranger.username, role: Role.SALESPERSON } as never, r.order.id), (e: any) => e.statusCode === 404);
      await tx.order.update({ where: { id: r.order.id }, data: { source: "SHOPIFY" } });
      await tx.shipment.deleteMany({ where: { orderId: r.order.id } });
      sr.sent.length = 0;
      const out = await syncOrderToShiprocket({ db: tx as never, service: w.service }, r.order.id, { id: c!.u.id, username: c!.u.username, role: c!.u.role } as never, "RETRY");
      assert.equal(out.status, "NOT_APPLICABLE");
      assert.equal(sr.sent.length, 0);
    }));
  });
});

describe("delivery address: edited in the CRM, saved on the right order, and what Shiprocket receives", () => {
  // what the CRM's own forms save (line1 / line2 / state / pincode), NOT the Shopify names
  const CRM_ADDRESS = { name: "Priya Shah", phone: "9876500000", line1: "Flat 101, Sunshine Apartments", line2: "Link Road, Near City Mall", city: "Mumbai", state: "Maharashtra", pincode: "400017" };
  const actorOf = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role }) as never;

  it("an order created with a complete address in the CRM's own shape is registered at once (the original bug)", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const r = await w.create(c!.u, c!.leadId, "COD", { shippingAddress: CRM_ADDRESS, shippingPincode: "400017" });
      assert.equal(readShiprocketSync((await metaOf(tx, r.order.id)).metadata)!.status, "SYNCED");
      const sent = sr.sent[0] as unknown as Record<string, string>;
      assert.deepEqual([sent.billing_address, sent.billing_address_2, sent.billing_city, sent.billing_state, sent.billing_pincode], ["Flat 101, Sunshine Apartments", "Link Road, Near City Mall", "Mumbai", "Maharashtra", "400017"]);
    }));
  });

  it("incomplete address -> failed with the exact missing fields -> edit through the real address editor -> retry uses the saved, corrected values", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const actor = actorOf(c!.u);
      await writeShopifySyncSetting(tx as never, false, (await w.user(Role.ADMIN)).id); // CRM-only orders: the address edit then makes no Shopify call
      const other = await w.create(c!.u, c!.leadId, "COD", { shippingAddress: { ...CRM_ADDRESS, line1: "Somewhere Else 9", city: "Delhi", state: "Delhi", pincode: "110001" }, shippingPincode: "110001" });
      const base = sr.sent.length; // the fake numbers its Shiprocket ids by call, so it is never reset inside one database

      // 1. an order whose address has only a city: nothing is sent, the exact parts are named, no shipment is reserved
      const r = await w.create(c!.u, c!.leadId, "COD", { shippingAddress: { name: "Priya Shah", phone: "9876500000", city: "Mumbai" }, shippingPincode: undefined });
      const failed = readShiprocketSync((await metaOf(tx, r.order.id)).metadata)!;
      assert.equal(failed.status, "FAILED");
      assert.ok((failed.error ?? "").includes("missing: shipping address line 1, state, 6-digit pincode"), failed.error ?? "");
      assert.ok(!(failed.error ?? "").includes("city"));
      assert.equal(sr.sent.length, base);
      assert.equal((await shipmentsOf(tx, r.order.id)).length, 0);

      // 2. retrying WITHOUT correcting anything keeps failing with the same, precise reason (no stale success, no dummy address)
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "FAILED");
      assert.equal(sr.sent.length, base);

      // 3. the address is edited with the real editor (this is what the CRM order page calls)
      const edit = new OrderEditService(tx as never, () => { throw new Error("the order is not linked to Shopify: no Shopify call may happen"); });
      const done = await edit.updateAddress(actor, r.order.id, { line1: "Flat 101, Sunshine Apartments", line2: "Link Road, Near City Mall", city: "Mumbai", state: "Maharashtra", pincode: "400017" });
      assert.equal(done.shopify, "not_linked");

      // 4. persisted on THIS order only
      const saved = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { shippingAddress: true, shippingPincode: true } });
      assert.deepEqual([(saved.shippingAddress as Record<string, string>).line1, (saved.shippingAddress as Record<string, string>).state, (saved.shippingAddress as Record<string, string>).pincode, saved.shippingPincode], ["Flat 101, Sunshine Apartments", "Maharashtra", "400017", "400017"]);
      const untouched = await tx.order.findUniqueOrThrow({ where: { id: other.order.id }, select: { shippingAddress: true, shippingPincode: true } });
      assert.equal((untouched.shippingAddress as Record<string, string>).line1, "Somewhere Else 9");
      assert.equal(untouched.shippingPincode, "110001");

      // 5. the retry reads the latest saved address and registers the order exactly once with the corrected values
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      assert.equal((await w.orders.retryShiprocketSync(actor, r.order.id)).status, "SYNCED");
      assert.equal(sr.sent.length, base + 1);
      const sent = sr.sent[base] as unknown as Record<string, string>;
      assert.deepEqual([sent.billing_address, sent.billing_address_2, sent.billing_city, sent.billing_state, sent.billing_pincode], ["Flat 101, Sunshine Apartments", "Link Road, Near City Mall", "Mumbai", "Maharashtra", "400017"]);
      assert.equal(typeof sent.billing_pincode, "string");
      const rec = readShiprocketSync((await metaOf(tx, r.order.id)).metadata)!;
      assert.deepEqual([rec.status, rec.error], ["SYNCED", null]);
    }));
  });

  it("a malformed pincode in the saved address is reported with its value and nothing is sent", async () => {
    await withEnv(ENV_ON, () => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const [c] = await creators(w);
      const r = await w.create(c!.u, c!.leadId, "COD", { shippingAddress: { ...CRM_ADDRESS, pincode: "4000" }, shippingPincode: undefined });
      const rec = readShiprocketSync((await metaOf(tx, r.order.id)).metadata)!;
      assert.equal(rec.status, "FAILED");
      assert.ok((rec.error ?? "").includes('6-digit pincode (the saved value "4000" is not 6 digits)'), rec.error ?? "");
      assert.equal(sr.sent.length, 0);
    }));
  });
});
