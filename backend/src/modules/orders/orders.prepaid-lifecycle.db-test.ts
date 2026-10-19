// The prepaid lifecycle end to end: payment request first, the confirmed CRM order and the Shopify order only after Cashfree has VERIFIED the payment. ONE rolled-back transaction per test on the isolated test
// database; Cashfree and Shopify are scripted fakes and nothing real is ever called.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import { processCashfreeEvent } from "../cashfree/cashfree.webhook.processor.js";
import { applyPaymentUpdate } from "../cashfree/cashfree.apply.js";
import { createCashfreeReconciler } from "../cashfree/cashfree.catchup.js";
import { syncShopifyPayment } from "../cashfree/cashfree.payment-success.js";
import { markPrepaidOrderPaid } from "./orders.manual-payment.js";
import { confirmPaidPrepaidOrder } from "./orders.prepaid-confirm.js";
import OrdersService from "./orders.service.js";
import OrdersLiveService from "./orders.live.service.js";

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
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });

/** A scripted Shopify: records every create and mark-as-paid; reports the order as it would be saved. */
function fakeShopify(opts: { failCreate?: { times: number }; total?: number; rejectManualPayment?: boolean } = {}) {
  const total = opts.total ?? 1298;
  const calls = { create: 0, markPaid: 0, update: 0, manual: 0 };
  let failures = opts.failCreate?.times ?? 0;
  let sent: any = null;
  let id: string | null = null;
  let paid = false;
  const money = (v: number) => ({ shopMoney: { amount: v.toFixed(2) } });
  const client = {
    query: async (doc: string, vars: any) => {
      if (/customers\(/.test(doc) || /query.*customers/i.test(doc)) return { customers: { pageInfo: { hasNextPage: false, hasPreviousPage: false }, nodes: [] } };
      if (/orderCreate/.test(doc)) {
        calls.create += 1;
        if (failures > 0) { failures -= 1; return { orderCreate: { order: null, userErrors: [{ field: null, message: "Shopify is unavailable" }] } }; }
        sent = vars.order;
        id = String(Math.floor(1e8 + Math.random() * 9e8));
        return { orderCreate: { order: { id: `gid://shopify/Order/${id}`, name: `#T${id}` }, userErrors: [] } };
      }
      if (/crmOrderBySource/.test(doc)) return { orders: { nodes: id ? [{ id: `gid://shopify/Order/${id}`, name: `#T${id}` }] : [] } };
      if (/crmOrderVerify/.test(doc)) {
        return { order: { id: "x", note: sent.note, tags: sent.tags ?? [], displayFinancialStatus: paid ? "Paid" : "Pending", totalPriceSet: money(total), customer: sent.customer ? { id: "c" } : null,
          shippingAddress: sent.shippingAddress ? { address1: sent.shippingAddress.address1, city: sent.shippingAddress.city, zip: sent.shippingAddress.zip, provinceCode: "MH", countryCodeV2: "IN", firstName: sent.shippingAddress.firstName } : null,
          lineItems: { nodes: sent.lineItems.map(() => ({ requiresShipping: true })) }, metafields: { nodes: (sent.metafields ?? []).map((m: any) => ({ key: m.key })) } } };
      }
      if (/crmPrepaidUpgradeOrderState/.test(doc)) return { order: { id: String(vars.id), displayFinancialStatus: paid ? "PAID" : "PENDING", cancelledAt: null, currentTotalPriceSet: money(total), totalOutstandingSet: money(paid ? 0 : total), totalReceivedSet: money(paid ? total : 0) } };
      if (/crmPrepaidUpgradeManualPayment/.test(doc)) { calls.manual += 1; return opts.rejectManualPayment ? { orderCreateManualPayment: { order: null, userErrors: [{ field: null, message: "Payment provider is not configured on shop." }] } } : { orderCreateManualPayment: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }; }
      if (/crmOrderMarkAsPaid/.test(doc)) { calls.markPaid += 1; paid = true; return { orderMarkAsPaid: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }; }
      if (/orderUpdate/.test(doc)) { calls.update += 1; return { orderUpdate: { order: { id: "x" }, userErrors: [] } }; }
      return { order: { id: "gid://shopify/Order/1", tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
    },
  } as unknown as ShopifyClient;
  return { client, calls, get shopifyId() { return id; }, get paid() { return paid; }, get sent() { return sent; } };
}

function fakeCashfree() {
  const links = new Map<string, { status: string; amount: string; paid: string }>();
  const calls = { create: 0 };
  const mk = (id: string): CashfreeLink => { const l = links.get(id)!; return { cfLinkId: "1", linkId: id, linkStatus: l.status, linkUrl: `https://pay.test/${id}`, linkAmount: l.amount, linkAmountPaid: l.paid, linkExpiryTime: null } as CashfreeLink; };
  const api: CashfreeApi = {
    createLink: async (req) => { calls.create += 1; links.set(req.link_id, { status: "ACTIVE", amount: String(req.link_amount), paid: "0" }); return mk(req.link_id); },
    getLink: async (id) => mk(id),
    cancelLink: async () => null,
    getLinkOrders: async () => [],
    getOrderPayments: async () => [],
  };
  return { api, calls, set: (id: string, status: string, paid: string) => links.set(id, { ...links.get(id)!, status, paid }) };
}

const linkEvent = (linkId: string, amount: string, status = "PAID", id = uid()) => ({ id, type: "PAYMENT_LINK_EVENT", payload: { type: "PAYMENT_LINK_EVENT", data: { link_id: linkId, link_status: status, link_amount_paid: amount, order: { order_id: `CFPay_${id}` } } } });

async function world(tx: Db, runner: TxRunner, shopOpts: Parameters<typeof fakeShopify>[0] = {}) {
  const rep = await tx.user.create({ data: { name: "Aayush Tiwari", username: `r-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true } });
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Anil", mobile: "9811950001", normalizedMobile: "+919811950001", email: "anil@example.invalid", ownerId: rep.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Herbal Masala", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "649.00" }, select: { id: true } });
  const variant = await tx.productVariant.create({ data: { productId: product.id, name: "60 Pouches", price: "649.00", externalId: String(Math.floor(1e8 + Math.random() * 9e8)), externalSource: "SHOPIFY" }, select: { id: true } });
  const shop = fakeShopify(shopOpts);
  const cf = fakeCashfree();
  const cfSvc = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => cf.api, getShopifyClient: () => shop.client });
  const notify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const svc = new OrdersService(tx as never, () => shop.client, () => cfSvc as never, notify);
  const userRep = { id: rep.id, username: rep.username, role: Role.SALESPERSON };
  const create = (method: "PAYMENT_LINK" | "COD", extra: Record<string, unknown> = {}) => svc.createManualOrder(userRep, {
    ...extra,
    leadId: lead.id, items: [{ productId: product.id, variantId: variant.id, quantity: 2, unitPrice: "649.00" }], paymentMethod: method, sendPaymentLinkViaWhatsApp: false,
    shippingAddress: { name: "Anil Kumar Verma", line1: "Flat 7, Green Heights", line2: "Baner", houseNumber: "Flat 7", area: "Baner", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811950001" }, shippingPincode: "411045",
    ...(method === "COD" ? { shippingAmount: "0" } : {}),
  } as never);
  const deliver = async (ev: ReturnType<typeof linkEvent>) => {
    const { store } = memoryStore();
    const stored = await store.record({ eventType: ev.type, externalEventId: ev.id, payload: ev.payload, ignored: false });
    return processCashfreeEvent(stored.id, { store, runner, getShopifyClient: () => shop.client, verifyLink: (id) => cf.api.getLink(id) });
  };
  const state = async (orderId: string) => tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, externalId: true, metadata: true, totalAmount: true, payments: { select: { id: true, status: true, amount: true } } } });
  return { svc, create, deliver, state, shop, cf, cfSvc, runner, tx, lead, userRep, admin };
}

describe("prepaid lifecycle: payment request first, order after verified payment", () => {
  it("creating a prepaid order makes a payment request only: awaiting payment, NO Shopify order, a Cashfree link", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      assert.equal(r.shopify.status, "awaiting_payment");
      assert.equal(w.shop.calls.create, 0, "nothing was sent to Shopify");
      assert.equal(r.paymentLink?.status, "created");
      const s = await w.state(r.order.id);
      assert.deepEqual([s.status, s.externalId, s.payments.map((p) => p.status)], ["PENDING_PAYMENT", null, ["PENDING"]]);
      assert.equal(r.order.status, "PENDING_PAYMENT");
    });
  });

  it("Cashfree success creates the confirmed order's Shopify order exactly once and marks it paid; the CRM payment and status follow", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const link = r.paymentLink!;
      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: link.paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1298.00");
      assert.equal(await w.deliver(linkEvent(linkId, "1298.00")), "processed");
      const s = await w.state(r.order.id);
      assert.equal(s.status, "CONFIRMED");
      assert.ok(s.externalId, "linked to the Shopify order");
      assert.deepEqual(s.payments.map((p) => p.status), ["SUCCESS"]);
      assert.deepEqual([w.shop.calls.create, w.shop.calls.markPaid, w.shop.paid], [1, 1, true], JSON.stringify((s.metadata as any).shopifyPaymentSync ?? (s.metadata as any).shopifySync));
      assert.equal(w.shop.sent.financialStatus, "PENDING", "created unpaid and marked paid only because the CRM holds a verified payment");
      assert.ok(w.shop.sent.shippingAddress && w.shop.sent.customer, "the complete CRM data travelled");
      const meta = s.metadata as any;
      assert.equal(meta.shopifyPaymentSync.status, "synced");
    });
  });

  it("a duplicate and a concurrent success delivery never create a second Shopify order or a second payment", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: r.paymentLink!.paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1298.00");
      const ev = linkEvent(linkId, "1298.00");
      await w.deliver(ev);
      await w.deliver(ev);
      await w.deliver(linkEvent(linkId, "1298.00"));
      await Promise.all([w.deliver(linkEvent(linkId, "1298.00")), w.deliver(linkEvent(linkId, "1298.00"))]);
      assert.deepEqual([w.shop.calls.create, w.shop.calls.markPaid], [1, 1]);
      assert.equal(await tx.order.count({ where: { id: r.order.id } }), 1);
      assert.equal(await tx.payment.count({ where: { orderId: r.order.id, status: "SUCCESS" } }), 1);
    });
  });

  it("pending, expired and failed payments create no Shopify order and never confirm the order", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: r.paymentLink!.paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PARTIALLY_PAID", "100.00");
      await w.deliver(linkEvent(linkId, "100.00", "PARTIALLY_PAID"));
      w.cf.set(linkId, "EXPIRED", "0");
      await w.deliver(linkEvent(linkId, "0", "EXPIRED"));
      const s = await w.state(r.order.id);
      assert.deepEqual([s.status, s.externalId, w.shop.calls.create], ["PENDING_PAYMENT", null, 0]);
      assert.notEqual(s.payments[0]!.status, "SUCCESS");
    });
  });

  it("a wrong paid amount is not treated as a successful payment: no confirmation, no Shopify order", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: r.paymentLink!.paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1.00"); // far less than the 1298 link
      await w.deliver(linkEvent(linkId, "1.00"));
      const s = await w.state(r.order.id);
      assert.equal(w.shop.calls.create, 0, "an underpayment never creates the Shopify order");
      assert.equal(s.externalId, null);
    });
  });

  it("an unrelated / unknown link reference creates nothing", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      w.cf.set("some-other-link", "PAID", "1298.00");
      await w.deliver(linkEvent("some-other-link", "1298.00")).catch(() => undefined);
      assert.deepEqual([w.shop.calls.create, (await w.state(r.order.id)).externalId], [0, null]);
    });
  });

  it("a late success after an expired attempt still completes the order (a failed attempt never blocks a later legitimate payment)", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: r.paymentLink!.paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "EXPIRED", "0");
      await w.deliver(linkEvent(linkId, "0", "EXPIRED"));
      assert.equal((await w.state(r.order.id)).externalId, null);
      w.cf.set(linkId, "PAID", "1298.00");
      await w.deliver(linkEvent(linkId, "1298.00"));
      const s = await w.state(r.order.id);
      assert.deepEqual([s.status, Boolean(s.externalId), w.shop.calls.create], ["CONFIRMED", true, 1]);
    });
  });

  it("Shopify failing AFTER a successful payment keeps the payment and the confirmed order, records the failure, and the retry finishes it (paid) without charging again", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner, { failCreate: { times: 2 } }); // both the create and its immediate fallback fail
      const r = await w.create("PAYMENT_LINK");
      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: r.paymentLink!.paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1298.00");
      await w.deliver(linkEvent(linkId, "1298.00"));
      let s = await w.state(r.order.id);
      assert.deepEqual([s.status, s.externalId, s.payments.map((p) => p.status)], ["CONFIRMED", null, ["SUCCESS"]], "paid and confirmed, not yet in Shopify");
      assert.equal((s.metadata as any).shopifySync.status, "failed");
      assert.equal(w.cf.calls.create, 1, "the customer is never asked to pay again");
      // the existing explicit retry (Push to Shopify)
      const retry = await w.svc.pushOrderToShopify(w.admin ? { id: w.admin.id, username: w.admin.username, role: Role.ADMIN } : null, r.order.id);
      assert.equal(retry.status, "created");
      s = await w.state(r.order.id);
      assert.ok(s.externalId);
      assert.equal(w.shop.paid, true, "marked paid on the retry because the verified payment exists");
      assert.equal(w.cf.calls.create, 1);
    });
  });

  it("COD is unchanged: the order is confirmed and pushed to Shopify at once, pending, with no payment link and no mark-as-paid", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("COD");
      assert.equal(r.shopify.status, "created");
      assert.deepEqual([r.order.status, w.shop.calls.create, w.shop.calls.markPaid, w.cf.calls.create], ["CONFIRMED", 1, 0, 0]);
      assert.equal(w.shop.sent.financialStatus, "PENDING");
      assert.equal(r.paymentLink, null);
    });
  });

  it("a prepaid order is never marked paid on Shopify unless a verified successful payment exists", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      // someone pushes the unpaid prepaid order manually (e.g. the old Push to Shopify button)
      const pushed = await w.svc.pushOrderToShopify({ id: w.admin.id, username: w.admin.username, role: Role.ADMIN }, r.order.id);
      assert.equal(pushed.status, "created");
      assert.equal(w.shop.calls.markPaid, 0);
      assert.equal(w.shop.paid, false);
    });
  });
});

/** A fake Shopify for the Orders page (the live list): answers the connection check, then returns whatever order nodes the test has "created" so far. */
function liveListClient() {
  let nodes: unknown[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (typeof body.query === "string" && body.query.includes("ConnectionCheck")) {
      return json({ data: { shop: { name: "Demo", myshopifyDomain: "demo-store.myshopify.com", currencyCode: "INR", ianaTimezone: "Asia/Kolkata" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } });
    }
    return json({ data: { orders: { pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, nodes } } });
  }) as unknown as typeof fetch;
  const client = new ShopifyClient(loadShopifyConfig({ SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_faketoken", SHOPIFY_API_VERSION: "2026-01" }), { fetchImpl });
  const now = new Date().toISOString();
  const show = (id: string, name: string, total: string) => {
    nodes = [{
      id, name, createdAt: now, processedAt: now, cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", returnStatus: null, tags: [], paymentGatewayNames: ["Cashfree"],
      email: "anil@example.invalid", phone: null, customer: { firstName: "Anil", lastName: "Verma", email: "anil@example.invalid", phone: null }, shippingLine: { title: "Standard" },
      totalPriceSet: { shopMoney: { amount: total, currencyCode: "INR" } }, totalRefundedSet: null, lineItems: { nodes: [{ id: "gid://shopify/LineItem/1" }] }, transactions: [], fulfillments: [],
    }];
  };
  return { client, show };
}

describe("prepaid lifecycle: the Orders page (a cached live Shopify list) picks the order up as soon as it is paid", () => {
  it("a page cached while the order awaited payment does not hide it afterwards, and shows the confirmed status", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const live = liveListClient();
      const pages = new OrdersLiveService(tx as never, () => live.client);
      const admin = { id: w.admin.id, username: w.admin.username, role: Role.ADMIN };
      const query = { first: 25, search: `prepaid-cache-${uid()}` };

      const r = await w.create("PAYMENT_LINK");
      const before = await pages.listLiveOrders(admin, query);
      assert.equal(before.items.length, 0, "awaiting payment: there is no Shopify order yet, so the Orders page does not show it as an order");

      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: r.paymentLink!.paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1298.00");
      assert.equal(await w.deliver(linkEvent(linkId, "1298.00")), "processed");
      live.show(`gid://shopify/Order/${w.shop.shopifyId}`, "#T1001", "1298.00");

      const after = await pages.listLiveOrders(admin, query);
      assert.deepEqual(after.items.map((i) => [i.id, i.status, i.linkedInCrm]), [[r.order.id, "CONFIRMED", true]], "the same query, asked again, is not served from the stale cache");
      assert.equal(after.items[0].paymentStatus, "SUCCESS");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// RECOVERY of an already-paid order. Real incident: the payment row was SUCCESS (webhook applied by a build without the confirmation step) but the prepaid order stayed PENDING_PAYMENT with no Shopify order.
// The stuck state is recreated exactly: the payment is applied through applyPaymentUpdate ONLY (no confirmation, no Shopify), then each recovery path is exercised.
describe("prepaid lifecycle: an already-paid order whose confirmation never ran is recovered, safely and only once", () => {
  type World = Awaited<ReturnType<typeof world>>;
  async function paidButStuck(w: World) {
    const r = await w.create("PAYMENT_LINK");
    const paymentId = r.paymentLink!.paymentId as string;
    const linkId = (await w.tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { externalId: true } })).externalId!;
    w.cf.set(linkId, "PAID", "1298.00");
    await applyPaymentUpdate(w.tx, paymentId, { status: "SUCCESS", paidAmount: "1298.00", method: "UPI", cfPaymentId: "6757932511", bankReference: "628907008381" }, { source: ActivitySource.CASHFREE_WEBHOOK });
    const s = await w.state(r.order.id);
    assert.deepEqual([s.status, s.externalId, s.payments.map((p) => p.status)], ["PENDING_PAYMENT", null, ["SUCCESS"]], "precondition: exactly the incident state");
    return { orderId: r.order.id, paymentId, linkId };
  }
  const confirmedEvents = (w: World, orderId: string) => w.tx.activity.count({ where: { orderId, type: "ORDER_STATUS_CHANGED" } });

  it("Refresh finishes it: CONFIRMED, ONE Shopify order marked paid, original placedAt kept; repeating Refresh / a webhook / the catch-up changes nothing", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const { orderId, paymentId, linkId } = await paidButStuck(w);
      const before = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { placedAt: true } });
      await w.cfSvc.refreshPaymentLink(w.userRep, paymentId);
      const s = await w.state(orderId);
      assert.equal(s.status, "CONFIRMED");
      assert.ok(s.externalId, "linked to the Shopify order");
      assert.deepEqual(s.payments.map((p) => p.status), ["SUCCESS"]);
      assert.deepEqual([w.shop.calls.create, w.shop.calls.markPaid, w.shop.paid], [1, 1, true]);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { placedAt: true } })).placedAt?.getTime(), before.placedAt?.getTime(), "placedAt is NOT reset to the repair time");
      assert.equal(await confirmedEvents(w, orderId), 1);

      await w.cfSvc.refreshPaymentLink(w.userRep, paymentId);
      assert.equal(await w.deliver(linkEvent(linkId, "1298.00")), "processed");
      await w.cfSvc.reconcileOpenPayment(paymentId);
      assert.deepEqual([w.shop.calls.create, w.shop.calls.markPaid], [1, 1], "no second Shopify order, no second mark-as-paid");
      assert.equal(await confirmedEvents(w, orderId), 1, "no second audit event");
      assert.equal(await tx.payment.count({ where: { orderId } }), 1);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
    });
  });

  it("a repeated success WEBHOOK delivery finishes it too", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const { orderId, linkId } = await paidButStuck(w);
      assert.equal(await w.deliver(linkEvent(linkId, "1298.00")), "processed");
      const s = await w.state(orderId);
      assert.deepEqual([s.status, !!s.externalId, w.shop.calls.create, w.shop.calls.markPaid], ["CONFIRMED", true, 1, 1]);
    });
  });

  it("the scheduled catch-up finds the stuck order (a SUCCESS payment, not just open links) and finishes it", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const { orderId } = await paidButStuck(w);
      const pass = await createCashfreeReconciler({ runner, reconcile: (id) => w.cfSvc.reconcileOpenPayment(id) }).tick();
      assert.ok(pass && pass.checked >= 1 && pass.errors === 0, JSON.stringify(pass));
      const s = await w.state(orderId);
      assert.deepEqual([s.status, !!s.externalId, w.shop.calls.create, w.shop.calls.markPaid], ["CONFIRMED", true, 1, 1]);
      const again = await createCashfreeReconciler({ runner, reconcile: (id) => w.cfSvc.reconcileOpenPayment(id) }).tick();
      assert.equal(again?.checked, 0, "once confirmed it is no longer picked up");
    });
  });

  it("a webhook, Refresh and the catch-up racing on the same stuck order create exactly ONE Shopify order", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const { orderId, paymentId, linkId } = await paidButStuck(w);
      await Promise.all([w.deliver(linkEvent(linkId, "1298.00")), w.cfSvc.refreshPaymentLink(w.userRep, paymentId), w.cfSvc.reconcileOpenPayment(paymentId), w.deliver(linkEvent(linkId, "1298.00", "PAID", uid()))]);
      const s = await w.state(orderId);
      // The harness runs on ONE connection, so advisory locks cannot serialize the racers here (in production the order/sync locks do, and Shopify rejects a repeat mark-as-paid harmlessly): the invariants are one order, one confirmation, paid.
      assert.deepEqual([s.status, w.shop.calls.create, w.shop.calls.markPaid >= 1, w.shop.paid, await confirmedEvents(w, orderId), await tx.payment.count({ where: { orderId } })], ["CONFIRMED", 1, true, true, 1, 1]);
    });
  });

  it("it is confirmed only for the order that was actually paid: a second unpaid order is left alone", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const paid = await paidButStuck(w);
      const other = await w.create("PAYMENT_LINK");
      await w.cfSvc.refreshPaymentLink(w.userRep, paid.paymentId);
      assert.equal((await w.state(paid.orderId)).status, "CONFIRMED");
      const o = await w.state(other.order.id);
      assert.deepEqual([o.status, o.externalId, o.payments.map((p) => p.status), w.shop.calls.create], ["PENDING_PAYMENT", null, ["PENDING"], 1]);
    });
  });

  it("amount, currency and payment identity must match the order: otherwise nothing is confirmed and Shopify is not touched", async () => {
    // amount: the stored payment is not what the order costs
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const { orderId, paymentId } = await paidButStuck(w);
      await tx.payment.update({ where: { id: paymentId }, data: { amount: "1.00" } });
      await w.cfSvc.refreshPaymentLink(w.userRep, paymentId); // Cashfree says 1298, the row says 1: nothing may be confirmed from that
      const res = await confirmPaidPrepaidOrder(tx, orderId, { getShopifyClient: () => w.shop.client });
      assert.equal(res.confirmed, false, JSON.stringify(res));
      assert.deepEqual([(await w.state(orderId)).status, w.shop.calls.create], ["PENDING_PAYMENT", 0]);
    });
    // currency
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const { orderId, paymentId } = await paidButStuck(w);
      await tx.payment.update({ where: { id: paymentId }, data: { currency: "USD" } });
      const res = await confirmPaidPrepaidOrder(tx, orderId, { getShopifyClient: () => w.shop.client });
      assert.equal(res.confirmed, false, JSON.stringify(res));
      assert.deepEqual([(await w.state(orderId)).status, w.shop.calls.create], ["PENDING_PAYMENT", 0]);
    });
    // payment identity: a successful payment that did not come from Cashfree is not proof for this path
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const { orderId, paymentId } = await paidButStuck(w);
      await tx.payment.update({ where: { id: paymentId }, data: { externalSource: "SHOPIFY" } });
      const res = await confirmPaidPrepaidOrder(tx, orderId, { getShopifyClient: () => w.shop.client });
      assert.equal(res.confirmed, false, JSON.stringify(res));
      assert.deepEqual([(await w.state(orderId)).status, w.shop.calls.create], ["PENDING_PAYMENT", 0]);
    });
  });

  it("Shopify failing during recovery keeps the paid, confirmed order and records it; the existing safe retry then creates the ONE Shopify order", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner, { failCreate: { times: 2 } });
      const { orderId, paymentId } = await paidButStuck(w);
      await w.cfSvc.refreshPaymentLink(w.userRep, paymentId);
      const failed = await w.state(orderId);
      assert.deepEqual([failed.status, failed.externalId, failed.payments.map((p) => p.status)], ["CONFIRMED", null, ["SUCCESS"]]);
      assert.equal((failed.metadata as any).shopifySync?.status, "failed");
      const admin = { id: w.admin.id, username: w.admin.username, role: Role.ADMIN };
      const retry = await w.svc.pushOrderToShopify(admin, orderId);
      assert.equal(retry.status, "created");
      const done = await w.state(orderId);
      assert.ok(done.externalId);
      assert.deepEqual([w.shop.paid, w.shop.calls.markPaid, await tx.payment.count({ where: { orderId } })], [true, 1, 1]);
      await w.cfSvc.refreshPaymentLink(w.userRep, paymentId);
      assert.equal((await w.svc.pushOrderToShopify(admin, orderId)).status, "already_linked");
      assert.equal(w.shop.calls.create, 3, "two failed attempts (Shopify down) + one successful creation, never a fourth");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Shopify PAYMENT RECORDING for a CRM-discounted prepaid order. Real incident (two orders, both CRM-discounted to INR 1): the Shopify order already held the CRM total although the discount had not been
// mirrored, so the sync took the "discount edit + manual payment" path, which has nothing to edit and whose manual-payment step Shopify rejected ("Payment provider is not configured on shop").
describe("prepaid lifecycle: recording the payment on Shopify for a CRM-discounted order", () => {
  const admin = (w: Awaited<ReturnType<typeof world>>) => ({ id: w.admin.id, username: w.admin.username, role: Role.ADMIN });
  async function discountedOrderOnShopify(w: Awaited<ReturnType<typeof world>>, notMirrored: boolean) {
    const r = await w.create("PAYMENT_LINK", { discountPercent: "10" }); // 1298.00 - 10% = 1168.20
    const orderId = r.order.id;
    assert.equal(Number(r.order.totalAmount), 1168.2);
    const pushed = await w.svc.pushOrderToShopify(admin(w), orderId); // created unpaid: the CRM holds no payment yet
    assert.equal(pushed.status, "created");
    if (notMirrored) {
      const row = await w.tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } });
      await w.tx.order.update({ where: { id: orderId }, data: { metadata: { ...(row.metadata as object), shopifyTotals: { mirrored: false, total: "1168.20" } } as never } });
    }
    const paymentId = r.paymentLink!.paymentId as string;
    await applyPaymentUpdate(w.tx, paymentId, { status: "SUCCESS", paidAmount: "1168.20", method: "UPI", cfPaymentId: "6757932511", bankReference: "628907008381" }, { source: ActivitySource.CASHFREE_WEBHOOK });
    return { orderId };
  }

  it("Shopify already holds the CRM total (discount not mirrored): the order is marked paid for exactly that total - the manual-payment step Shopify rejects is never used", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner, { total: 1168.2, rejectManualPayment: true });
      const { orderId } = await discountedOrderOnShopify(w, true);
      const res = await syncShopifyPayment(tx, orderId, { source: ActivitySource.SYSTEM, getShopifyClient: () => w.shop.client });
      assert.equal(res.status, "synced", JSON.stringify(res));
      assert.deepEqual([w.shop.calls.markPaid, w.shop.calls.manual, w.shop.paid], [1, 0, true]);
      assert.equal(((await w.state(orderId)).metadata as any).shopifyPaymentSync.status, "synced");
      // idempotent: a repeat records nothing more
      assert.equal((await syncShopifyPayment(tx, orderId, { source: ActivitySource.SYSTEM, getShopifyClient: () => w.shop.client })).status, "synced");
      assert.deepEqual([w.shop.calls.markPaid, w.shop.calls.manual], [1, 0]);
    });
  });

  it("when Shopify's total is NOT the CRM total, it is still never marked paid blindly: nothing is forced onto an order that disagrees", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner, { total: 1500, rejectManualPayment: true }); // Shopify says 1500; the CRM charged 1168.20 and the discount was not mirrored
      const { orderId } = await discountedOrderOnShopify(w, true);
      const res = await syncShopifyPayment(tx, orderId, { source: ActivitySource.SYSTEM, getShopifyClient: () => w.shop.client });
      assert.equal(res.status, "failed", JSON.stringify(res));
      assert.equal(w.shop.calls.markPaid, 0, "no whole-order mark-as-paid for an amount the CRM did not collect");
      assert.equal(w.shop.paid, false);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// MANUAL prepaid payment (verified outside Cashfree), exact "CRM Confirmed by" attribution, and the status repair of an already-linked paid order.
describe("manual prepaid payment: separate, audited, never Cashfree-verified", () => {
  const REASON = "Customer paid on the telecaller's own QR; screenshot of the UPI success checked against the bank app";
  const tagOf = async (w: Awaited<ReturnType<typeof world>>, orderId: string) => (((await w.tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata as any).shopifyConfirmationTag ?? {}) as { status?: string; tag?: string };

  it("marks an unpaid prepaid order paid: confirmed, ONE manual non-Cashfree payment, full audit, Shopify created and marked paid, 'CRM Confirmed by <that person>'", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      assert.equal((await w.state(r.order.id)).status, "PENDING_PAYMENT");
      const out = await markPrepaidOrderPaid(runner, w.userRep, r.order.id, { reason: REASON, reference: "UTR 4455667788" }, { getShopifyClient: () => w.shop.client });
      assert.deepEqual([out.alreadyPaid, out.orderStatus, out.payment.verification, out.shopify.linked, out.shopify.paymentSync], [false, "CONFIRMED", "MANUAL_EXTERNAL", true, "synced"]);
      const pays = await tx.payment.findMany({ where: { orderId: r.order.id }, orderBy: { createdAt: "asc" }, select: { status: true, provider: true, externalSource: true, providerPaymentId: true, providerOrderId: true, transactionReference: true, amount: true, metadata: true } });
      const manual = pays.find((p) => p.provider === "MANUAL")!;
      assert.deepEqual([manual.status, manual.externalSource, manual.providerPaymentId, manual.providerOrderId, manual.transactionReference, String(manual.amount)], ["SUCCESS", null, null, null, "UTR 4455667788", "1298"], "no Cashfree identity is ever invented");
      assert.equal((manual.metadata as any).manual.verifiedById, w.userRep.id);
      assert.equal((manual.metadata as any).manual.reason, REASON);
      assert.equal(pays.filter((p) => p.externalSource === "CASHFREE").map((p) => p.status).join(), "PENDING", "the Cashfree link row is untouched (no fabricated Cashfree success)");
      const audit = await tx.activity.findFirstOrThrow({ where: { orderId: r.order.id, title: { contains: "manually marked as paid" } }, select: { actorId: true, actorRole: true, source: true, description: true, metadata: true, title: true } });
      assert.deepEqual([audit.actorId, audit.actorRole, audit.source], [w.userRep.id, "SALESPERSON", "USER"]);
      assert.match(audit.title ?? "", /verified outside Cashfree/);
      assert.match(audit.description ?? "", /UTR 4455667788/);
      assert.equal((audit.metadata as any).cashfreeVerified, false);
      const s = await w.state(r.order.id);
      assert.deepEqual([s.status, !!s.externalId, w.shop.calls.create, w.shop.calls.markPaid, w.shop.paid], ["CONFIRMED", true, 1, 1, true]);
      const row = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { confirmedByName: true, confirmedByUserId: true } });
      assert.deepEqual([row.confirmedByName, row.confirmedByUserId], ["Aayush Tiwari", w.userRep.id]);
      assert.deepEqual(await tagOf(w, r.order.id), { status: "synced", tag: "CRM Confirmed by Aayush Tiwari", syncedAt: (await tagOf(w, r.order.id) as any).syncedAt, removed: [] });
    });
  });

  it("is idempotent: a second mark-paid (double click, retry) records no second payment, no second audit entry and no second Shopify order", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const deps = { getShopifyClient: () => w.shop.client };
      await markPrepaidOrderPaid(runner, w.userRep, r.order.id, { reason: REASON }, deps);
      const again = await markPrepaidOrderPaid(runner, w.userRep, r.order.id, { reason: REASON }, deps);
      const concurrent = await Promise.all([markPrepaidOrderPaid(runner, { ...w.admin, role: Role.ADMIN }, r.order.id, { reason: REASON }, deps), markPrepaidOrderPaid(runner, w.userRep, r.order.id, { reason: REASON }, deps)]);
      assert.equal(again.alreadyPaid, true);
      assert.ok(concurrent.every((c) => c.alreadyPaid));
      assert.equal(await tx.payment.count({ where: { orderId: r.order.id, provider: "MANUAL" } }), 1);
      assert.equal(await tx.activity.count({ where: { orderId: r.order.id, title: { contains: "manually marked as paid" } } }), 1);
      assert.deepEqual([w.shop.calls.create, w.shop.calls.markPaid], [1, 1]);
    });
  });

  it("permissions: Admin, Manager and Salesperson (within their scope) may; HR, Recruiter and a Salesperson outside the order's scope may not - and COD / cancelled orders are refused", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const deps = { getShopifyClient: () => w.shop.client };
      const mk = async (role: Role) => { const u = await tx.user.create({ data: { name: `U ${role}`, username: `u-${uid()}`, role }, select: { id: true, username: true } }); return { id: u.id, username: u.username, role }; };
      for (const role of [Role.HR, Role.RECRUITER]) await assert.rejects(async () => markPrepaidOrderPaid(runner, await mk(role), r.order.id, { reason: REASON }, deps), (e: any) => e.statusCode === 403, role);
      await assert.rejects(async () => markPrepaidOrderPaid(runner, await mk(Role.SALESPERSON), r.order.id, { reason: REASON }, deps), (e: any) => e.statusCode === 404, "another salesperson's customer: out of scope looks like not found");
      await assert.rejects(() => markPrepaidOrderPaid(runner, w.userRep, r.order.id, { reason: "x" }, deps), (e: any) => e.statusCode === 400, "a reason is required");
      assert.equal(await tx.payment.count({ where: { orderId: r.order.id, provider: "MANUAL" } }), 0, "every refusal left nothing behind");

      const cod = await w.create("COD");
      await assert.rejects(() => markPrepaidOrderPaid(runner, { ...w.admin, role: Role.ADMIN }, cod.order.id, { reason: REASON }, deps), (e: any) => e.statusCode === 400 && /prepaid/i.test(e.message));
      await tx.order.update({ where: { id: r.order.id }, data: { status: "CANCELLED" } });
      await assert.rejects(() => markPrepaidOrderPaid(runner, { ...w.admin, role: Role.ADMIN }, r.order.id, { reason: REASON }, deps), (e: any) => e.statusCode === 409);

      const ok = await w.create("PAYMENT_LINK");
      assert.equal((await markPrepaidOrderPaid(runner, { ...w.admin, role: Role.ADMIN }, ok.order.id, { reason: REASON }, deps)).orderStatus, "CONFIRMED", "an admin may");
    });
  });

  it("a Shopify failure is reported clearly and never undoes the recorded payment; the existing safe retry then creates the ONE Shopify order", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner, { failCreate: { times: 2 } });
      const r = await w.create("PAYMENT_LINK");
      const out = await markPrepaidOrderPaid(runner, w.userRep, r.order.id, { reason: REASON }, { getShopifyClient: () => w.shop.client });
      assert.deepEqual([out.orderStatus, out.shopify.linked, out.payment.verification], ["CONFIRMED", false, "MANUAL_EXTERNAL"]);
      assert.ok(out.shopify.reason, "the Shopify problem is shown, not hidden");
      assert.equal(await tx.payment.count({ where: { orderId: r.order.id, provider: "MANUAL", status: "SUCCESS" } }), 1);
      const retry = await w.svc.pushOrderToShopify({ id: w.admin.id, username: w.admin.username, role: Role.ADMIN }, r.order.id);
      assert.equal(retry.status, "created");
      assert.deepEqual([w.shop.paid, w.shop.calls.markPaid], [true, 1]);
    });
  });

  it("a manual payment is never labelled Cashfree: a later Cashfree success for the same order is flagged as an over-collection, creates no second Shopify order, and nothing is reverted", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      await markPrepaidOrderPaid(runner, w.userRep, r.order.id, { reason: REASON }, { getShopifyClient: () => w.shop.client });
      const linkId = (await tx.payment.findFirstOrThrow({ where: { orderId: r.order.id, externalSource: "CASHFREE" }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1298.00");
      await w.deliver(linkEvent(linkId, "1298.00"));
      const s = await w.state(r.order.id);
      assert.deepEqual([s.status, w.shop.calls.create, w.shop.calls.markPaid], ["CONFIRMED", 1, 1]);
      assert.ok((await tx.activity.count({ where: { orderId: r.order.id, type: "PAYMENT_MISMATCH_DETECTED" } })) >= 1, "the double payment is surfaced to admins");
    });
  });
});

describe("exact confirmation tag: 'CRM Confirmed by <the responsible person>'", () => {
  const tag = async (tx: Db, orderId: string) => (((await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata as any).shopifyConfirmationTag ?? {}) as { status?: string; tag?: string };

  it("a Cashfree-verified prepaid order is attributed to its CREATOR (server-side user data), so the Shopify order gets exactly 'CRM Confirmed by <creator name>'", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      const linkId = (await tx.payment.findFirstOrThrow({ where: { orderId: r.order.id }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1298.00");
      await w.deliver(linkEvent(linkId, "1298.00"));
      const row = await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { confirmedByName: true, confirmedByUserId: true, status: true } });
      assert.deepEqual([row.status, row.confirmedByName, row.confirmedByUserId], ["CONFIRMED", "Aayush Tiwari", w.userRep.id]);
      const t = await tag(tx, r.order.id);
      assert.deepEqual([t.status, t.tag], ["synced", "CRM Confirmed by Aayush Tiwari"]);
      assert.equal(await tx.activity.count({ where: { orderId: r.order.id, type: "ORDER_CONFIRMED" } }), 1, "confirmed once; a repeated delivery adds nothing");
      await w.deliver(linkEvent(linkId, "1298.00", "PAID", uid()));
      assert.equal(await tx.activity.count({ where: { orderId: r.order.id, type: "ORDER_CONFIRMED" } }), 1);
    });
  });

  it("an admin-created order carries the ADMIN's actual name, never a hardcoded or generic one", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const adminUser = { id: w.admin.id, username: w.admin.username, role: Role.ADMIN };
      const r = await w.svc.createManualOrder(adminUser as never, { leadId: w.lead.id, items: [{ productId: (await tx.product.findFirstOrThrow({ select: { id: true } })).id, quantity: 1, unitPrice: "649.00" }], paymentMethod: "COD", shippingAddress: { name: "Anil", line1: "Flat 7", city: "Pune", state: "Maharashtra", pincode: "411045", phone: "9811950001" }, shippingPincode: "411045" } as never);
      assert.deepEqual((await tag(tx, r.order.id)), { ...(await tag(tx, r.order.id)), status: "synced", tag: "CRM Confirmed by Admin" });
    });
  });
});

describe("a CRM order already linked to Shopify whose status never caught up with its verified payment (the CRM-MVAJPISK-93HR case)", () => {
  it("is repaired in the CRM only: CONFIRMED once, creator recorded as confirmer, NO second Shopify order and no duplicate audit entry; repeating it changes nothing", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      // the old build: the order was pushed to Shopify while unpaid ...
      assert.equal((await w.svc.pushOrderToShopify({ id: w.admin.id, username: w.admin.username, role: Role.ADMIN }, r.order.id)).status, "created");
      const paymentId = r.paymentLink!.paymentId as string;
      const linkId = (await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { externalId: true } })).externalId!;
      w.cf.set(linkId, "PAID", "1298.00");
      // ... and the payment was applied WITHOUT the confirmation step
      await applyPaymentUpdate(tx, paymentId, { status: "SUCCESS", paidAmount: "1298.00", method: "UPI", cfPaymentId: "6756298625" }, { source: ActivitySource.CASHFREE_WEBHOOK });
      const stuck = await w.state(r.order.id);
      assert.deepEqual([stuck.status, !!stuck.externalId, w.shop.calls.create], ["PENDING_PAYMENT", true, 1]);
      await w.cfSvc.refreshPaymentLink(w.userRep, paymentId);
      await w.cfSvc.refreshPaymentLink(w.userRep, paymentId);
      await w.cfSvc.reconcileOpenPayment(paymentId);
      const fixed = await w.state(r.order.id);
      assert.deepEqual([fixed.status, w.shop.calls.create], ["CONFIRMED", 1]);
      assert.equal(await tx.activity.count({ where: { orderId: r.order.id, type: "ORDER_STATUS_CHANGED" } }), 1);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: r.order.id }, select: { confirmedByName: true } })).confirmedByName, "Aayush Tiwari");
    });
  });

  it("never confirms a linked order without a matching verified payment: wrong amount stays unconfirmed, and a Shopify-synced order is out of scope", async () => {
    await inRollback(async (tx, runner) => {
      const w = await world(tx, runner);
      const r = await w.create("PAYMENT_LINK");
      await w.svc.pushOrderToShopify({ id: w.admin.id, username: w.admin.username, role: Role.ADMIN }, r.order.id);
      const paymentId = r.paymentLink!.paymentId as string;
      await applyPaymentUpdate(tx, paymentId, { status: "SUCCESS", paidAmount: "1298.00", method: "UPI" }, { source: ActivitySource.CASHFREE_WEBHOOK });
      await tx.payment.update({ where: { id: paymentId }, data: { amount: "1.00" } });
      assert.equal((await confirmPaidPrepaidOrder(tx, r.order.id, { getShopifyClient: () => w.shop.client })).confirmed, false);
      assert.equal((await w.state(r.order.id)).status, "PENDING_PAYMENT");
      await tx.order.update({ where: { id: r.order.id }, data: { source: "SHOPIFY" } });
      await tx.payment.update({ where: { id: paymentId }, data: { amount: "1298.00" } });
      assert.equal((await confirmPaidPrepaidOrder(tx, r.order.id, { getShopifyClient: () => w.shop.client })).shopify, "not_applicable");
    });
  });
});
