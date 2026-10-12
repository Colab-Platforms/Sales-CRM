// Database tests for the single Cashfree reconciliation path (webhook / Refresh / scheduled catch-up -> CRM payment -> Shopify). Run with: npm run test:db
// Each test runs in ONE rolled-back transaction. Cashfree and Shopify are fakes: no network, no credentials, no real order is ever touched.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, Role } from "../../../generated/prisma/enums.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { ENV as SHOPIFY_ENV } from "../shopify/shopify.fixtures.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import type { CashfreeLink } from "./cashfree.client.js";
import { loadCashfreeConfig } from "./cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "./cashfree.payments.service.js";
import { createCashfreeReconciler } from "./cashfree.catchup.js";
import { processCashfreeEvent } from "./cashfree.webhook.processor.js";

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
const SHOPIFY_CONFIG = loadShopifyConfig(SHOPIFY_ENV);

/** A stateful fake of the Shopify order the reconciliation edits: list price 1199, unpaid. Counts every write. */
function fakeShopify() {
  const s = { total: 119900, received: 0, writes: { edit: 0, payment: 0, markPaid: 0 }, discounts: [] as string[], staged: 0 };
  const money = (c: number) => ({ shopMoney: { amount: (c / 100).toFixed(1) } });
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    let data: unknown;
    if (query.includes("crmPrepaidUpgradeOrderState")) data = { order: { id: String(variables.id), displayFinancialStatus: s.received > 0 && s.received >= s.total ? "PAID" : "PENDING", cancelledAt: null, currentTotalPriceSet: money(s.total), totalOutstandingSet: money(s.total - s.received), totalReceivedSet: money(s.received) } };
    else if (query.includes("crmPrepaidUpgradeEditBegin")) data = { orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/1", lineItems: { nodes: [{ id: "li1", quantity: 1, originalUnitPriceSet: money(119900) }] } }, userErrors: [] } };
    else if (query.includes("crmPrepaidUpgradeEditDiscount")) {
      const d = variables.discount as { description: string; fixedValue: { amount: string } };
      s.discounts.push(d.description);
      s.staged = s.total - Math.round(Number(d.fixedValue.amount) * 100);
      data = { orderEditAddLineItemDiscount: { calculatedOrder: { totalPriceSet: money(s.staged), totalOutstandingSet: money(s.staged) }, userErrors: [] } };
    } else if (query.includes("crmPrepaidUpgradeEditCommit")) { s.writes.edit++; s.total = s.staged; data = { orderEditCommit: { order: { id: "x" }, userErrors: [] } }; }
    else if (query.includes("crmPrepaidUpgradeManualPayment")) { s.writes.payment++; s.received = s.total; data = { orderCreateManualPayment: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }; }
    else if (query.includes("crmOrderMarkAsPaid")) { s.writes.markPaid++; data = { orderMarkAsPaid: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }; }
    else throw new Error(`unexpected Shopify call: ${query.slice(0, 60)}`);
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { state: s, client: () => new ShopifyClient(SHOPIFY_CONFIG, { fetchImpl }) };
}

/** A fake Cashfree: link statuses are set by the test; the requested link amount is recorded. */
function fakeCashfree() {
  const links = new Map<string, { status: string; amount: string; paid: string }>();
  const calls = { create: [] as number[], get: 0, cancel: 0 };
  const mk = (id: string): CashfreeLink => {
    const l = links.get(id)!;
    return { cfLinkId: "1", linkId: id, linkStatus: l.status, linkUrl: `https://pay.test/${id}`, linkAmount: l.amount, linkAmountPaid: l.paid, linkExpiryTime: null } as CashfreeLink;
  };
  const api: CashfreeApi = {
    createLink: async (req) => { calls.create.push(req.link_amount); links.set(req.link_id, { status: "ACTIVE", amount: String(req.link_amount), paid: "0" }); return mk(req.link_id); },
    getLink: async (id) => { calls.get++; return mk(id); },
    cancelLink: async () => { calls.cancel++; return null; },
    getLinkOrders: async () => [],
    getOrderPayments: async () => [],
  };
  return { api, calls, pay: (id: string, amount: string) => links.set(id, { ...links.get(id)!, status: "PAID", paid: amount }), setStatus: (id: string, status: string) => links.set(id, { ...links.get(id)!, status }) };
}

async function seed(tx: Db) {
  const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true } });
  const source = await tx.source.create({ data: { name: "Web", code: `w-${uid()}` }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Fake", lastName: "Customer", mobile: "9876500000", normalizedMobile: "+919876500000", sourceId: source.id, ownerId: rep.id }, select: { id: true } });
  // WhatsApp Inbox order: list 1199, CRM discount 1198, payable 1, linked to a (fake) Shopify order held in the canonical numeric form.
  const order = await tx.order.create({
    data: { orderNumber: `FAKE-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.PENDING_PAYMENT, currency: "INR", subtotal: "1199.00", discountAmount: "1198.00", totalAmount: "1.00", externalSource: "SHOPIFY", externalId: `9${Date.now()}${Math.floor(Math.random() * 1000)}`, metadata: { createdVia: "WHATSAPP_INBOX", discount: { originalSubtotal: "1199.00", discountAmount: "1198.00" } } },
    select: { id: true, externalId: true },
  });
  return { user: { id: rep.id, username: rep.username, role: Role.SALESPERSON }, order };
}

const linkEvent = (linkId: string, amount: string, id = uid()) => ({ id, type: "PAYMENT_LINK_EVENT", payload: { type: "PAYMENT_LINK_EVENT", data: { link_id: linkId, link_status: "PAID", link_amount_paid: amount, order: { order_id: `CFPay_${id}` } } } });

async function deliver(runner: TxRunner, ev: ReturnType<typeof linkEvent>, shopify: () => ShopifyClient, cf: ReturnType<typeof fakeCashfree>) {
  const { store } = memoryStore();
  const stored = await store.record({ eventType: ev.type, externalEventId: ev.id, payload: ev.payload, ignored: false });
  return processCashfreeEvent(stored.id, { store, runner, getShopifyClient: shopify, verifyLink: (id) => cf.api.getLink(id) });
}

async function final(tx: Db, orderId: string) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { subtotal: true, discountAmount: true, totalAmount: true, metadata: true, payments: { select: { status: true, amount: true } } } });
  const sync = ((o.metadata ?? {}) as Record<string, unknown>).shopifyPaymentSync as { status?: string } | undefined;
  return { subtotal: o.subtotal.toString(), discount: o.discountAmount.toString(), total: o.totalAmount.toString(), payments: o.payments.map((p) => `${p.status}:${p.amount}`), shopifySync: sync?.status };
}

describe("WhatsApp Inbox order: 1199 - 1198 = 1, paid 1", () => {
  it("the payable amount that reaches Cashfree is 1.00", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order } = await seed(tx);
      const cf = fakeCashfree();
      const svc = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => cf.api });
      await svc.createPaymentLink(user, order.id);
      assert.deepEqual(cf.calls.create, [1]);
    });
  });

  it("webhook, Refresh and scheduled catch-up end in the same state, each with exactly ONE Shopify edit + payment, and no extra payment/refund", async () => {
    const results: Record<string, unknown> = {};
    for (const path of ["webhook", "refresh", "scheduled"] as const) {
      await inRollback(async (tx, runner) => {
        const { user, order } = await seed(tx);
        const cf = fakeCashfree();
        const shop = fakeShopify();
        const svc = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => cf.api, getShopifyClient: shop.client });
        const link = await svc.createPaymentLink(user, order.id);
        cf.pay(link.linkId, "1.00"); // the customer pays; the webhook is NOT delivered unless this is the webhook path
        if (path === "webhook") assert.equal(await deliver(runner, linkEvent(link.linkId, "1.00"), shop.client, cf), "processed");
        if (path === "refresh") await svc.refreshPaymentLink(user, link.paymentId);
        if (path === "scheduled") {
          const pass = await createCashfreeReconciler({ runner, reconcile: (id) => svc.reconcileOpenPayment(id) }).tick();
          assert.ok(pass && pass.updated >= 1 && pass.errors === 0);
        }
        // a duplicate of every trigger afterwards is a no-op
        if (path === "webhook") await deliver(runner, linkEvent(link.linkId, "1.00"), shop.client, cf);
        await svc.refreshPaymentLink(user, link.paymentId);
        await svc.reconcileOpenPayment(link.paymentId);

        assert.deepEqual(shop.state.writes, { edit: 1, payment: 1, markPaid: 0 }, path);
        assert.equal(shop.state.received, 100, path);
        assert.equal(shop.state.total, 100, path);
        assert.equal(shop.state.discounts.length, 1, path);
        assert.equal(cf.calls.create.length, 1, "no second payment link");
        assert.equal(cf.calls.cancel, 0);
        const f = await final(tx, order.id);
        assert.deepEqual(f.payments, ["SUCCESS:1"], path);
        assert.equal(await tx.refundRequest.count({ where: { orderId: order.id } }), 0);
        results[path] = f;
      });
    }
    assert.deepEqual(results.refresh, results.webhook);
    assert.deepEqual(results.scheduled, results.webhook);
    assert.deepEqual(results.webhook, { subtotal: "1199", discount: "1198", total: "1", payments: ["SUCCESS:1"], shopifySync: "synced" });
  });

  it("pending stays untouched; expired follows the existing rules; a wrong paid amount is not applied as paid", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order } = await seed(tx);
      const cf = fakeCashfree();
      const shop = fakeShopify();
      const svc = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => cf.api, getShopifyClient: shop.client });
      const link = await svc.createPaymentLink(user, order.id);
      assert.equal(await svc.reconcileOpenPayment(link.paymentId), "unchanged");
      assert.deepEqual((await final(tx, order.id)).payments, ["PENDING:1"]);
      cf.pay(link.linkId, "0.50");
      await svc.reconcileOpenPayment(link.paymentId);
      assert.deepEqual((await final(tx, order.id)).payments, ["PENDING:1"]);
      cf.setStatus(link.linkId, "EXPIRED");
      assert.equal(await svc.reconcileOpenPayment(link.paymentId), "updated");
      assert.deepEqual((await final(tx, order.id)).payments, ["FAILED:1"]);
      assert.deepEqual(shop.state.writes, { edit: 0, payment: 0, markPaid: 0 });
    });
  });

  it("a webhook for a link Cashfree does not report as paid is not applied", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order } = await seed(tx);
      const cf = fakeCashfree();
      const shop = fakeShopify();
      const svc = new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => cf.api, getShopifyClient: shop.client });
      const link = await svc.createPaymentLink(user, order.id);
      assert.equal(await deliver(runner, linkEvent(link.linkId, "1.00"), shop.client, cf), "ignored");
      assert.deepEqual((await final(tx, order.id)).payments, ["PENDING:1"]);
      assert.deepEqual(shop.state.writes, { edit: 0, payment: 0, markPaid: 0 });
    });
  });
});

describe("test-data safety", () => {
  it("fixtures are fake and never reference the real order #AWL101814 or its Cashfree/Shopify ids", () => {
    const REAL = ["AWL101814", "CRM-MUY23GTX-TR3W", "18929899962557", "crm_bcd24ab74dd74b82989d82a77582ecf1", "7116710363", "6683909097"];
    const text = [seed.toString(), fakeShopify.toString(), fakeCashfree.toString()].join(" ");
    for (const id of REAL) assert.ok(!text.includes(id), id);
  });
});
