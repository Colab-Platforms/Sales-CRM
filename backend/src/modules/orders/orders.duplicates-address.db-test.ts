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
function fakeShopify(opts: { dropShipping?: boolean; dropBilling?: boolean; repairErrors?: string[]; rejectUpsertWithoutEmail?: boolean; rejectCustomer?: boolean; rejectShippingLines?: boolean; rejectDiscount?: boolean; rejectAll?: { field: unknown[]; message: string }; totalOffset?: number; customerNodes?: any[] } = {}) {
  const state = { created: [] as any[], updates: [] as any[], repaired: false, attempts: [] as { customer: boolean; shippingLines: boolean; discount: boolean }[] };
  const money = (v: number) => ({ shopMoney: { amount: v.toFixed(2) } });
  const total = (o: any) => (o.lineItems ?? []).reduce((s: number, l: any) => s + Number(l.priceSet?.shopMoney?.amount ?? 0) * Number(l.quantity ?? 1), 0) - Number(o.discountCode?.itemFixedDiscountCode?.amountSet?.shopMoney?.amount ?? 0) + Number(o.shippingLines?.[0]?.priceSet?.shopMoney?.amount ?? 0);
  const address = (a: any) => (a ? { address1: a.address1 ?? null, city: a.city ?? null, zip: a.zip ?? null, provinceCode: a.provinceCode ?? null, countryCodeV2: a.countryCode ?? null, lastName: a.lastName ?? null, firstName: a.firstName ?? null } : null);
  const client = {
    query: async (doc: string, vars: any) => {
      if (/customers\(/.test(doc)) return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: opts.customerNodes ?? [] } };
      if (/crmOrderIdentity/.test(doc)) {
        const o = state.created.find((c) => c.id === vars.id);
        return { order: o ? { name: o.name, sourceIdentifier: o.sourceIdentifier ?? null, cancelledAt: o.cancelledAt ?? null } : null };
      }
      if (/crmOrderBySource/.test(doc)) {
        const ref = /source_identifier:"(.*)"/.exec(String(vars.query))?.[1];
        return { orders: { nodes: state.created.filter((o) => o.sourceIdentifier === ref).map((o) => ({ id: o.id, name: o.name })) } };
      }
      if (/orderCreate/.test(doc)) {
        state.attempts.push({ customer: Boolean(vars.order.customer), shippingLines: Boolean(vars.order.shippingLines?.length), discount: Boolean(vars.order.discountCode) });
        // scripted REFUSALS (a rejected orderCreate creates nothing): Shopify refuses a new customer that has no e-mail; or any customer; or the shipping / discount data
        const refuse = (message: string, field: unknown[] = ["order"]) => ({ orderCreate: { order: null, userErrors: [{ field, message }] } });
        if (opts.rejectAll) return refuse(opts.rejectAll.message, opts.rejectAll.field);
        if (opts.rejectUpsertWithoutEmail && vars.order.customer?.toUpsert && !vars.order.customer.toUpsert.email) return refuse("OrderCreateUpsertCustomerAttributesInput requires at least one of id or email");
        if (opts.rejectCustomer && vars.order.customer) return refuse("customer phone has already been taken");
        if (opts.rejectShippingLines && vars.order.shippingLines?.length) return refuse("shippingLines are not accepted");
        if (opts.rejectDiscount && vars.order.discountCode) return refuse("discount is not accepted");
        const n = String(Math.floor(1e8 + Math.random() * 9e8));
        // REAL Shopify behaviour (proven on production data): an address whose LAST name is blank is not an error - the order is saved with NO shipping and NO billing address.
        const blankLast = Boolean(vars.order.shippingAddress) && !String(vars.order.shippingAddress.lastName ?? "").trim();
        state.created.push({ ...vars.order, ...(blankLast ? { shippingAddress: undefined, billingAddress: undefined, addressDropped: true } : {}), id: `gid://shopify/Order/${n}`, name: `#T${n}` });
        return { orderCreate: { order: { id: `gid://shopify/Order/${n}`, name: `#T${n}` }, userErrors: [] } };
      }
      if (/crmOrderVerify/.test(doc)) {
        const o = state.created.find((c) => c.id === vars.id) ?? state.created.at(-1);
        const hasShip = !opts.dropShipping || state.repaired;
        return { order: { id: o.id, note: o.note, tags: o.tags ?? [], displayFinancialStatus: "Pending", totalPriceSet: money(total(o) - (opts.totalOffset ?? 0)), customer: o.customer ? { id: "c" } : null,
          shippingAddress: hasShip ? address(o.shippingAddress) : null, billingAddress: opts.dropBilling ? null : address(o.billingAddress),
          lineItems: { nodes: (o.lineItems ?? []).map((l: any) => ({ requiresShipping: l.requiresShipping !== false })) }, metafields: { nodes: (o.metafields ?? []).map((m: any) => ({ key: m.key })) } } };
      }
      if (/orderUpdate/.test(doc)) {
        state.updates.push(vars.input);
        if (vars.input.shippingAddress && !String(vars.input.shippingAddress.lastName ?? "").trim()) return { orderUpdate: { order: null, userErrors: [{ field: ["shippingAddress", "lastName"], message: "Enter a last name" }] } };
        if (opts.repairErrors) return { orderUpdate: { order: null, userErrors: opts.repairErrors.map((message) => ({ field: ["shippingAddress"], message })) } };
        if (vars.input.shippingAddress) { state.repaired = true; const o = state.created.find((c) => c.id === vars.input.id); if (o) o.shippingAddress = vars.input.shippingAddress; }
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
      assert.deepEqual(sent.shippingAddress, { lastName: "Doddesh", address1: "New Bus stand karatagi, Near-padmvatti takija", address2: "Koppal", city: "Koppal", provinceCode: "KA", zip: "583229", countryCode: "IN", phone: "9902575944" });
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
      assert.deepEqual([sent.lastName, "firstName" in sent], ["Doddesh", false], "a one-word name is sent as the LAST name Shopify requires - the real name, no invented surname, no empty field");
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ROOT CAUSE of the recurring "the CRM shows the address but the Shopify order has none": Shopify refuses an address whose LAST name is blank. It does not fail orderCreate - it saves the order WITHOUT any shipping /
// billing address - and orderUpdate then answers "Enter a last name". A one-word recipient name used to be sent as firstName only. The fake Shopify above reproduces exactly that behaviour.
describe("Shopify drops an address with a blank last name (the recurring missing-address bug)", () => {
  const oneWord = { name: "Radhe", line1: "Flat 4, Green Park", line2: "Baner", houseNumber: "Flat 4", area: "Baner", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811950001" };
  const twoWords = { ...oneWord, name: "Radhe Sharma" };
  const stored = (w: Awaited<ReturnType<typeof world>>) => w.shop.state.created.at(-1);

  it("REPRODUCTION: the old shape (first name only) is exactly what Shopify drops - and the read-back refuses to call such a sync complete", async () => {
    const shop = fakeShopify();
    const { createShopifyOrder, verifyShopifyOrder, repairAndVerify } = await import("../shopify/shopify.orders.write.js");
    const input = { lineItems: [{ title: "x", quantity: 1, priceAmount: "10.00" }], currency: "INR", sourceIdentifier: "REPRO-1", shippingAddress: { firstName: "Radhe", address1: "Flat 4", city: "Pune", zip: "411045", provinceCode: "MH", countryCode: "IN" } } as never;
    const created = await createShopifyOrder(shop.client, input);
    assert.equal(shop.state.created.at(-1).addressDropped, true, "Shopify saved the order without any address, and raised no error");
    const check = await verifyShopifyOrder(shop.client, created.shopifyOrderId, input);
    assert.ok(check.missing.includes("shippingAddress"), "the read-back sees the address is missing");
    const fix = await repairAndVerify(shop.client, created.shopifyOrderId, input, check);
    assert.deepEqual(fix.repaired, [], "the repair cannot work with the same blank last name");
    assert.ok(fix.errors.some((e) => /Enter a last name/.test(e)), "Shopify's own reason is returned, not swallowed");
  });

  it("FIXED: a one-word recipient name is sent as the LAST name (the real name, nothing invented) - Shopify keeps the shipping AND billing address and the sync is complete", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", { shippingAddress: oneWord });
      const sent = JSON.parse(JSON.stringify(stored(w)));
      assert.deepEqual([sent.addressDropped, sent.shippingAddress.lastName, "firstName" in sent.shippingAddress, sent.billingAddress.lastName], [undefined, "Radhe", false, "Radhe"]);
      assert.deepEqual([sent.shippingAddress.address1, sent.shippingAddress.address2, sent.shippingAddress.city, sent.shippingAddress.provinceCode, sent.shippingAddress.zip, sent.shippingAddress.countryCode, sent.shippingAddress.phone], ["Flat 4, Green Park", "Baner", "Pune", "MH", "411045", "IN", "9811950001"]);
      assert.equal(((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } })).metadata as any).shopifySync.status, "complete");
      assert.equal(r.shopify.status, "created");
    });
  });

  it("names that already have a last name are untouched (two and three words, and a name taken from the lead when the address has none)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.create("COD", { shippingAddress: twoWords });
      assert.deepEqual([stored(w).shippingAddress.firstName, stored(w).shippingAddress.lastName], ["Radhe", "Sharma"]);
      await w.create("COD", { shippingAddress: { ...oneWord, name: "Radhe Shyam Sharma" }, idempotencyKey: "k-" + uid(), acknowledgeDuplicate: true });
      assert.deepEqual([stored(w).shippingAddress.firstName, stored(w).shippingAddress.lastName], ["Radhe Shyam", "Sharma"]);
      const lead2 = await tx.lead.create({ data: { leadNumber: "L-" + uid(), firstName: "Asha", lastName: "Rao", mobile: "9811100077", normalizedMobile: "+919811100077", ownerId: w.as.id }, select: { id: true } });
      const noName = { ...oneWord } as Record<string, unknown>;
      delete noName.name;
      await w.create("COD", { leadId: lead2.id, shippingAddress: noName, idempotencyKey: "k-" + uid() });
      assert.deepEqual([stored(w).shippingAddress.firstName, stored(w).shippingAddress.lastName], ["Asha", "Rao"], "the lead's own name fills a missing recipient name");
    });
  });

  it("prepaid: the Shopify order created after payment confirmation (the same push) keeps the address of a one-word recipient too", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("PAYMENT_LINK", { shippingAddress: oneWord });
      assert.equal(w.shop.state.created.length, 0, "prepaid: nothing on Shopify before payment");
      const pushed = await w.orders.pushOrderToShopify(w.as, r.order.id); // exactly what confirmPaidPrepaidOrder calls once Cashfree has verified the payment
      assert.equal(pushed.status, "created");
      assert.deepEqual([stored(w).addressDropped, stored(w).shippingAddress.lastName], [undefined, "Radhe"]);
      assert.equal(((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } })).metadata as any).shopifySync.status, "complete");
    });
  });

  it("custom-item and mixed orders use the same mapping: the address survives", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.orders.createManualOrder(w.as, { leadId: w.lead.id, items: [{ itemType: "CUSTOM", customName: "Gift wrapping", quantity: 1, unitPrice: "99.00" }, { productId: w.product.id, quantity: 1, unitPrice: "649.00" }], paymentMethod: "COD", shippingAddress: oneWord, shippingPincode: "411045", shippingAmount: "0" } as never);
      assert.deepEqual([r.shopify.status, stored(w).addressDropped, stored(w).shippingAddress.lastName, stored(w).lineItems.length], ["created", undefined, "Radhe", 2]);
    });
  });

  it("retries and double submits create ONE Shopify order and never erase an address that is already there", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = "key-" + uid();
      const a = await w.create("COD", { shippingAddress: oneWord, idempotencyKey: key });
      const b = await w.create("COD", { shippingAddress: oneWord, idempotencyKey: key });
      assert.equal(a.order.id, b.order.id);
      assert.equal((await w.orders.pushOrderToShopify(w.as, a.order.id)).status, "already_linked");
      assert.deepEqual([w.shop.state.created.length, w.shop.state.updates.length, stored(w).shippingAddress.lastName], [1, 0, "Radhe"], "no second order and no orderUpdate that could blank the address");
    });
  });

  it("re-sync of a healthy order sends NOTHING (it cannot overwrite a valid Shopify address with CRM data)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", { shippingAddress: twoWords });
      const before = JSON.stringify(stored(w).shippingAddress);
      const res = await w.orders.resyncShopifyOrder(w.as, r.order.id);
      assert.equal(res.status, "already_linked");
      assert.deepEqual([w.shop.state.updates.length, JSON.stringify(stored(w).shippingAddress)], [0, before]);
    });
  });

  it("if Shopify still returns an order WITHOUT the address, the sync is PARTIAL with a clear reason and a safe retry - never reported complete", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { dropShipping: true, repairErrors: ["Enter a valid postal code"] });
      const r = await w.create("COD", { shippingAddress: twoWords });
      const sync = ((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } })).metadata as any).shopifySync;
      assert.equal(sync.status, "partial");
      assert.ok(sync.missing.includes("shippingAddress"));
      assert.ok((sync.repairErrors ?? []).some((e: string) => /postal code/.test(e)), "Shopify's own message is kept for the person investigating");
      assert.equal(w.shop.state.created.length, 1, "one order only");
      assert.equal((await w.orders.pushOrderToShopify(w.as, r.order.id)).status, "already_linked", "the retry never creates a second order");
    });
  });

  it("a recipient with no usable name at all is reported, not hidden: the mapping says so and the verification refuses 'complete'", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await tx.lead.update({ where: { id: w.lead.id }, data: { firstName: " ", lastName: null } });
      const noName = { ...oneWord } as Record<string, unknown>;
      delete noName.name;
      const r = await w.create("COD", { shippingAddress: noName });
      const sync = ((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } })).metadata as any).shopifySync;
      assert.notEqual(sync.status, "complete");
      assert.ok([...(sync.omitted ?? []), ...(sync.missing ?? [])].some((m: string) => /name|shippingAddress/.test(m)), JSON.stringify(sync));
    });
  });
});

describe("reconciling existing orders whose Shopify address is missing (src/scripts/repair-shopify-addresses.ts)", () => {
  const addr = { name: "Radhe Sharma", line1: "Flat 4, Green Park", line2: "Baner", houseNumber: "Flat 4", area: "Baner", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811950001" };

  it("the preview only READS: it reports the order as needing repair and changes nothing in Shopify or the CRM", async () => {
    await inRollback(async (tx) => {
      const opts: { dropShipping: boolean; repairErrors?: string[] } = { dropShipping: true, repairErrors: ["Enter a last name"] };
      const w = await world(tx, opts); // an order created while Shopify refuses the address and its repair: the affected state
      const r = await w.create("COD", { shippingAddress: addr });
      const updatesBefore = w.shop.state.updates.length;
      const metaBefore = JSON.stringify((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } })).metadata);
      const preview = await w.orders.previewShopifyAddress(r.order.id);
      assert.deepEqual([preview.state, preview.missing.includes("shippingAddress")], ["needs_repair", true]);
      assert.deepEqual([w.shop.state.updates.length, w.shop.state.created.length, JSON.stringify((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { metadata: true } })).metadata)], [updatesBefore, 1, metaBefore], "no write, no new order");
    });
  });

  it("the repair re-sends only the missing address (same mapping as new orders), is confirmed by a read-back, and a second run changes nothing", async () => {
    await inRollback(async (tx) => {
      const opts: { dropShipping: boolean; repairErrors?: string[] } = { dropShipping: true, repairErrors: ["Enter a last name"] };
      const w = await world(tx, opts);
      const r = await w.create("COD", { shippingAddress: addr });
      opts.repairErrors = undefined; // the cause is fixed: Shopify now accepts the address
      const updatesBefore = w.shop.state.updates.length;
      const fixed = await w.orders.resyncShopifyOrder(w.as, r.order.id);
      assert.equal(fixed.sync?.status, "complete");
      assert.deepEqual([w.shop.state.updates.length - updatesBefore, Object.keys(w.shop.state.updates.at(-1)).sort()], [1, ["id", "shippingAddress"]], "exactly one orderUpdate and it carries ONLY the shipping address");
      assert.deepEqual([w.shop.state.updates.at(-1).shippingAddress.firstName, w.shop.state.updates.at(-1).shippingAddress.lastName], ["Radhe", "Sharma"]);
      assert.equal((await w.orders.previewShopifyAddress(r.order.id)).state, "ok");
      await w.orders.resyncShopifyOrder(w.as, r.order.id);
      assert.equal(w.shop.state.updates.length - updatesBefore, 1, "idempotent: the second run sent nothing");
      assert.equal(w.shop.state.created.length, 1, "and no second Shopify order");
    });
  });

  it("a healthy order is left alone, an order with no CRM address or no Shopify link is skipped with a reason, and nothing is invented", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const ok = await w.create("COD", { shippingAddress: addr });
      assert.equal((await w.orders.previewShopifyAddress(ok.order.id)).state, "ok");
      const unlinked = await w.create("PAYMENT_LINK", { shippingAddress: addr });
      assert.deepEqual([(await w.orders.previewShopifyAddress(unlinked.order.id)).state, (await w.orders.previewShopifyAddress(unlinked.order.id)).reason], ["skip", "not linked to Shopify"]);
      assert.equal((await w.orders.previewShopifyAddress(uid())).state, "skip");
      assert.equal(w.shop.state.updates.length, 0);
    });
  });
});

describe("reconciliation safety: verified identity, only what is missing, nothing overwritten", () => {
  const addr = { name: "Radhe Sharma", line1: "Flat 4, Green Park", line2: "Baner", houseNumber: "Flat 4", area: "Baner", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811950001" };
  const affected = async (tx: Prisma.TransactionClient) => {
    const opts: { dropShipping: boolean; repairErrors?: string[] } = { dropShipping: true, repairErrors: ["Enter a last name"] };
    const w = await world(tx, opts);
    const r = await w.create("COD", { shippingAddress: addr });
    opts.repairErrors = undefined;
    return { w, r };
  };

  it("an order whose Shopify copy carries a DIFFERENT CRM order number is skipped as an identifier mismatch - never repaired", async () => {
    await inRollback(async (tx) => {
      const { w, r } = await affected(tx);
      w.shop.state.created[0].sourceIdentifier = "CRM-SOMEONE-ELSE";
      const p = await w.orders.previewShopifyAddress(r.order.id);
      assert.deepEqual([p.state, /identifier mismatch/.test(p.reason ?? "")], ["skip", true]);
    });
  });

  it("a cancelled Shopify order, or one that no longer exists, is skipped", async () => {
    await inRollback(async (tx) => {
      const { w, r } = await affected(tx);
      w.shop.state.created[0].cancelledAt = "2026-10-20T00:00:00Z";
      assert.deepEqual([(await w.orders.previewShopifyAddress(r.order.id)).state, (await w.orders.previewShopifyAddress(r.order.id)).reason], ["skip", "the Shopify order is cancelled"]);
      w.shop.state.created.length = 0;
      assert.equal((await w.orders.previewShopifyAddress(r.order.id)).reason, "the linked Shopify order no longer exists");
    });
  });

  it("an incomplete CRM address (no PIN code) or no recipient name is skipped with a reason - nothing is invented", async () => {
    await inRollback(async (tx) => {
      const { w, r } = await affected(tx);
      await tx.order.update({ where: { id: r.order.id }, data: { shippingAddress: { ...addr, pincode: "" }, shippingPincode: null } });
      assert.match((await w.orders.previewShopifyAddress(r.order.id)).reason ?? "", /incomplete/);
    });
  });

  it("a PARTIAL Shopify address is completed field by field: a value Shopify already has (e.g. corrected by staff) is kept, only the blank ones are filled", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", { shippingAddress: addr });
      w.shop.state.created[0].shippingAddress = { firstName: "Radhe", lastName: "Sharma", address1: "Hand corrected line 1", city: "", zip: "411045", provinceCode: "MH", countryCode: "IN" };
      const p = await w.orders.previewShopifyAddress(r.order.id);
      assert.deepEqual([p.state, p.differs.includes("address1")], ["needs_repair", true], "the differing line is reported for review");
      await w.orders.resyncShopifyOrder(w.as, r.order.id);
      const sent = w.shop.state.updates.at(-1).shippingAddress;
      assert.deepEqual([sent.address1, sent.city, sent.zip, sent.provinceCode], ["Hand corrected line 1", "Pune", "411045", "MH"], "Shopify's valid value kept; the blank city filled from the CRM");
      assert.deepEqual(Object.keys(w.shop.state.updates.at(-1)).sort(), ["id", "shippingAddress"], "only the address is sent - no payment, item, total or tag fields");
    });
  });

  it("an address that differs from the CRM but is complete is REPORTED and left exactly as it is", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create("COD", { shippingAddress: addr });
      w.shop.state.created[0].shippingAddress = { ...w.shop.state.created[0].shippingAddress, city: "Mumbai" };
      const p = await w.orders.previewShopifyAddress(r.order.id);
      assert.deepEqual([p.state, p.differs], ["ok", ["city"]]);
      assert.equal(w.shop.state.updates.length, 0);
    });
  });

  it("repair never changes payment status, creates an order, or touches the CRM address", async () => {
    await inRollback(async (tx) => {
      const { w, r } = await affected(tx);
      const before = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { status: true, totalAmount: true, shippingAddress: true, externalId: true } });
      const payments = await tx.payment.count({ where: { orderId: r.order.id } });
      await w.orders.resyncShopifyOrder(w.as, r.order.id);
      const after = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { status: true, totalAmount: true, shippingAddress: true, externalId: true } });
      assert.deepEqual([JSON.stringify(after), await tx.payment.count({ where: { orderId: r.order.id } }), w.shop.state.created.length], [JSON.stringify(before), payments, 1]);
    });
  });
});

// ---- the CRM total must reach Shopify intact: customer upsert needs an e-mail, the fallback drops ONLY the customer, a refusal of the money lines is a failure, and a total that differs is never "synced"
describe("Shopify order totals: customer fallback and the amount guard (MOCKED Shopify)", () => {
  const syncOf = async (tx: Prisma.TransactionClient, orderId: string) => ((await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata as any)?.shopifySync;
  const linked = async (tx: Prisma.TransactionClient, orderId: string) => (await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { externalId: true, totalAmount: true } }));

  it("an e-mail-less lead with no Shopify customer: NO customer upsert is attempted, so Shopify is asked once, keeps the 50 shipping line, and the totals match (CRM 699 = Shopify 699)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectUpsertWithoutEmail: true });
      const r = await w.create("COD");
      assert.equal(r.order.totalAmount.toString(), "699");
      assert.deepEqual(w.shop.state.attempts, [{ customer: false, shippingLines: true, discount: false }], "one request, no customer, shipping line sent");
      assert.equal(w.shop.state.created.length, 1);
      assert.equal(Number(w.shop.state.created[0].shippingLines[0].priceSet.shopMoney.amount), 50);
      const sync = await syncOf(tx, r.order.id);
      assert.equal(sync.status, "complete", JSON.stringify({ s: sync.status, m: sync.missing }));
      assert.match(sync.customer, /no e-mail/);
      assert.equal(sync.totals, undefined);
    });
  });

  it("a lead WITH an e-mail still gets its customer created, exactly as before", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectUpsertWithoutEmail: true });
      await tx.lead.update({ where: { id: w.lead.id }, data: { email: "buyer@example.com" } });
      await w.create("COD");
      assert.deepEqual(w.shop.state.attempts, [{ customer: true, shippingLines: true, discount: false }]);
      assert.equal(w.shop.state.created[0].customer.toUpsert.email, "buyer@example.com");
    });
  });

  it("an EXISTING Shopify customer (verified on the phone) is still associated, with or without an e-mail", async () => {
    await inRollback(async (tx) => {
      const node = { id: "gid://shopify/Customer/55", firstName: null, lastName: null, email: null, phone: "+919902575944", numberOfOrders: 1, amountSpent: null, defaultAddress: null, createdAt: "", updatedAt: "" };
      const w = await world(tx, { rejectUpsertWithoutEmail: true, customerNodes: [node] });
      await w.create("COD");
      assert.deepEqual(w.shop.state.created[0].customer, { toAssociate: { id: "gid://shopify/Customer/55" } });
      assert.equal(w.shop.state.attempts.length, 1);
    });
  });

  it("Shopify refuses the CUSTOMER but would take the money lines: the retry drops only the customer - the 50 shipping line stays, totals match, and the sync says the customer is the open problem", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectCustomer: true });
      await tx.lead.update({ where: { id: w.lead.id }, data: { email: "buyer@example.com" } });
      const r = await w.create("COD");
      assert.deepEqual(w.shop.state.attempts, [{ customer: true, shippingLines: true, discount: false }, { customer: false, shippingLines: true, discount: false }]);
      assert.equal(Number(w.shop.state.created[0].shippingLines[0].priceSet.shopMoney.amount), 50, "shipping preserved in the retry");
      const sync = await syncOf(tx, r.order.id);
      assert.equal(sync.status, "partial");
      assert.equal(sync.retryAdvice, "ADMIN");
      assert.ok(sync.missing.includes("customer: Shopify refused the association"));
      assert.ok(!sync.missing.includes("totals") && !sync.missing.some((m: string) => /discount\/shipping/.test(m)), "no money problem");
      assert.equal(sync.totals, undefined);
      assert.ok((await linked(tx, r.order.id)).externalId);
    });
  });

  it("the same for a DISCOUNT on a prepaid order: a refused customer never removes the CRM discount", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectCustomer: true });
      await tx.lead.update({ where: { id: w.lead.id }, data: { email: "buyer@example.com" } });
      const r = await w.create("PAYMENT_LINK", { discount: { type: "FIXED", value: "50" } });
      assert.equal(w.shop.state.attempts.length, 0, "a prepaid order reaches Shopify only once it is pushed / paid");
      await w.orders.pushOrderToShopify(w.as, r.order.id);
      assert.deepEqual(w.shop.state.attempts.map((a) => [a.customer, a.discount]), [[true, true], [false, true]]);
      assert.equal(r.order.totalAmount.toString(), "599");
      assert.equal((await syncOf(tx, r.order.id)).totals, undefined);
    });
  });

  it("Shopify refuses the shipping line too: NOTHING is created without it - the order stays unlinked and the failure records the category and the expected-versus-actual amounts", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectCustomer: true, rejectShippingLines: true });
      await tx.lead.update({ where: { id: w.lead.id }, data: { email: "buyer@example.com" } });
      const r = await w.create("COD");
      assert.equal(w.shop.state.created.length, 0, "no Shopify order without the shipping charge");
      assert.equal(r.shopify.status, "failed");
      assert.equal((await linked(tx, r.order.id)).externalId, null);
      assert.equal((await linked(tx, r.order.id)).totalAmount.toString(), "699", "the CRM order is untouched");
      const sync = await syncOf(tx, r.order.id);
      assert.deepEqual([sync.status, sync.retryAdvice, sync.totals.category, sync.totals.expected, sync.totals.actual, sync.totals.difference, sync.totals.shipping, sync.totals.shippingLineSent], ["failed", "ADMIN", "shipping_or_discount_rejected", "699", null, "699", "50", true]);
      assert.match(sync.error, /NOT created without those charges/);
    });
  });

  it("an e-mail-less lead whose shipping line is refused fails straight away (one request) instead of dropping the charge", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectShippingLines: true });
      const r = await w.create("COD");
      assert.equal(w.shop.state.attempts.length, 1);
      assert.equal(w.shop.state.created.length, 0);
      assert.equal((await syncOf(tx, r.order.id)).totals.category, "shipping_or_discount_rejected");
    });
  });

  it("a discount refused by Shopify on a prepaid order is a recorded failure too - never a silently cheaper or dearer order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectDiscount: true });
      const r = await w.create("PAYMENT_LINK", { discount: { type: "FIXED", value: "50" } });
      await w.orders.pushOrderToShopify(w.as, r.order.id);
      assert.equal(w.shop.state.created.length, 0);
      const sync = await syncOf(tx, r.order.id);
      assert.deepEqual([sync.status, sync.totals.discountSent, sync.totals.discount], ["failed", true, "50"]);
    });
  });

  it("AMOUNT GUARD: when Shopify's total differs from the CRM total the sync is FAILED / needs attention with both amounts and the difference, and the order is not edited or recreated", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { totalOffset: 50 });
      const r = await w.create("COD");
      assert.equal(w.shop.state.created.length, 1, "no second order");
      assert.equal(w.shop.state.updates.length, 0, "nothing was edited");
      const sync = await syncOf(tx, r.order.id);
      assert.deepEqual([sync.status, sync.retryAdvice, sync.totals.category, sync.totals.expected, sync.totals.actual, sync.totals.difference, sync.totals.shippingLineSent], ["failed", "ADMIN", "total_mismatch", "699.00", "649.00", "50.00", true]);
      assert.match(sync.error, /649\.00 differs from the CRM total 699\.00 \(difference 50\.00\)/);
      assert.ok(sync.missing.includes("totals"));
      assert.ok((await linked(tx, r.order.id)).externalId, "the order stays linked; an administrator decides");
    });
  });

  it("an exact match is complete; a mismatch is never complete (COD and prepaid)", async () => {
    await inRollback(async (tx) => {
      const ok = await world(tx);
      const a = await ok.create("COD");
      const b = await ok.create("PAYMENT_LINK");
      await ok.orders.pushOrderToShopify(ok.as, b.order.id);
      assert.deepEqual([(await syncOf(tx, a.order.id)).status, (await syncOf(tx, b.order.id)).status], ["complete", "complete"]);
      const bad = await world(tx, { totalOffset: 1 });
      const c = await bad.create("PAYMENT_LINK");
      await bad.orders.pushOrderToShopify(bad.as, c.order.id);
      assert.equal((await syncOf(tx, c.order.id)).status, "failed");
    });
  });
});

// ---- the failure category names the cause Shopify actually gave
describe("refusal category: shipping/discount only when Shopify names them (MOCKED Shopify)", () => {
  const syncOf = async (tx: Prisma.TransactionClient, orderId: string) => ((await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata as any)?.shopifySync;
  const row = (tx: Prisma.TransactionClient, orderId: string) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { externalId: true, totalAmount: true, shippingAmount: true } });

  it("the retry is refused for an UNRELATED field (a shipping ADDRESS line): no order, failed / ADMIN, category order_rejected - and the shipping charge was still never removed", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectAll: { field: ["order", "shippingAddress", "address1"], message: "Address line 1 is too long" } });
      await tx.lead.update({ where: { id: w.lead.id }, data: { email: "buyer@example.com" } });
      const r = await w.create("COD");
      assert.deepEqual(w.shop.state.attempts, [{ customer: true, shippingLines: true, discount: false }, { customer: false, shippingLines: true, discount: false }], "customer dropped first; the shipping line stays in BOTH requests");
      assert.equal(w.shop.state.created.length, 0, "no Shopify order");
      assert.equal(r.shopify.status, "failed");
      const sync = await syncOf(tx, r.order.id);
      assert.deepEqual([sync.status, sync.retryAdvice, sync.totals.category, sync.totals.expected, sync.totals.actual, sync.totals.shippingLineSent], ["failed", "ADMIN", "order_rejected", "699", null, true]);
      assert.deepEqual(sync.missing, ["order refused by Shopify"]);
      assert.match(sync.error, /does not name the shipping or discount lines.*NOT removed/);
      assert.ok(!/NOT created without those charges/.test(sync.error), "it does not blame the charges");
      const o = await row(tx, r.order.id);
      assert.deepEqual([o.externalId, o.totalAmount.toString(), o.shippingAmount.toString()], [null, "699", "50"], "the CRM order is untouched and unlinked");
    });
  });

  it("an e-mail-less lead refused for a PRODUCT / variant field: one request, same category, nothing created", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectAll: { field: ["order", "lineItems", "0", "variantId"], message: "Variant does not exist" } });
      const r = await w.create("COD");
      assert.equal(w.shop.state.attempts.length, 1);
      assert.equal(w.shop.state.created.length, 0);
      assert.equal((await syncOf(tx, r.order.id)).totals.category, "order_rejected");
    });
  });

  it("a message that only CONTAINS 'shipping' as part of 'shipping address' is still the address, not the charge", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { rejectAll: { field: ["order"], message: "Shipping address is invalid and billing address too" } });
      const r = await w.create("COD");
      assert.equal((await syncOf(tx, r.order.id)).totals.category, "order_rejected");
    });
  });

  it("the shipping / discount safeguard is intact: errors that DO name those fields keep their category, prepaid discount included", async () => {
    await inRollback(async (tx) => {
      const ship = await world(tx, { rejectAll: { field: ["order", "shippingLines", "0", "priceSet"], message: "is not valid" } });
      const a = await ship.create("COD");
      assert.equal((await syncOf(tx, a.order.id)).totals.category, "shipping_or_discount_rejected");
      assert.equal(ship.shop.state.created.length, 0);

      const disc = await world(tx, { rejectAll: { field: ["order", "discountCode", "itemFixedDiscountCode"], message: "invalid" } });
      const b = await disc.create("PAYMENT_LINK", { discount: { type: "FIXED", value: "50" } });
      await disc.orders.pushOrderToShopify(disc.as, b.order.id);
      const syncB = await syncOf(tx, b.order.id);
      assert.deepEqual([syncB.status, syncB.totals.category, syncB.totals.discountSent, syncB.retryAdvice], ["failed", "shipping_or_discount_rejected", true, "ADMIN"]);
      assert.equal(disc.shop.state.created.length, 0, "never created without the discount");
    });
  });
});
