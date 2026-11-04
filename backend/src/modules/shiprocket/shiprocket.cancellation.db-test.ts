// Database integration tests: cancelling a CRM order cancels its Shiprocket order. Run with: npm run test:db  (ISOLATED database only)
//
// Every test runs inside ONE transaction that is always rolled back. The real createManualOrder, cancelOrder, Shiprocket shipment service and cancellation code run against real tables;
// Shopify, Cashfree, WhatsApp and Shiprocket are fakes that record what they were sent, so no provider is contacted and no credential is needed.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "../orders/orders.service.js";
import { writeShopifySyncSetting } from "../settings/shopify-sync.setting.js";
import { applyShipmentUpdate } from "./shiprocket.apply.js";
import { readShiprocketCancellation } from "./shiprocket.cancellation.js";
import ShiprocketShipmentsService, { type ShiprocketApi, type ShiprocketCancelApi } from "./shiprocket.shipments.service.js";
import { loadShiprocketConfig } from "./shiprocket.config.js";

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
const ADDRESS = { name: "Priya Shah", line1: "12 MG Road", line2: "Near park", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", phone: "9876500000" };

async function withEnv(fn: () => Promise<void>) {
  const saved = process.env.SHIPROCKET_ENABLED;
  process.env.SHIPROCKET_ENABLED = "true";
  try { await fn(); } finally { if (saved === undefined) delete process.env.SHIPROCKET_ENABLED; else process.env.SHIPROCKET_ENABLED = saved; }
}

/** Shiprocket that accepts order creation, and records every cancellation-related call. */
function fakeShiprocket() {
  const sent: { order_id: string }[] = [];
  const api: ShiprocketApi = {
    createOrder: async (r) => { sent.push(r as never); return { orderId: `SR-${sent.length}`, shipmentId: `SRS-${sent.length}`, awb: null, courierName: null, courierCompanyId: null } as never; },
    getCouriers: async () => [], assignAwb: async () => ({ awb: "AWB77", courierName: "Test Courier", courierCompanyId: 9 }), generatePickup: async () => ({ scheduledDate: null, tokenNumber: null }), generateLabel: async () => "x", track: async () => null,
  };
  const cancel = {
    calls: [] as string[],
    orderIds: [] as string[],
    /** what Shiprocket says the order's status is when asked */
    status: "CANCELED" as string | null,
    readFails: false,
    failAwb: null as (() => Error) | null,
    failOrder: null as (() => Error) | null,
    /** the cancel request is accepted but its reply is lost (the order IS cancelled at Shiprocket) */
    loseReply: false,
    /** an accepted request makes Shiprocket show the order as cancelled from then on */
    flipOnAccept: false,
  };
  const cancelApi: ShiprocketCancelApi = {
    cancelAwbs: async (awbs) => { cancel.calls.push(`awb:${awbs.join(",")}`); if (cancel.failAwb) throw cancel.failAwb(); return { message: "AWB cancelled", raw: '{"message":"AWB cancelled"}' }; },
    cancelOrders: async (ids) => {
      cancel.calls.push(`order:${ids.join(",")}`);
      cancel.orderIds.push(...ids);
      if (cancel.failOrder) throw cancel.failOrder();
      if (cancel.loseReply) { cancel.loseReply = false; cancel.status = "CANCELED"; throw new ProviderHttpError("SHIPROCKET", null, "The provider did not respond in time", true); }
      if (cancel.flipOnAccept) cancel.status = "CANCELED";
      return { message: "Order cancelled successfully.", raw: '{"message":"Order cancelled successfully."}' };
    },
    getOrderStatus: async () => { cancel.calls.push("status"); if (cancel.readFails) throw new ProviderHttpError("SHIPROCKET", 503, "unavailable", true); return cancel.status; },
  };
  return { api, sent, cancel, cancelApi };
}

function fakeShopify() {
  const cancelled: string[] = [];
  const created: string[] = [];
  const client = { query: async (document: string) => {
    if (/orderCreate/.test(document)) { created.push("x"); return { orderCreate: { order: { id: `gid://shopify/Order/${created.length}`, name: `#T${created.length}` }, userErrors: [] } }; }
    if (/orderCancel\(/.test(document)) { cancelled.push("x"); return { orderCancel: { job: { done: true }, orderCancelUserErrors: [] } }; }
    return { order: { id: "gid://shopify/Order/1", tags: [], cancelledAt: null }, orders: { nodes: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
  } } as unknown as ShopifyClient;
  return { client, created, cancelled };
}

async function world(tx: Prisma.TransactionClient, sr: ReturnType<typeof fakeShiprocket>, config: () => typeof CONFIG = () => CONFIG) {
  const shop = fakeShopify();
  const runner = { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) };
  const service = new ShiprocketShipmentsService(runner as never, { config, client: () => sr.api, cancelClient: () => sr.cancelApi });
  const noMessages = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const cashfree = (() => ({ createPaymentLink: async () => ({ reused: false, paymentId: uid(), paymentUrl: "https://pay.test/x", expiresAt: null }), cancelPaymentLink: async () => undefined })) as never;
  const orders = new OrdersService(tx as never, () => shop.client, cashfree, noMessages, () => service);
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "1199.00", weightKg: "0.25", lengthCm: "10", widthCm: "8", heightCm: "5" }, select: { id: true } });
  const user = async (role: Role) => tx.user.create({ data: { name: `${role} user`, username: `u-${uid()}`, role }, select: { id: true, username: true, role: true } });
  const lead = async (ownerId: string, groupId?: string) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "+919876500000", email: "p@zz.invalid", ownerId, ...(groupId ? { groupId } : {}) }, select: { id: true } });
  const create = (u: { id: string; username: string; role: Role }, leadId: string, extra: Record<string, unknown> = {}) =>
    orders.createManualOrder({ id: u.id, username: u.username, role: u.role } as never, { leadId, items: [{ productId: product.id, quantity: 1, unitPrice: "1199.00" }], paymentMethod: "COD", shippingAddress: ADDRESS, shippingPincode: "411001", idempotencyKey: `k-${uid()}`, ...extra } as never);
  return { tx, shop, orders, service, user, lead, create };
}
type World = Awaited<ReturnType<typeof world>>;

/** A telecaller with a COD order already registered in Shiprocket (as CRM-created orders are). */
async function submitted(w: World, role: Role = Role.SALESPERSON) {
  const u = await w.user(role);
  const group = role === Role.MANAGER ? await w.tx.group.create({ data: { name: `G-${uid()}`, managerId: u.id }, select: { id: true } }) : null;
  const lead = await w.lead(u.id, group?.id);
  const actor = { id: u.id, username: u.username, role: u.role } as never;
  const r = await w.create(u, lead.id);
  return { u, actor, orderId: r.order.id, orderNumber: r.order.orderNumber };
}
const rowOf = (tx: Prisma.TransactionClient, orderId: string) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, metadata: true, cancelledAt: true, orderNumber: true } });
const recOf = async (tx: Prisma.TransactionClient, orderId: string) => readShiprocketCancellation((await rowOf(tx, orderId)).metadata);
const shipmentOf = (tx: Prisma.TransactionClient, orderId: string) => tx.shipment.findFirstOrThrow({ where: { orderId, externalSource: "SHIPROCKET" }, orderBy: { createdAt: "desc" } });

describe("CRM cancellation cancels the Shiprocket order", () => {
  for (const role of [Role.SALESPERSON, Role.ADMIN, Role.MANAGER]) {
    it(`${role}: the stored Shiprocket order id is cancelled, and only after Shiprocket shows it cancelled does the CRM say Cancelled`, async () => {
      await withEnv(() => inRollback(async (tx) => {
        const sr = fakeShiprocket();
        const w = await world(tx, sr);
        const o = await submitted(w, role);
        const out = await w.orders.cancelOrder(o.actor, o.orderId, { reason: "Customer changed mind" });

        assert.equal(out.order.status, "CANCELLED");
        assert.deepEqual(sr.cancel.orderIds, ["SR-1"], "Shiprocket's own order id - not the CRM order number or the channel order id");
        assert.ok(!sr.cancel.orderIds.includes(o.orderNumber));
        assert.deepEqual(sr.cancel.calls, ["order:SR-1", "status"], "no AWB: no AWB call; the status is read back");
        const rec = (await recOf(tx, o.orderId))!;
        assert.equal(rec.status, "CANCELLED");
        assert.equal(rec.attempts, 1);
        assert.equal(rec.shiprocketOrderId, "SR-1");
        assert.ok(rec.requestedAt && rec.cancelledAt && rec.lastAttemptAt, "timestamps recorded");
        assert.match(rec.response ?? "", /cancelled successfully/, "Shiprocket's reply is kept");
        assert.equal(rec.error, null);
        assert.equal((await shipmentOf(tx, o.orderId)).status, "CANCELLED", "the CRM shipment follows");
        assert.deepEqual(out.order.shiprocketCancellation?.status, "CANCELLED", "and the order page can show it");
      }));
    });
  }

  it("an order that was never in Shiprocket: nothing is sent and no Shiprocket status appears", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const u = await w.user(Role.SALESPERSON);
      const lead = await w.lead(u.id);
      const r = await w.create(u, lead.id, { paymentMethod: "PAYMENT_LINK" }); // prepaid, unpaid: waits for payment, never submitted
      await w.orders.cancelOrder({ id: u.id, username: u.username, role: u.role } as never, r.order.id, {});
      assert.deepEqual(sr.cancel.calls, []);
      assert.equal(await recOf(tx, r.order.id), null);
    }));
  });
});

describe("never Cancelled before Shiprocket confirms; never a duplicate request", () => {
  it("accepted but not yet shown as cancelled = Cancellation Requested; repeated clicks and retries send nothing more; the check later confirms", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      sr.cancel.status = "READY TO SHIP";
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      let rec = (await recOf(tx, o.orderId))!;
      assert.equal(rec.status, "REQUESTED");
      assert.equal(rec.cancelledAt, null, "not confirmed, so no cancelled time");
      assert.equal((await shipmentOf(tx, o.orderId)).status, "CREATED", "the shipment is not marked cancelled either");

      for (let i = 0; i < 3; i++) {
        await w.orders.cancelOrder(o.actor, o.orderId, {}); // repeated clicks
        assert.equal((await w.orders.retryShiprocketCancellation(o.actor, o.orderId)).status, "REQUESTED"); // retry button = a check only
      }
      assert.equal(sr.cancel.calls.filter((c) => c.startsWith("order:")).length, 1, "exactly one cancellation request in total");
      assert.equal((await recOf(tx, o.orderId))!.attempts, 1);

      sr.cancel.status = "CANCELED";
      assert.equal((await w.orders.retryShiprocketCancellation(o.actor, o.orderId)).status, "CANCELLED");
      rec = (await recOf(tx, o.orderId))!;
      assert.ok(rec.status === "CANCELLED" && rec.cancelledAt);
      assert.equal(sr.cancel.calls.filter((c) => c.startsWith("order:")).length, 1, "still one request");
      assert.equal((await shipmentOf(tx, o.orderId)).status, "CANCELLED");
    }));
  });

  it("if Shiprocket can not be read after the request is accepted, it stays Requested (never assumed Cancelled)", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      sr.cancel.readFails = true;
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal((await recOf(tx, o.orderId))!.status, "REQUESTED");
    }));
  });

  it("Shiprocket's own tracking webhook (status CANCELED) confirms a requested cancellation", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      sr.cancel.status = "NEW";
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal((await recOf(tx, o.orderId))!.status, "REQUESTED");
      const s = await shipmentOf(tx, o.orderId);
      await applyShipmentUpdate(tx as never, s.id, { status: "CANCELLED", providerStatus: "CANCELED" }, { source: ActivitySource.SHIPROCKET_WEBHOOK });
      const rec = (await recOf(tx, o.orderId))!;
      assert.ok(rec.status === "CANCELLED" && rec.cancelledAt);
    }));
  });

  it("two cancellations at the same moment send one request", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      // a cancelled-in-CRM order whose Shiprocket record is mid-flight (PENDING, just claimed) must not be sent again
      await tx.$executeRaw`UPDATE orders SET metadata = jsonb_set(metadata, '{shiprocketCancellation}', jsonb_build_object('status','PENDING','attempts',1,'shiprocketOrderId','SR-1','lastAttemptAt', ${new Date().toISOString()}::text, 'awbCancelled', false)) WHERE id = ${o.orderId}::uuid`;
      await tx.shipment.updateMany({ where: { orderId: o.orderId }, data: { status: "CREATED" } });
      const before = sr.cancel.calls.length;
      const out = await Promise.all([w.service.cancelForOrder(o.orderId), w.service.cancelForOrder(o.orderId)]);
      assert.deepEqual(out.map((x) => x.status), ["PENDING", "PENDING"]);
      assert.equal(sr.cancel.calls.length, before, "nothing was sent while a request is in flight");
    }));
  });
});

describe("with and without an AWB", () => {
  it("AWB assigned, before pickup: the courier booking is cancelled first, then the order", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const o = await submitted(w);
      const s = await shipmentOf(tx, o.orderId);
      await w.service.assignAwb(o.actor, s.id, 9);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.deepEqual(sr.cancel.calls, ["awb:AWB77", "order:SR-1", "status"]);
      const rec = (await recOf(tx, o.orderId))!;
      assert.deepEqual([rec.status, rec.awb, rec.awbCancelled], ["CANCELLED", "AWB77", true]);
      assert.match(rec.awbResponse ?? "", /AWB cancelled/);
      assert.equal((await shipmentOf(tx, o.orderId)).status, "CANCELLED");
    }));
  });

  it("pickup scheduled (still before pickup): cancelled the same way", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const o = await submitted(w);
      const s = await shipmentOf(tx, o.orderId);
      await w.service.assignAwb(o.actor, s.id, 9);
      await w.service.schedulePickup(o.actor, s.id);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.deepEqual(sr.cancel.calls, ["awb:AWB77", "order:SR-1", "status"]);
      assert.equal((await recOf(tx, o.orderId))!.status, "CANCELLED");
    }));
  });

  it("already picked up / shipped: nothing is sent; the CRM cancellation stands and the page says why Shiprocket was not cancelled", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const o = await submitted(w);
      const s = await shipmentOf(tx, o.orderId);
      await w.service.assignAwb(o.actor, s.id, 9);
      await applyShipmentUpdate(tx as never, s.id, { status: "SHIPPED", providerStatus: "PICKED UP" }, { source: ActivitySource.SHIPROCKET_WEBHOOK });
      const out = await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal(out.order.status, "CANCELLED", "the CRM order is cancelled regardless");
      assert.deepEqual(sr.cancel.calls, [], "Shiprocket is not asked to cancel a parcel the courier already has");
      const rec = (await recOf(tx, o.orderId))!;
      assert.equal(rec.status, "FAILED");
      assert.match(rec.error ?? "", /already PICKED UP.*can no longer cancel/);
      assert.equal(rec.attempts, 0, "no request was sent");
      assert.equal((await shipmentOf(tx, o.orderId)).status, "SHIPPED", "its tracking is untouched");
      // retrying changes nothing and still sends nothing
      assert.equal((await w.orders.retryShiprocketCancellation(o.actor, o.orderId)).status, "FAILED");
      assert.deepEqual(sr.cancel.calls, []);
    }));
  });
});

describe("Shiprocket refuses, or is unavailable, and the retry", () => {
  it("a refusal shows Shiprocket's actual reason; the CRM stays cancelled; a later retry succeeds with one more request", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      sr.cancel.status = "READY TO SHIP"; // Shiprocket still shows the order as live until it is really cancelled
      sr.cancel.failOrder = () => new ProviderHttpError("SHIPROCKET", 400, "Order cannot be cancelled as the pickup is already completed", false);
      const w = await world(tx, sr);
      const o = await submitted(w);
      const out = await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal(out.order.status, "CANCELLED");
      let rec = (await recOf(tx, o.orderId))!;
      assert.equal(rec.status, "FAILED");
      assert.match(rec.error ?? "", /pickup is already completed/);
      assert.equal(rec.attempts, 1);
      assert.equal(out.order.shiprocketCancellation?.error, rec.error);

      sr.cancel.failOrder = null;
      sr.cancel.flipOnAccept = true;
      assert.equal((await w.orders.retryShiprocketCancellation(o.actor, o.orderId)).status, "CANCELLED");
      rec = (await recOf(tx, o.orderId))!;
      assert.deepEqual([rec.status, rec.attempts, rec.error], ["CANCELLED", 2, null]);
      assert.equal(sr.cancel.orderIds.length, 2, "one failed request and one successful request");
    }));
  });

  it("Shiprocket unavailable: the CRM cancellation is kept, the failure is recorded, and the retry is safe", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      sr.cancel.failOrder = () => new ProviderHttpError("SHIPROCKET", 503, "Service Unavailable", true);
      const w = await world(tx, sr);
      const o = await submitted(w);
      const out = await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal(out.order.status, "CANCELLED");
      assert.equal((await recOf(tx, o.orderId))!.status, "FAILED");
      // cancelling again from the CRM (a repeated click) retries what is outstanding
      sr.cancel.failOrder = null;
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal((await recOf(tx, o.orderId))!.status, "CANCELLED");
    }));
  });

  it("Shiprocket not configured: recorded as failed for a retry, the CRM cancellation is kept", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      let configured = true;
      const w = await world(tx, sr, () => { if (!configured) throw new Error("Shiprocket is not configured: SHIPROCKET_EMAIL"); return CONFIG; });
      const o = await submitted(w);
      configured = false;
      const out = await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal(out.order.status, "CANCELLED");
      const rec = (await recOf(tx, o.orderId))!;
      assert.equal(rec.status, "FAILED");
      assert.match(rec.error ?? "", /not configured/);
      configured = true;
      assert.equal((await w.orders.retryShiprocketCancellation(o.actor, o.orderId)).status, "CANCELLED");
    }));
  });

  it("the reply to the request was lost but Shiprocket did cancel: the retry checks first and sends nothing again", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      sr.cancel.status = "READY TO SHIP";
      sr.cancel.loseReply = true; // the request goes through at Shiprocket (status becomes CANCELED) but no reply arrives
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal((await recOf(tx, o.orderId))!.status, "FAILED");
      assert.equal((await w.orders.retryShiprocketCancellation(o.actor, o.orderId)).status, "CANCELLED");
      assert.equal(sr.cancel.orderIds.length, 1, "the retry did not send a second cancellation");
    }));
  });

  it("the AWB booking cancelled but the order refused: the retry does not cancel the AWB again", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.service.assignAwb(o.actor, (await shipmentOf(tx, o.orderId)).id, 9);
      sr.cancel.failOrder = () => new ProviderHttpError("SHIPROCKET", 400, "Order is locked", false);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal((await recOf(tx, o.orderId))!.awbCancelled, true);
      sr.cancel.failOrder = null;
      sr.cancel.status = "NEW";
      await w.orders.retryShiprocketCancellation(o.actor, o.orderId);
      assert.equal(sr.cancel.calls.filter((c) => c.startsWith("awb:")).length, 1);
    }));
  });

  it("the AWB cancellation itself refused: the reason says it was the courier booking", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.service.assignAwb(o.actor, (await shipmentOf(tx, o.orderId)).id, 9);
      sr.cancel.failAwb = () => new ProviderHttpError("SHIPROCKET", 422, "AWB can not be cancelled after pickup", false);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      const rec = (await recOf(tx, o.orderId))!;
      assert.equal(rec.status, "FAILED");
      assert.match(rec.error ?? "", /courier booking \(AWB\).*AWB can not be cancelled after pickup/);
      assert.ok(!sr.cancel.calls.some((c) => c.startsWith("order:")), "the order is not cancelled while its booking is still live");
    }));
  });
});

describe("revert, and Shopify, are unaffected or protected", () => {
  it("Shopify cancellation is unchanged: one Shopify cancel, whatever Shiprocket does, and a Shopify failure does not stop Shiprocket", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      await writeShopifySyncSetting(tx as never, true, (await w.user(Role.ADMIN)).id);
      const o = await submitted(w);
      assert.ok((await rowOf(tx, o.orderId)) && (await tx.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { externalId: true } })).externalId, "linked to Shopify");
      sr.cancel.failOrder = () => new ProviderHttpError("SHIPROCKET", 503, "down", true);
      const out = await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal(out.shopify.status, "cancelled", "Shopify cancelled although Shiprocket failed");
      assert.equal(w.shop.cancelled.length, 1);
      assert.equal((await recOf(tx, o.orderId))!.status, "FAILED");
      // retrying the Shiprocket half never touches Shopify
      sr.cancel.failOrder = null;
      await w.orders.retryShiprocketCancellation(o.actor, o.orderId);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal(w.shop.cancelled.length, 1);
      const meta = (await rowOf(tx, o.orderId)).metadata as Record<string, unknown>;
      assert.equal((meta.shopifyCancellation as { status: string }).status, "cancelled", "the Shopify record survives the Shiprocket writes");
    }));
  });

  it("reverting is refused while Shiprocket is cancelling; after a failed request it is allowed and drops the stale failure", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      sr.cancel.status = "NEW";
      const w = await world(tx, sr);
      const o = await submitted(w);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      assert.equal((await recOf(tx, o.orderId))!.status, "REQUESTED");
      await assert.rejects(w.orders.revertCancellation(o.actor, o.orderId), (e: any) => e.statusCode === 409 && /Shiprocket is cancelling/.test(e.message));
      assert.equal((await rowOf(tx, o.orderId)).status, "CANCELLED");

      // a second order whose Shiprocket cancellation failed: nothing was cancelled there, so revert works
      const o2 = await submitted(w);
      sr.cancel.failOrder = () => new ProviderHttpError("SHIPROCKET", 503, "down", true);
      await w.orders.cancelOrder(o2.actor, o2.orderId, {});
      assert.equal((await recOf(tx, o2.orderId))!.status, "FAILED");
      const reverted = await w.orders.revertCancellation(o2.actor, o2.orderId);
      assert.equal(reverted.alreadyActive, false);
      assert.equal(await recOf(tx, o2.orderId), null);
    }));
  });

  it("out-of-scope users can not retry the Shiprocket cancellation, and an order that is not cancelled has none to retry", async () => {
    await withEnv(() => inRollback(async (tx) => {
      const sr = fakeShiprocket();
      const w = await world(tx, sr);
      const o = await submitted(w);
      await assert.rejects(w.orders.retryShiprocketCancellation(o.actor, o.orderId), (e: any) => e.statusCode === 409);
      await w.orders.cancelOrder(o.actor, o.orderId, {});
      const stranger = await w.user(Role.SALESPERSON);
      await assert.rejects(w.orders.retryShiprocketCancellation({ id: stranger.id, username: stranger.username, role: stranger.role } as never, o.orderId), (e: any) => e.statusCode === 404);
    }));
  });
});
