// Repeatable end-to-end DB test of the whole COD -> prepaid flow, on ISOLATED data with FAKE providers only (no Shopify, Cashfree or WhatsApp call is ever made). Run with: npm run test:db
//
//   fresh COD order: item 649.00 - discount 648.00 + FLAT COD shipping 50.00 + tax 0.00 = 51.00
//   -> the Shopify order is created WITH the discount and the shipping line (fake validates the field names against Admin API 2026-01 and does Shopify's arithmetic)
//   -> prepaid upgrade offer: the server takes 50.00 off -> 1.00 -> Cashfree link for 1.00
//   -> signed-style PAYMENT_SUCCESS delivery, verified against Cashfree -> CRM payment SUCCESS, order PREPAID, Shopify edited (-50) and paid (1.00), ONE WhatsApp confirmation
//   -> the same delivery again, and a second delivery of the same payment: nothing is duplicated
//   -> Shopify total mismatch / Shopify down: nothing is written to Shopify, the verified payment stays in the CRM, a recoverable error is recorded, a retry completes it once
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { ENV as SHOPIFY_ENV } from "../shopify/shopify.fixtures.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import { processCashfreeEvent } from "../cashfree/cashfree.webhook.processor.js";
import { syncShopifyPayment } from "../cashfree/cashfree.payment-success.js";
import OrdersService from "./orders.service.js";
import PrepaidUpgradeService from "./orders.prepaid-upgrade.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx, { $transaction: (cb) => cb(tx) }); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const CF_CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });
const SHOPIFY_CONFIG = loadShopifyConfig(SHOPIFY_ENV);
const NOW = new Date("2026-10-12T10:00:00Z");

// ---- the exact field sets of Shopify Admin API 2026-01 (taken from a read-only introspection of the live schema) ----
const ORDER_KEYS = ["billingAddress", "buyerAcceptsMarketing", "closedAt", "companyLocationId", "currency", "customAttributes", "customer", "discountCode", "email", "financialStatus", "fulfillment", "fulfillmentStatus", "lineItems", "metafields", "name", "note", "phone", "poNumber", "presentmentCurrency", "processedAt", "referringSite", "shippingAddress", "shippingLines", "sourceIdentifier", "sourceName", "sourceUrl", "tags", "taxesIncluded", "taxLines", "test", "transactions"];
const LINE_KEYS = ["fulfillmentService", "giftCard", "priceSet", "productId", "properties", "quantity", "requiresShipping", "sku", "taxLines", "taxable", "title", "variantId", "variantTitle", "vendor", "weight"];
const money = (c: number) => ({ shopMoney: { amount: (c / 100).toFixed(2) } });
const cents = (v: unknown) => Math.round(Number(v) * 100);

/** A stateful fake Shopify: validates orderCreate against the schema, does Shopify's arithmetic (items - fixed discount + shipping, no tax), and models edit / payment / mark-as-paid. Counts every write. */
function fakeShopify() {
  const orders = new Map<string, { total: number; received: number; staged: number; origTotal?: number; tags: string[] }>();
  let editing = ""; // the order an open edit session belongs to (Shopify's edit mutations address the CalculatedOrder, not the order)
  const s = { orders, created: [] as any[], rejected: [] as string[], writes: { edit: 0, payment: 0, markPaid: 0 }, totalOverride: 0, down: false, lostResponse: false, seq: 0 };
  const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: any };
    const reject = (message: string) => { s.rejected.push(message); return reply({ orderCreate: { order: null, userErrors: [{ field: ["order"], message }] } }); };
    if (query.includes("crmOrderCreate")) {
      const o = variables.order;
      const unknown = Object.keys(o).filter((k) => o[k] !== undefined && !ORDER_KEYS.includes(k));
      if (unknown.length) return reject(`Unknown order field(s): ${unknown.join(",")}`);
      for (const l of o.lineItems) { const u = Object.keys(l).filter((k) => !LINE_KEYS.includes(k)); if (u.length) return reject(`Unknown line item field(s): ${u.join(",")}`); }
      const fixed = o.discountCode?.itemFixedDiscountCode;
      if (o.discountCode && (Object.keys(o.discountCode).some((k) => !["itemFixedDiscountCode", "itemPercentageDiscountCode", "freeShippingDiscountCode"].includes(k)) || (fixed && (typeof fixed.code !== "string" || !fixed.amountSet?.shopMoney?.currencyCode)))) return reject("Invalid discountCode");
      for (const sl of o.shippingLines ?? []) if (typeof sl.title !== "string" || !sl.priceSet?.shopMoney?.amount) return reject("Invalid shippingLine");
      const items = o.lineItems.reduce((a: number, l: any) => a + cents(l.priceSet ? l.priceSet.shopMoney.amount : 100) * l.quantity, 0);
      const discount = fixed ? cents(fixed.amountSet.shopMoney.amount) : 0;
      const shipping = (o.shippingLines ?? []).reduce((a: number, sl: any) => a + cents(sl.priceSet.shopMoney.amount), 0);
      const id = `gid://shopify/Order/9${Date.now()}${++s.seq}`;
      orders.set(id, { total: items - discount + shipping, received: 0, staged: 0, tags: [] });
      s.created.push({ id, items, discount, shipping, total: items - discount + shipping, currency: o.currency, order: o });
      if (s.lostResponse) throw new Error("socket hang up"); // Shopify DID create the order, but the answer never reached us (timeout / dropped connection)
      return reply({ orderCreate: { order: { id, name: "#TEST1" }, userErrors: [] } });
    }
    if (query.includes("crmOrderBySource")) {
      const ref = /source_identifier:"(.*)"/.exec(variables.query)?.[1];
      return reply({ orders: { nodes: s.created.filter((c) => c.order.sourceIdentifier === ref).map((c) => ({ id: c.id, name: "#TEST1" })) } });
    }
    const st = orders.get(String(variables.id ?? variables.input?.id));
    if (query.includes("crmOrderTags")) return reply({ order: { id: variables.id, tags: [...(st?.tags ?? [])] } });
    if (query.includes("crmTagsAdd")) { for (const t of variables.tags) if (st && !st.tags.includes(t)) st.tags.push(t); return reply({ tagsAdd: { userErrors: [] } }); }
    if (query.includes("crmTagsRemove")) return reply({ tagsRemove: { userErrors: [] } });
    if (query.includes("crmPrepaidUpgradeOrderState")) {
      if (s.down) return new Response(JSON.stringify({ errors: [{ message: "Throttled (test): Shopify is temporarily unavailable" }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (st && s.totalOverride) { if (st.origTotal === undefined) st.origTotal = st.total; st.total = s.totalOverride; } else if (st && st.origTotal !== undefined) { st.total = st.origTotal; delete st.origTotal; }
      return reply({ order: st ? { id: variables.id, displayFinancialStatus: st.received > 0 && st.received >= st.total ? "PAID" : "PENDING", cancelledAt: null, currentTotalPriceSet: money(st.total), totalOutstandingSet: money(st.total - st.received), totalReceivedSet: money(st.received) } : null });
    }
    if (query.includes("crmPrepaidUpgradeEditBegin")) { editing = String(variables.id); return reply({ orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/1", lineItems: { nodes: [{ id: "li1", quantity: 1, originalUnitPriceSet: money(st!.total) }] } }, userErrors: [] } }); }
    if (query.includes("crmPrepaidUpgradeEditDiscount")) { const e = orders.get(editing)!; e.staged = e.total - cents(variables.discount.fixedValue.amount); return reply({ orderEditAddLineItemDiscount: { calculatedOrder: { totalPriceSet: money(e.staged), totalOutstandingSet: money(e.staged) }, userErrors: [] } }); }
    if (query.includes("crmPrepaidUpgradeEditCommit")) { s.writes.edit++; const e = orders.get(editing)!; e.total = e.staged; return reply({ orderEditCommit: { order: { id: "x" }, userErrors: [] } }); }
    if (query.includes("crmPrepaidUpgradeManualPayment")) { s.writes.payment++; st!.received = st!.total; return reply({ orderCreateManualPayment: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }); }
    if (query.includes("crmOrderMarkAsPaid")) { s.writes.markPaid++; if (st) st.received = st.total; return reply({ orderMarkAsPaid: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }); }
    throw new Error(`unexpected Shopify call: ${query.slice(0, 60)}`);
  }) as unknown as typeof fetch;
  return { state: s, client: () => new ShopifyClient(SHOPIFY_CONFIG, { fetchImpl }) };
}

function fakeCashfree() {
  const links = new Map<string, { status: string; amount: string; paid: string }>();
  const calls = { create: [] as number[] };
  const mk = (id: string): CashfreeLink => { const l = links.get(id)!; return { cfLinkId: "1", linkId: id, linkStatus: l.status, linkUrl: `https://pay.test/${id}`, linkAmount: l.amount, linkAmountPaid: l.paid, linkExpiryTime: null } as CashfreeLink; };
  const api: CashfreeApi = {
    createLink: async (req) => { calls.create.push(req.link_amount); links.set(req.link_id, { status: "ACTIVE", amount: String(req.link_amount), paid: "0" }); return mk(req.link_id); },
    getLink: async (id) => mk(id),
    cancelLink: async () => null,
    getLinkOrders: async () => [],
    getOrderPayments: async () => [],
  };
  return { api, calls, pay: (id: string, amount: string) => links.set(id, { ...links.get(id)!, status: "PAID", paid: amount }) };
}

async function world(tx: Db, runner: TxRunner) {
  const rep = await tx.user.create({ data: { name: "Tele Caller", username: `t-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9000000123", normalizedMobile: "+919000000123", email: "p@zz.invalid", ownerId: rep.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" }, select: { id: true } });
  // a WhatsApp conversation + an approved payment-received template, so the "payment received" confirmation WOULD be sent - to a stub that only counts
  await tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `wamid-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId: lead.id, normalizedContact: "+919000000123", body: "hi" } });
  await tx.whatsAppTemplate.create({ data: { name: `pay_ok_${uid().slice(0, 8)}`, provider: "META", language: "en", body: "Payment of {{amount}} received", variables: ["amount"], status: "APPROVED", providerTemplateId: `tpl_${uid().slice(0, 8)}` } });
  const sends: string[] = [];
  const notifyDeps = { messaging: { sendTemplateAsSystem: async (input: { orderId?: string }) => { sends.push(String(input.orderId)); return { status: "SENT" }; } } } as never;
  const shop = fakeShopify();
  const cf = fakeCashfree();
  const cashfree = new CashfreePaymentsService(runner, { config: () => CF_CONFIG, client: () => cf.api, getShopifyClient: () => shop.client(), notifyDeps, now: () => NOW });
  const noMessages = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const orders = new OrdersService(tx as never, () => shop.client(), () => cashfree, noMessages);
  const upgrade = new PrepaidUpgradeService(tx as never, () => cashfree, () => NOW);
  const user = { id: rep.id, username: rep.username, role: Role.SALESPERSON } as never;

  const createCod = () => orders.createManualOrder(user, { leadId: lead.id, items: [{ productId: product.id, quantity: 1, unitPrice: "649.00" }], paymentMethod: "COD", discount: { type: "FIXED", value: "648" }, shippingAmount: "66.72", expectedTotal: "51.00" } as never);
  const orderRow = (id: string) => tx.order.findUniqueOrThrow({ where: { id }, select: { subtotal: true, discountAmount: true, shippingAmount: true, taxAmount: true, totalAmount: true, currency: true, externalId: true, metadata: true } });
  const meta = async (id: string) => ((await orderRow(id)).metadata ?? {}) as any;
  const upgraded = async () => {
    const created = await createCod();
    const offer = await upgrade.createOffer(user, created.order.id, { discountType: "FIXED", discountValue: "50", expectedPrepaidAmount: "1.00" });
    const link = await upgrade.generateLink(user, created.order.id, offer.offer!.id);
    const payment = await tx.payment.findFirstOrThrow({ where: { orderId: created.order.id, externalSource: "CASHFREE" }, select: { id: true, externalId: true, amount: true } });
    return { orderId: created.order.id, offer, link, payment };
  };
  // one PAYMENT_SUCCESS delivery for a link (a different `id` = a different delivery of the same payment)
  const deliver = async (linkId: string, amount: string, id = uid()) => {
    const { store } = memoryStore();
    const body = { type: "PAYMENT_SUCCESS_WEBHOOK", event_time: NOW.toISOString(), data: { order: { order_id: `CFPay_${linkId}_ab12_1791374485548`, order_amount: amount, order_currency: "INR", link_id: linkId }, payment: { cf_payment_id: "9990011223", payment_status: "SUCCESS", payment_amount: amount, payment_time: NOW.toISOString(), bank_reference: "BANKREF9", payment_group: "upi" } } };
    const stored = await store.record({ eventType: body.type, externalEventId: id, payload: body, ignored: false });
    return processCashfreeEvent(stored.id, { store, runner, now: () => NOW, getShopifyClient: () => shop.client(), notifyDeps, verifyLink: (l) => cf.api.getLink(l) });
  };
  return { tx, user, shop, cf, sends, orders, createCod, orderRow, meta, upgraded, deliver, upgrade };
}

describe("fresh COD order: 649.00 - 648.00 + 50.00 (flat COD shipping; the request's 66.72 courier quote is ignored) + 0.00 tax = 51.00, CRM and Shopify agree", () => {
  it("the CRM figures and the Shopify order (created WITH the discount and the shipping line) have the same items, discount, shipping, tax treatment, currency and total", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.createCod();
      const row = await w.orderRow(r.order.id);
      assert.deepEqual([row.subtotal, row.discountAmount, row.shippingAmount, row.taxAmount, row.totalAmount, row.currency].map(String), ["649", "648", "50", "0", "51", "INR"]);
      assert.deepEqual(w.shop.state.rejected, [], "Shopify (schema-validating fake) accepted every field of the payload");
      const sh = w.shop.state.created.at(-1);
      assert.deepEqual([sh.items, sh.discount, sh.shipping, sh.total, sh.currency], [64900, 64800, 5000, 5100, "INR"]);
      assert.equal(sh.total, Math.round(Number(row.totalAmount.toString()) * 100), "Shopify total === CRM total");
      assert.equal("taxLines" in sh.order, false, "no tax is sent (CRM tax is 0 and orderCreate computes none)");
      assert.equal((await w.meta(r.order.id)).shopifyTotals.mirrored, true);
      assert.equal((await w.meta(r.order.id)).paymentMode, "COD");
    });
  });
});

describe("prepaid upgrade: the server computes 51.00 - 50.00 = 1.00", () => {
  it("offer, amount, link and the unchanged COD order; a client-supplied amount is not trusted; a repeat reuses the link", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const created = await w.createCod();
      await assert.rejects(w.upgrade.createOffer(w.user, created.order.id, { discountType: "FIXED", discountValue: "50", expectedPrepaidAmount: "20.00" }), (e: any) => e.statusCode === 409);
      const offer = await w.upgrade.createOffer(w.user, created.order.id, { discountType: "FIXED", discountValue: "50", expectedPrepaidAmount: "1.00" });
      assert.deepEqual([offer.offer!.originalAmount, offer.offer!.discountAmount, offer.offer!.prepaidAmount], ["51", "50.00", "1.00"]);
      const link = await w.upgrade.generateLink(w.user, created.order.id, offer.offer!.id);
      const again = await w.upgrade.generateLink(w.user, created.order.id, offer.offer!.id);
      assert.deepEqual(w.cf.calls.create, [1], "ONE Cashfree link, for exactly 1.00");
      assert.equal(again.reused, true);
      assert.equal(link.paymentId, again.paymentId);
      const row = await w.orderRow(created.order.id);
      assert.equal(row.totalAmount.toString(), "51", "until paid the order total is unchanged");
      assert.equal((await w.meta(created.order.id)).paymentMode, "COD");
    });
  });
});

describe("verified payment, replay and duplicate-safety", () => {
  it("a successful payment converts the order, edits Shopify by -50 and records 1.00 ONCE; a replay and a second delivery add no payment, no Shopify write and no second WhatsApp confirmation", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const u = await w.upgraded();
      const shopifyId = (await w.orderRow(u.orderId)).externalId!;
      w.cf.pay(u.payment.externalId!, "1.00");
      const same = uid();
      assert.equal(await w.deliver(u.payment.externalId!, "1.00", same), "processed");

      const pay = await tx.payment.findUniqueOrThrow({ where: { id: u.payment.id }, select: { status: true, amount: true, providerPaymentId: true } });
      assert.deepEqual([pay.status, pay.amount.toString(), pay.providerPaymentId], ["SUCCESS", "1", "9990011223"]);
      const m = await w.meta(u.orderId);
      assert.deepEqual([m.paymentMode, m.prepaidUpgrade.status, m.shopifyPaymentSync.status], ["PREPAID", "UPGRADED", "synced"], JSON.stringify(m.shopifyPaymentSync));
      const row = await w.orderRow(u.orderId);
      assert.deepEqual([row.subtotal, row.discountAmount, row.shippingAmount, row.totalAmount].map(String), ["649", "698", "50", "1"], "649 - (648 + 50) + 50 = 1");
      const sh = [...w.shop.state.orders.entries()].find(([id]) => id.endsWith(shopifyId.replace(/^gid:\/\/shopify\/Order\//, "")))!;
      assert.deepEqual([sh[1].total, sh[1].received], [100, 100], "Shopify now totals 1.00 and shows 1.00 received");
      assert.deepEqual(w.shop.state.writes, { edit: 1, payment: 1, markPaid: 0 });
      assert.equal(w.sends.length, 1, "one 'payment received' confirmation");

      // replay: the very same delivery, then a different delivery of the same payment
      await w.deliver(u.payment.externalId!, "1.00", same);
      await w.deliver(u.payment.externalId!, "1.00", uid());
      assert.deepEqual(w.shop.state.writes, { edit: 1, payment: 1, markPaid: 0 }, "no second Shopify edit or payment");
      assert.equal(w.sends.length, 1, "no second WhatsApp confirmation");
      assert.equal(await tx.payment.count({ where: { orderId: u.orderId, externalSource: "CASHFREE" } }), 1, "no duplicate payment");
      assert.equal(await tx.activity.count({ where: { orderId: u.orderId, type: "PAYMENT_STATUS_CHANGED", title: { contains: "success", mode: "insensitive" } } }), 1, "one 'payment success' audit row");
    });
  });
});

describe("Shopify total mismatch and Shopify failure", () => {
  it("Shopify at the list price (649.00 vs CRM 51.00): the verified payment stays in the CRM, NOTHING is written to Shopify, a recoverable error is recorded; after Shopify is corrected one retry completes it once", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const u = await w.upgraded();
      w.shop.state.totalOverride = 64900;
      w.cf.pay(u.payment.externalId!, "1.00");
      assert.equal(await w.deliver(u.payment.externalId!, "1.00"), "processed");
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: u.payment.id }, select: { status: true } })).status, "SUCCESS");
      assert.deepEqual(w.shop.state.writes, { edit: 0, payment: 0, markPaid: 0 });
      const failed = (await w.meta(u.orderId)).shopifyPaymentSync;
      assert.equal(failed.status, "failed");
      assert.match(failed.reason, /neither the original \(51.00\)/);
      assert.match(failed.reason, /Retry Shopify payment sync/);

      w.shop.state.totalOverride = 0; // an authorised person corrected the Shopify order
      assert.equal((await syncShopifyPayment(tx, u.orderId, { source: ActivitySource.USER, getShopifyClient: () => w.shop.client() })).status, "synced");
      await syncShopifyPayment(tx, u.orderId, { source: ActivitySource.USER, getShopifyClient: () => w.shop.client() });
      assert.deepEqual(w.shop.state.writes, { edit: 1, payment: 1, markPaid: 0 }, "once, however often it is retried");
    });
  });

  it("Shopify unavailable: the payment is recorded, the sync is 'failed' with the reason (never reported as success), and a retry after recovery succeeds", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const u = await w.upgraded();
      w.shop.state.down = true;
      w.cf.pay(u.payment.externalId!, "1.00");
      assert.equal(await w.deliver(u.payment.externalId!, "1.00"), "processed");
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: u.payment.id }, select: { status: true } })).status, "SUCCESS");
      const failed = (await w.meta(u.orderId)).shopifyPaymentSync;
      assert.equal(failed.status, "failed");
      assert.match(failed.reason, /unavailable/i);
      assert.deepEqual(w.shop.state.writes, { edit: 0, payment: 0, markPaid: 0 });
      w.shop.state.down = false;
      assert.equal((await syncShopifyPayment(tx, u.orderId, { source: ActivitySource.USER, getShopifyClient: () => w.shop.client() })).status, "synced");
      assert.deepEqual(w.shop.state.writes, { edit: 1, payment: 1, markPaid: 0 });
    });
  });
});

describe("Shopify order creation whose answer is lost (timeout / dropped connection)", () => {
  it("the CRM order survives, the failure is reported, and retrying never creates a SECOND Shopify order", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      w.shop.state.lostResponse = true;
      const first = await w.createCod();
      assert.equal(first.order.paymentMode, "COD", "the CRM order is committed whatever Shopify did");
      assert.equal(w.shop.state.created.length, 1, "Shopify created it, the answer was lost");
      assert.notEqual(first.shopify?.status, "created", "never reported as a success");
      w.shop.state.lostResponse = false;
      const retried = await w.orders.pushOrderToShopify(w.user, first.order.id);
      assert.equal(w.shop.state.created.length, 1, "the retry found the order Shopify already holds instead of creating another");
      assert.ok(["created", "already_linked"].includes(retried.status), JSON.stringify(retried));
      assert.ok((await w.orderRow(first.order.id)).externalId, "the CRM order is now linked to that one Shopify order");
    });
  });
});
