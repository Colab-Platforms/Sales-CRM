// (1) Duplicate-order protection and (2) the CRM -> Shopify address sync, against the real schema. ONE rolled-back transaction per test on the isolated test database;
// Shopify and Cashfree are scripted fakes: nothing real is created, charged or messaged.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import OrdersService from "./orders.service.js";

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
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });

/** A scripted Shopify that stores what it is sent and answers the read-back like the real one - optionally dropping the address, or refusing the repair. */
function fakeShopify(opts: { dropShipping?: boolean; dropBilling?: boolean; repairErrors?: string[] } = {}) {
  const state = { created: [] as any[], updates: [] as any[], repaired: false };
  const money = (v: number) => ({ shopMoney: { amount: v.toFixed(2) } });
  const total = (o: any) => (o.lineItems ?? []).reduce((s: number, l: any) => s + Number(l.priceSet?.shopMoney?.amount ?? 0) * Number(l.quantity ?? 1), 0) - Number(o.discountCode?.itemFixedDiscountCode?.amountSet?.shopMoney?.amount ?? 0) + Number(o.shippingLines?.[0]?.priceSet?.shopMoney?.amount ?? 0);
  const address = (a: any) => (a ? { address1: a.address1 ?? null, city: a.city ?? null, zip: a.zip ?? null, provinceCode: a.provinceCode ?? null, countryCodeV2: a.countryCode ?? null, firstName: a.firstName ?? null } : null);
  const client = {
    query: async (doc: string, vars: any) => {
      if (/customers\(/.test(doc)) return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] } };
      if (/crmOrderBySource/.test(doc)) {
        const ref = /source_identifier:"(.*)"/.exec(String(vars.query))?.[1];
        return { orders: { nodes: state.created.filter((o) => o.sourceIdentifier === ref).map((o) => ({ id: o.id, name: o.name })) } };
      }
      if (/orderCreate/.test(doc)) {
        const n = String(Math.floor(1e8 + Math.random() * 9e8));
        state.created.push({ ...vars.order, id: `gid://shopify/Order/${n}`, name: `#T${n}` });
        return { orderCreate: { order: { id: `gid://shopify/Order/${n}`, name: `#T${n}` }, userErrors: [] } };
      }
      if (/crmOrderVerify/.test(doc)) {
        const o = state.created.find((c) => c.id === vars.id) ?? state.created.at(-1);
        const hasShip = !opts.dropShipping || state.repaired;
        return { order: { id: o.id, note: o.note, tags: o.tags ?? [], displayFinancialStatus: "Pending", totalPriceSet: money(total(o)), customer: o.customer ? { id: "c" } : null,
          shippingAddress: hasShip ? address(o.shippingAddress) : null, billingAddress: opts.dropBilling ? null : address(o.billingAddress),
          lineItems: { nodes: (o.lineItems ?? []).map((l: any) => ({ requiresShipping: l.requiresShipping !== false })) }, metafields: { nodes: (o.metafields ?? []).map((m: any) => ({ key: m.key })) } } };
      }
      if (/orderUpdate/.test(doc)) {
        state.updates.push(vars.input);
        if (opts.repairErrors) return { orderUpdate: { order: null, userErrors: opts.repairErrors.map((message) => ({ field: ["shippingAddress"], message })) } };
        if (vars.input.shippingAddress) state.repaired = true;
        return { orderUpdate: { order: { id: vars.input.id }, userErrors: [] } };
      }
      return { order: { id: "gid://shopify/Order/1", tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
    },
  } as unknown as ShopifyClient;
  return { client, state };
}

async function world(tx: Prisma.TransactionClient, shopOpts: Parameters<typeof fakeShopify>[0] = {}, cf: { failFirstLink?: boolean } = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Doddesh", mobile: "9902575944", normalizedMobile: "+919902575944", ownerId: admin.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" }, select: { id: true } });
  const shop = fakeShopify(shopOpts);
  const links: string[] = [];
  let failFirst = cf.failFirstLink === true;
  const api: CashfreeApi = {
    createLink: async (request) => {
      if (failFirst) { failFirst = false; throw new ProviderHttpError("CASHFREE", 400, "Cashfree rejected the request", false); }
      links.push(request.link_id);
      return { cfLinkId: "1", linkId: request.link_id, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${request.link_id}`, linkAmount: String(request.link_amount), linkAmountPaid: "0", linkExpiryTime: null } as unknown as CashfreeLink;
    },
    getLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${linkId}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
    cancelLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "CANCELLED", linkUrl: null, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
  };
  const cashfree = new CashfreePaymentsService({ $transaction: (cb: (t: never) => unknown) => cb(tx as never) } as never, { config: () => CONFIG, client: () => api });
  const notify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const orders = new OrdersService(tx as never, () => shop.client, () => cashfree as never, notify);
  const as = { id: admin.id, username: admin.username, role: Role.ADMIN };
  const address = { name: "Doddesh", line1: "New Bus stand karatagi, Near-padmvatti takija", line2: "Koppal", houseNumber: "New Bus stand karatagi", area: "Koppal", city: "Koppal", state: "Karnataka", pincode: "583229", phone: "9902575944" };
  const request = (paymentMethod: "COD" | "PAYMENT_LINK", extra: Record<string, unknown> = {}) => ({ leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "649.00" }], paymentMethod, shippingAddress: address, shippingPincode: "583229", ...(paymentMethod === "PAYMENT_LINK" ? { sendPaymentLinkViaWhatsApp: false } : {}), ...extra });
  const create = (paymentMethod: "COD" | "PAYMENT_LINK", extra: Record<string, unknown> = {}) => orders.createManualOrder(as, request(paymentMethod, extra) as never);
  return { tx, orders, as, lead, product, shop, links, create, request, cashfree };
}
const orderCount = (tx: Prisma.TransactionClient, leadId: string) => tx.order.count({ where: { leadId } });
const rejects = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); if (re) assert.match(e.message, re); return true; });

describe("duplicate-order protection", () => {
  it("a double click / retry with the SAME key and payload returns the first result: one order, one Shopify order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `key-${uid()}`;
      const first = await w.create("COD", { idempotencyKey: key });
      const again = await w.create("COD", { idempotencyKey: key });
      assert.equal(again.order.id, first.order.id);
      assert.equal(await orderCount(tx, w.lead.id), 1);
      assert.equal(w.shop.state.created.length, 1, "Shopify is never asked for a second order");
      assert.equal(await tx.idempotencyKey.count({ where: { key, operation: "ORDER_CREATE" } }), 1, "one row in the idempotency ledger");
    });
  });

  it("simultaneous requests with the same key produce one order (the unique index decides, not a read-before-create)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `key-${uid()}`;
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => w.create("COD", { idempotencyKey: key })));
      assert.equal(new Set(results.map((r) => r.order.id)).size, 1);
      assert.equal(await orderCount(tx, w.lead.id), 1);
      assert.equal(w.shop.state.created.length, 1);
    });
  });

  it("the same key with a DIFFERENT request is refused safely (422), and nothing new is created", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `key-${uid()}`;
      const first = await w.create("COD", { idempotencyKey: key });
      await rejects(w.create("COD", { idempotencyKey: key, items: [{ productId: w.product.id, quantity: 2, unitPrice: "649.00" }] }), 422, /different order request/);
      await rejects(w.create("PAYMENT_LINK", { idempotencyKey: key }), 422);
      assert.equal(await orderCount(tx, w.lead.id), 1);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: first.order.id }, select: { totalAmount: true } })).totalAmount.toString(), "699");
    });
  });

  it("a prepaid order whose payment link failed: replaying the same key and retrying the link create no second order and exactly one link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, {}, { failFirstLink: true });
      const key = `key-${uid()}`;
      const first = await w.create("PAYMENT_LINK", { idempotencyKey: key });
      assert.equal(first.paymentLink?.status, "failed");
      const replay = await w.create("PAYMENT_LINK", { idempotencyKey: key });
      assert.equal(replay.order.id, first.order.id);
      const retry = await w.cashfree.createPaymentLink(w.as, first.order.id);
      const again = await w.cashfree.createPaymentLink(w.as, first.order.id);
      assert.deepEqual([retry.reused, again.reused, again.paymentId === retry.paymentId], [false, true, true]);
      assert.equal(await orderCount(tx, w.lead.id), 1);
      assert.equal(w.links.length, 1, "exactly one Cashfree link was ever created");
    });
  });

  it("genuinely separate purchases by the same customer stay possible: different key, or the same sale acknowledged, or a different basket", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.create("COD", { idempotencyKey: `key-${uid()}` });
      await w.create("COD", { idempotencyKey: `key-${uid()}` }); // no guard switched on: a plain second purchase
      assert.equal(await orderCount(tx, w.lead.id), 2);
      // With the guard (what the HTTP controller switches on): the same sale again is refused until it is acknowledged ...
      await assert.rejects(() => w.create("COD", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true }), (e: any) => e.statusCode === 409 && e.data?.code === "POSSIBLE_DUPLICATE_ORDER" && /already created/.test(e.message) && typeof e.data.orderNumber === "string");
      assert.equal(await orderCount(tx, w.lead.id), 2, "the refused request created nothing");
      // ... a different basket is simply allowed, and so is the same one once the user confirms it is a separate purchase
      await w.create("COD", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true, items: [{ productId: w.product.id, quantity: 2, unitPrice: "649.00" }] });
      await w.create("COD", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: false });
      assert.equal(await orderCount(tx, w.lead.id), 4);
    });
  });

  it("the twin guard does not trip on a cancelled order, another customer, or another payment mode - and an idempotent replay is never treated as a twin", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `key-${uid()}`;
      const first = await w.create("COD", { idempotencyKey: key, rejectRecentTwin: true });
      // replay of the SAME request: returns the original, does not raise the duplicate warning
      assert.equal((await w.create("COD", { idempotencyKey: key, rejectRecentTwin: true })).order.id, first.order.id);
      // another payment mode for the same basket is a different sale
      await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true });
      // cancelled orders are not a twin
      await tx.order.update({ where: { id: first.order.id }, data: { status: "CANCELLED" } });
      await w.create("COD", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true });
      // another customer
      const other = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Other", mobile: "9811100002", normalizedMobile: "+919811100002", ownerId: w.as.id }, select: { id: true } });
      await w.create("COD", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true, leadId: other.id });
      assert.equal(await orderCount(tx, w.lead.id), 3);
    });
  });
});

describe("CRM -> Shopify address sync", () => {
  it("a complete Indian address reaches Shopify in structured fields, for COD and for the shipping AND billing address", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD");
      const sent = JSON.parse(JSON.stringify(w.shop.state.created.at(-1))); // what actually goes over the wire
      assert.deepEqual(sent.shippingAddress, { firstName: "Doddesh", address1: "New Bus stand karatagi, Near-padmvatti takija", address2: "Koppal", city: "Koppal", provinceCode: "KA", zip: "583229", countryCode: "IN", phone: "9902575944" });
      assert.deepEqual(sent.billingAddress, sent.shippingAddress, "the CRM keeps one address: billing is the shipping address, as before");
      assert.equal(sent.lineItems.every((l: any) => l.requiresShipping === true), true);
      const row = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } });
      assert.equal((row.metadata as any).shopifySync.status, "complete");
      assert.equal(r.shopify.status, "created");
    });
  });

  it("optional parts that are missing are left out - never invented or sent empty", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.create("COD", { shippingAddress: { name: "Doddesh", line1: "Flat 1, Main Road", city: "Koppal", state: "Karnataka", pincode: "583229" } });
      const sent = JSON.parse(JSON.stringify(w.shop.state.created.at(-1).shippingAddress)); // what actually goes over the wire
      assert.equal("address2" in sent, false);
      assert.equal("lastName" in sent, false, "a one-word name gets no invented surname");
      assert.equal(sent.phone, "+919902575944", "the lead's number is used when the address has none");
    });
  });

  it("Shopify accepted nothing: the CRM reports PARTIAL (not complete) and says what is missing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { dropShipping: true, repairErrors: ["Shipping address is invalid"] });
      const r = await w.create("COD");
      const sync = (r.shopify as any).sync;
      assert.equal(sync.status, "partial");
      assert.ok(sync.missing.includes("shippingAddress"));
      assert.equal(sync.verifiedAt, null);
      assert.equal(sync.retryAdvice, "RETRY");
    });
  });

  it("a REFUSED repair is explained, not hidden: Shopify's message is recorded and the field is NOT listed as repaired", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { dropShipping: true, repairErrors: ["Shipping address is invalid"] });
      const r = await w.create("COD");
      const sync = (r.shopify as any).sync;
      assert.deepEqual(sync.repaired, [], "nothing was repaired");
      assert.deepEqual(sync.repairErrors, ["Shipping address is invalid"]);
      assert.equal(w.shop.state.updates.length, 1, "exactly one repair attempt, no loop");
      const row = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } });
      assert.deepEqual((row.metadata as any).shopifySync.repairErrors, ["Shipping address is invalid"]);
    });
  });

  it("a repair that Shopify accepts is verified by reading the order back: only then is it 'repaired' and the sync 'complete'", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { dropShipping: true });
      const r = await w.create("COD");
      const sync = (r.shopify as any).sync;
      assert.deepEqual([sync.status, sync.repaired, sync.missing, sync.repairErrors], ["complete", ["shippingAddress"], [], undefined]);
      assert.notEqual(sync.verifiedAt, null);
    });
  });

  it("a missing BILLING address is detected and reported (orderUpdate cannot set one), never silently ignored", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { dropBilling: true });
      const r = await w.create("COD");
      const sync = (r.shopify as any).sync;
      assert.equal(sync.status, "partial");
      assert.ok(sync.missing.includes("billingAddress"));
      assert.equal(sync.retryAdvice, "ADMIN", "it has to be fixed in Shopify");
      assert.equal(w.shop.state.updates.length, 0, "no pointless repair attempt for something orderUpdate cannot change");
    });
  });

  it("the explicit re-sync repairs a previously partial order and is idempotent (a second run sends nothing)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { dropShipping: true, repairErrors: ["Shipping address is invalid"] });
      const r = await w.create("COD");
      assert.equal((r.shopify as any).sync.status, "partial");
      // Shopify now accepts the repair
      const healthy = fakeShopify({ dropShipping: true });
      healthy.state.created.push(...w.shop.state.created);
      const svc = new OrdersService(tx as never, () => healthy.client);
      const first = await svc.resyncShopifyOrder(w.as, r.order.id);
      assert.deepEqual([first.sync?.status, first.sync?.repaired], ["complete", ["shippingAddress"]]);
      const updates = healthy.state.updates.length;
      const second = await svc.resyncShopifyOrder(w.as, r.order.id);
      assert.equal(second.sync?.status, "complete");
      assert.equal(healthy.state.updates.length, updates, "nothing is re-sent once the order is complete");
      assert.equal(healthy.state.created.length, 1, "and no second Shopify order");
    });
  });
});

describe("changing the price / discount of an unpaid prepaid order (the Shreya incident: ₹599 order, then a ₹1 order for the same sale)", () => {
  const link = (tx: Prisma.TransactionClient, orderId: string) => tx.payment.findMany({ where: { orderId }, select: { status: true, externalId: true, failureReason: true } });

  it("the same basket re-entered with a different discount while the first is unpaid is NOT created silently: it is refused with the open order offered as the one to replace", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const first = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true });
      assert.equal(first.order.status, "PENDING_PAYMENT");
      await assert.rejects(
        () => w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true, discount: { type: "FIXED", value: "648" } }),
        (e: any) => e.statusCode === 409 && e.data?.code === "POSSIBLE_DUPLICATE_ORDER" && e.data.supersedable === true && e.data.orderId === first.order.id && /replace/i.test(e.message),
      );
      assert.equal(await orderCount(tx, w.lead.id), 1, "the refused request created no second order");
    });
  });

  it("replacing: ONE active order is left - the old order is cancelled with its payment link, the new one has its own link at the new amount, and the old order id/number stays auditable", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const first = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: true });
      const second = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: false, supersedesOrderId: first.order.id, discount: { type: "FIXED", value: "648" } });
      const old = await tx.order.findUniqueOrThrow({ where: { id: first.order.id }, select: { status: true, cancelReason: true, totalAmount: true } });
      assert.deepEqual([old.status, /^Replaced by/.test(old.cancelReason ?? "")], ["CANCELLED", true]);
      assert.equal((await link(tx, first.order.id)).every((p) => p.status !== "SUCCESS" && p.status !== "PENDING"), true, "the old link can no longer be paid");
      assert.deepEqual([second.order.status, String(second.order.totalAmount)], ["PENDING_PAYMENT", "1"]);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id, status: { not: "CANCELLED" } } }), 1, "exactly one live order for the purchase");
      assert.equal((await tx.payment.findMany({ where: { orderId: second.order.id, status: "PENDING" } })).length, 1, "one live link, for the new amount");
      assert.ok(await tx.activity.count({ where: { orderId: first.order.id, type: "ORDER_CANCELLED" } }) >= 1, "the replacement is in the old order's audit trail");
    });
  });

  it("a retry of the same replace request (same key) creates no third order; and if the first attempt already cancelled the old order the retry carries on", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const first = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}` });
      const key = `key-${uid()}`;
      const a = await w.create("PAYMENT_LINK", { idempotencyKey: key, supersedesOrderId: first.order.id, discount: { type: "FIXED", value: "648" } });
      const b = await w.create("PAYMENT_LINK", { idempotencyKey: key, supersedesOrderId: first.order.id, discount: { type: "FIXED", value: "648" } });
      assert.equal(a.order.id, b.order.id);
      assert.equal(await orderCount(tx, w.lead.id), 2);
      // the old order was cancelled by an attempt whose create then failed: another attempt (new key) is not blocked by "already cancelled"
      const third = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, supersedesOrderId: first.order.id, discount: { type: "FIXED", value: "300" } });
      assert.equal(third.order.status, "PENDING_PAYMENT");
    });
  });

  it("only an unpaid prepaid order of THIS customer can be replaced: a paid order, a COD order, another customer's order, or a COD replacement are refused and nothing is cancelled", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const paid = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}` });
      await tx.payment.updateMany({ where: { orderId: paid.order.id }, data: { status: "SUCCESS" } });
      await tx.order.update({ where: { id: paid.order.id }, data: { status: "CONFIRMED" } });
      await rejects(w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, supersedesOrderId: paid.order.id }), 409);
      const cod = await w.create("COD", { idempotencyKey: `key-${uid()}` });
      await rejects(w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, supersedesOrderId: cod.order.id }), 409);
      const other = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Other", mobile: "9811100003", normalizedMobile: "+919811100003", ownerId: w.as.id }, select: { id: true } });
      const theirs = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, leadId: other.id });
      await rejects(w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, supersedesOrderId: theirs.order.id }), 404);
      const open = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}` });
      await rejects(w.create("COD", { idempotencyKey: `key-${uid()}`, supersedesOrderId: open.order.id }), 400);
      assert.deepEqual((await tx.order.findMany({ where: { id: { in: [paid.order.id, cod.order.id, theirs.order.id, open.order.id] } }, select: { status: true }, orderBy: { createdAt: "asc" } })).map((o) => o.status), ["CONFIRMED", "CONFIRMED", "PENDING_PAYMENT", "PENDING_PAYMENT"]);
    });
  });

  it("another salesperson cannot replace an order they did not create; a genuinely new purchase (explicit, no replacement) is still created and leaves the first untouched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const first = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}` });
      const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true } });
      await assert.rejects(() => w.orders.createManualOrder({ id: rep.id, username: rep.username, role: Role.SALESPERSON }, w.request("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, supersedesOrderId: first.order.id }) as never), (e: any) => e.statusCode === 403 || e.statusCode === 404);
      const separate = await w.create("PAYMENT_LINK", { idempotencyKey: `key-${uid()}`, rejectRecentTwin: false });
      assert.equal(separate.order.status, "PENDING_PAYMENT");
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: first.order.id }, select: { status: true } })).status, "PENDING_PAYMENT", "acknowledging a separate purchase never touches the other order");
    });
  });
});
