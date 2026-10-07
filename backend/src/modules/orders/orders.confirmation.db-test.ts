// "CRM Confirmed by <telecaller>": CRM persistence + Shopify tag sync, against the real schema with a stateful fake Shopify (tags are kept
// in memory, so "existing tags are preserved" and "no duplicates" are checked on real tag lists). No real Shopify call is ever made.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyGraphQLError, type ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "./orders.service.js";
import { recordConfirmation, syncConfirmationTag } from "./orders.confirmation.js";

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
const fakeNotify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;

function shopify(initialTags: string[] = []) {
  const state = { tags: [...initialTags], calls: [] as string[], failTags: false, failCreate: false, rejectAdd: false };
  const client = {
    query: async (doc: string, vars: { id?: string; tags?: string[] }) => {
      if (doc.includes("orderCreate")) {
        if (state.failCreate) throw new ShopifyGraphQLError("Shopify is down", []);
        state.calls.push("create");
        return { orderCreate: { order: { id: `gid://shopify/Order/${Math.floor(Math.random() * 1e9)}`, name: "#T1" }, userErrors: [] } };
      }
      if (state.failTags) throw new ShopifyGraphQLError("Access denied for tagsAdd field. Required access: write_orders access scope.", []);
      if (doc.includes("crmOrderTags")) { state.calls.push("read"); return { order: { id: vars.id, tags: [...state.tags] } }; }
      if (doc.includes("crmTagsAdd")) {
        state.calls.push("add");
        if (state.rejectAdd) return { tagsAdd: { userErrors: [{ message: "Order tags is invalid" }] } };
        for (const t of vars.tags ?? []) if (!state.tags.some((x) => x.toLowerCase() === t.toLowerCase())) state.tags.push(t);
        return { tagsAdd: { userErrors: [] } };
      }
      if (doc.includes("crmTagsRemove")) {
        state.calls.push("remove");
        state.tags = state.tags.filter((x) => !(vars.tags ?? []).some((t) => t.toLowerCase() === x.toLowerCase()));
        return { tagsRemove: { userErrors: [] } };
      }
      throw new Error(`unexpected Shopify call: ${doc.slice(0, 40)}`);
    },
  } as unknown as ShopifyClient;
  return { state, client };
}

async function world(tx: Prisma.TransactionClient, shop = shopify()) {
  const vini = await tx.user.create({ data: { name: "Vini", username: `vini-${uid()}`, role: Role.SALESPERSON } });
  const rahul = await tx.user.create({ data: { name: "Rahul", username: `rahul-${uid()}`, role: Role.SALESPERSON } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", mobile: "9000000777", normalizedMobile: "+919000000777", ownerId: vini.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Sleep Gummies", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "499.00" }, select: { id: true } });
  const svc = new OrdersService(tx as never, () => shop.client, undefined, fakeNotify);
  const as = (u: { id: string; username: string }) => ({ id: u.id, username: u.username, role: Role.SALESPERSON });
  const create = (u: { id: string; username: string }, extra: Record<string, unknown> = {}) => svc.createManualOrder(as(u), { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "499.00" }], paymentMethod: "COD", ...extra } as never);
  const row = (orderId: string) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, confirmedAt: true, confirmedByUserId: true, confirmedByName: true, externalId: true, metadata: true } });
  const tagState = async (orderId: string) => (((await row(orderId)).metadata ?? {}) as any).shopifyConfirmationTag;
  return { vini, rahul, lead, svc, as, create, row, tagState, shop, tx };
}
const TAG_VINI = "CRM Confirmed by Vini";

describe("telecaller confirms an order (Create Order, COD)", () => {
  it("stores the authenticated user as confirmer, shows the tag, writes the history, and tags the Shopify order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create(w.vini);
      const o = await w.row(r.order.id);
      assert.deepEqual([o.status, o.confirmedByUserId, o.confirmedByName], ["CONFIRMED", w.vini.id, "Vini"]);
      assert.ok(o.confirmedAt);
      assert.deepEqual([r.order.confirmedBy, r.order.confirmationTag], [{ id: w.vini.id, name: "Vini" }, TAG_VINI]);
      assert.deepEqual(w.shop.state.tags, [TAG_VINI]);
      assert.equal((await w.tagState(r.order.id)).status, "synced");
      const history = await tx.activity.findMany({ where: { orderId: r.order.id, type: "ORDER_CONFIRMED" } });
      assert.equal(history.length, 1);
      assert.match(history[0]!.title ?? "", /Order confirmed by Vini/);
      assert.equal(history[0]!.actorId, w.vini.id);
    });
  });
  it("the confirmer cannot be supplied by the client: a name/user in the request is ignored", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create(w.vini, { confirmedByName: "Rahul", confirmedByUserId: w.rahul.id, confirmationTag: "CRM Confirmed by Rahul" });
      assert.deepEqual([r.order.confirmedBy?.name, r.order.confirmationTag], ["Vini", TAG_VINI]);
      assert.deepEqual(w.shop.state.tags, [TAG_VINI]);
    });
  });
  it("abandoned checkout -> CRM order -> confirmed: the confirmer survives the conversion and reaches Shopify", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await tx.abandonment.create({ data: { leadId: w.lead.id, type: AbandonmentType.CHECKOUT, detectedAt: new Date(), cartSnapshot: { itemNames: ["Sleep Gummies"] } } });
      const r = await w.create(w.vini);
      assert.equal((await w.row(r.order.id)).confirmedByUserId, w.vini.id);
      assert.deepEqual(w.shop.state.tags, [TAG_VINI]);
    });
  });
});

describe("Shopify tags: preserved, idempotent, replaceable", () => {
  it("existing Shopify tags are kept; only the CRM tag is added", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, shopify(["VIP", "COD", "Campaign-Diwali"]));
      // The fake returns the same tag list for any created order id, so seed it on the order Shopify "creates".
      const r = await w.create(w.vini);
      assert.deepEqual(w.shop.state.tags, ["VIP", "COD", "Campaign-Diwali", TAG_VINI]);
      assert.equal(r.order.confirmationTag, TAG_VINI);
    });
  });
  it("running the sync again, or reconfirming as the same person, never duplicates the tag and makes no Shopify call", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create(w.vini);
      const before = w.shop.state.calls.length;
      assert.equal((await syncConfirmationTag(tx as never, r.order.id, { getShopifyClient: () => w.shop.client })).status, "unchanged");
      assert.equal((await recordConfirmation(tx as never, r.order.id, { id: w.vini.id, role: Role.SALESPERSON })).changed, false);
      await w.svc.pushOrderToShopify(w.as(w.vini), r.order.id); // already linked -> re-checks the tag, still nothing to do
      assert.equal(w.shop.state.calls.length, before, "no extra Shopify calls");
      assert.deepEqual(w.shop.state.tags, [TAG_VINI]);
      assert.equal((await tx.activity.count({ where: { orderId: r.order.id, type: "ORDER_CONFIRMED" } })), 1);
      // The manual retry re-checks Shopify (read) but still adds nothing.
      assert.equal((await w.svc.retryConfirmationTagSync(w.as(w.vini), r.order.id)).status, "synced");
      assert.deepEqual(w.shop.state.tags, [TAG_VINI]);
    });
  });
  it("a different confirmer REPLACES the CRM tag (Shopify never ends up with both), other tags untouched, history keeps both", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, shopify(["VIP"]));
      const r = await w.create(w.vini);
      const change = await recordConfirmation(tx as never, r.order.id, { id: w.rahul.id, role: Role.SALESPERSON });
      assert.deepEqual([change.changed, change.previousConfirmedByName, change.confirmedByName], [true, "Vini", "Rahul"]);
      const result = await syncConfirmationTag(tx as never, r.order.id, { getShopifyClient: () => w.shop.client });
      assert.deepEqual([result.status, result.tag], ["synced", "CRM Confirmed by Rahul"]);
      assert.deepEqual(w.shop.state.tags, ["VIP", "CRM Confirmed by Rahul"]);
      const detail = await w.svc.getOrder({ id: w.rahul.id, username: w.rahul.username, role: Role.ADMIN }, r.order.id);
      assert.deepEqual([detail.confirmedBy?.name, detail.confirmationTag], ["Rahul", "CRM Confirmed by Rahul"]);
      const history = await tx.activity.findMany({ where: { orderId: r.order.id, type: "ORDER_CONFIRMED" }, orderBy: { createdAt: "asc" } });
      assert.equal(history.length, 2);
      assert.match(history[1]!.title ?? "", /Rahul \(was Vini\)/);
    });
  });
});

describe("failure and retry; unsynced orders", () => {
  it("regression (found live): if Shopify refuses the NEW tag, the old confirmation tag is NOT removed; the retry completes the change", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, shopify(["VIP"]));
      const r = await w.create(w.vini);
      assert.deepEqual(w.shop.state.tags, ["VIP", TAG_VINI]);
      await recordConfirmation(tx as never, r.order.id, { id: w.rahul.id, role: Role.SALESPERSON });
      w.shop.state.rejectAdd = true;
      const failed = await syncConfirmationTag(tx as never, r.order.id, { getShopifyClient: () => w.shop.client });
      assert.equal(failed.status, "failed");
      assert.match(failed.reason ?? "", /Order tags is invalid/);
      assert.deepEqual(w.shop.state.tags, ["VIP", TAG_VINI], "the order still carries a confirmation tag");
      assert.equal((await w.tagState(r.order.id)).status, "failed");
      w.shop.state.rejectAdd = false;
      assert.equal((await w.svc.retryConfirmationTagSync(w.as(w.vini), r.order.id)).status, "synced");
      assert.deepEqual(w.shop.state.tags, ["VIP", "CRM Confirmed by Rahul"]);
    });
  });
  it("a Shopify tag failure never undoes the CRM confirmation; it is recorded, and a retry fixes it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.shop.state.failTags = true;
      const r = await w.create(w.vini);
      const o = await w.row(r.order.id);
      assert.deepEqual([o.status, o.confirmedByName], ["CONFIRMED", "Vini"], "CRM confirmation stands");
      const state = await w.tagState(r.order.id);
      assert.deepEqual([state.status, state.tag], ["failed", TAG_VINI]);
      assert.match(state.reason, /write_orders/);
      assert.equal(r.order.shopifyConfirmationTag?.status ?? "failed", "failed");
      assert.deepEqual(w.shop.state.tags, []);
      w.shop.state.failTags = false;
      assert.equal((await w.svc.retryConfirmationTagSync(w.as(w.vini), r.order.id)).status, "synced");
      assert.deepEqual(w.shop.state.tags, [TAG_VINI]);
      assert.equal((await w.tagState(r.order.id)).status, "synced");
    });
  });
  it("an order with no Shopify id is confirmed in the CRM without any tag call; once linked, the tag is synced", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.shop.state.failCreate = true; // the Shopify push fails -> the order stays unlinked
      const r = await w.create(w.vini);
      const o = await w.row(r.order.id);
      assert.deepEqual([o.externalId, o.confirmedByName, r.order.confirmationTag], [null, "Vini", TAG_VINI]);
      assert.deepEqual(w.shop.state.calls, [], "no Shopify call at all for an unlinked order");
      assert.equal((await syncConfirmationTag(tx as never, r.order.id, { getShopifyClient: () => w.shop.client })).status, "not_linked");
      assert.equal(await w.tagState(r.order.id), undefined);
      // Later the order gets linked (push succeeds) -> the confirmation tag follows.
      w.shop.state.failCreate = false;
      const push = await w.svc.pushOrderToShopify(w.as(w.vini), r.order.id);
      assert.equal(push.status, "created");
      assert.deepEqual(w.shop.state.tags, [TAG_VINI]);
      assert.equal((await w.tagState(r.order.id)).status, "synced");
    });
  });
  it("an order that was never confirmed from the CRM gets no tag", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create(w.vini);
      await tx.order.update({ where: { id: r.order.id }, data: { confirmedByUserId: null, confirmedByName: null } });
      const before = w.shop.state.calls.length;
      assert.equal((await syncConfirmationTag(tx as never, r.order.id, { getShopifyClient: () => w.shop.client, force: true })).status, "not_confirmed");
      assert.equal(w.shop.state.calls.length, before);
    });
  });
  it("RBAC: a salesperson who does not own the lead cannot retry the tag sync (order not found)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create(w.vini);
      await assert.rejects(() => w.svc.retryConfirmationTagSync(w.as(w.rahul), r.order.id), (e: any) => e.statusCode === 404);
      assert.equal((await w.svc.retryConfirmationTagSync(w.as(w.vini), r.order.id)).status, "synced");
    });
  });
});
