// Prepaid Upgrade for a Shopify order the CRM has NOT synced (e.g. "#ZZT900001", COD, 699). Shopify is faked at the HTTP layer
// and Cashfree at its API; everything else is the real code. Every test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, Role } from "../../../generated/prisma/enums.js";
import { type Db, type TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import { applyPaymentUpdate } from "../cashfree/cashfree.apply.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { mapOrder } from "../shopify/shopify.mapper.js";
import { normalizeOrder, orderNodeSchema } from "../shopify/shopify.orders.js";
import { upsertOrder } from "../shopify/shopify.persist.js";
import { syncShopifyPayment } from "../cashfree/cashfree.payment-success.js";
import { FakeShopifyOrder } from "../shopify/shopify.fake-order-editor.js";
import { derivePaymentMode } from "./orders.filters.js";
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
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });
const NOW = new Date("2026-10-05T12:00:00.000Z");
const EXT = "5551234567";
const CF_CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "CFID_TEST", CASHFREE_CLIENT_SECRET: "cfsk_ma_test_SECRET0123456789", PUBLIC_BACKEND_URL: "https://crm.example.com" });
const SHOPIFY_ENV = { SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_faketoken", SHOPIFY_API_VERSION: "2026-01" };

interface Node { gateway?: string[]; financial?: string; cancelledAt?: string | null; phone?: string | null; total?: string }
const orderNode = (n: Node = {}) => ({
  id: `gid://shopify/Order/${EXT}`, name: "#ZZT900001",
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), processedAt: null, cancelledAt: n.cancelledAt ?? null, cancelReason: null, currencyCode: "INR",
  displayFinancialStatus: n.financial ?? "PENDING", displayFulfillmentStatus: "UNFULFILLED", returnStatus: null, taxesIncluded: true, tags: [],
  paymentGatewayNames: n.gateway ?? ["Cash on Delivery (COD)"], discountCodes: [], email: "shopper@example.invalid", phone: null,
  customer: { id: "gid://shopify/Customer/777", firstName: "Sandeep", lastName: "Saxena", email: "shopper@example.invalid", phone: n.phone === undefined ? "+919690007733" : n.phone },
  shippingAddress: { name: "Sandeep Saxena", address1: "F 33 Govind Nagar", city: "Mathura", province: "Uttar Pradesh", zip: "281003", country: "India", phone: n.phone === undefined ? "+919690007733" : n.phone },
  billingAddress: null, shippingLine: null,
  subtotalPriceSet: { shopMoney: { amount: n.total ?? "699.00", currencyCode: "INR" } }, totalDiscountsSet: null, totalTaxSet: null, totalShippingPriceSet: null,
  totalPriceSet: { shopMoney: { amount: n.total ?? "699.00", currencyCode: "INR" } }, totalRefundedSet: null,
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [] }, transactions: [], fulfillments: [],
});
const shopifyClient = (n: Node = {}, calls: { query: string }[] = []) =>
  new ShopifyClient(loadShopifyConfig(SHOPIFY_ENV), {
    fetchImpl: (async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ query: String(body.query).slice(0, 40) });
      return new Response(JSON.stringify({ data: { order: orderNode(n) } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });

async function setup(tx: Db, runner: TxRunner, node: Node = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
  const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
  const created: { link_amount: number }[] = [];
  const link = (id: string, status = "ACTIVE"): CashfreeLink => ({ cfLinkId: "1", linkId: id, linkStatus: status, linkUrl: `https://pay.test/${id}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null });
  const api: CashfreeApi = { createLink: async (r) => { created.push({ link_amount: r.link_amount }); return link(r.link_id); }, getLink: async (id) => link(id), cancelLink: async (id) => link(id, "CANCELLED") };
  const cashfree = new CashfreePaymentsService(runner, { config: () => CF_CONFIG, client: () => api, now: () => NOW });
  const shopifyCalls: { query: string }[] = [];
  const svc = new PrepaidUpgradeService(tx as never, () => cashfree, () => NOW, () => shopifyClient(node, shopifyCalls));
  const pay = (paymentId: string, amount: string) => applyPaymentUpdate(tx, paymentId, { status: "SUCCESS", paidAmount: amount, cfPaymentId: "cf_1" }, { source: ActivitySource.CASHFREE_WEBHOOK, now: NOW });
  const fail = (paymentId: string, reason: string) => applyPaymentUpdate(tx, paymentId, { status: "FAILED", failureReason: reason }, { source: ActivitySource.CASHFREE_WEBHOOK, now: NOW });
  const crmOrders = () => tx.order.findMany({ where: { externalSource: "SHOPIFY", externalId: { in: [EXT, `gid://shopify/Order/${EXT}`] } }, select: { id: true, orderNumber: true, externalNumber: true, source: true, totalAmount: true, discountAmount: true, metadata: true, payments: { select: { method: true, status: true, externalSource: true, amount: true, metadata: true } } } });
  return { admin: as(admin, Role.ADMIN), rep: as(rep, Role.SALESPERSON), svc, created, pay, fail, crmOrders, shopifyCalls, tx };
}

describe("eligibility of a Shopify order the CRM has not synced (decided from the order itself)", () => {
  it("Shopify COD 699, unsynced: eligible, shows the real amount, and merely looking creates nothing in the CRM", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const v = await t.svc.getLiveUpgrade(t.admin, EXT);
      assert.deepEqual([v.eligible, v.isCod, v.reason, v.orderId, v.offer], [true, true, null, null, null]);
      assert.equal(Number(v.orderAmount), 699);
      assert.equal((await t.crmOrders()).length, 0, "GET never syncs anything");
    });
  });
  it("non-COD (prepaid gateway), cancelled, refunded, already paid, no phone: each is NOT eligible, with a reason", async () => {
    await inRollback(async (tx, runner) => {
      const cases: [Node, RegExp, boolean][] = [
        [{ gateway: ["Razorpay"] }, /Only Cash on Delivery/, false],
        [{ cancelledAt: NOW.toISOString() }, /cancelled/, true],
        [{ financial: "REFUNDED" }, /refunded/, true],
        [{ financial: "PAID" }, /successful payment/, true],
        [{ phone: null }, /10-digit mobile/, true],
      ];
      for (const [node, re, cod] of cases) {
        const t = await setup(tx, runner, node);
        const v = await t.svc.getLiveUpgrade(t.admin, EXT);
        assert.equal(v.eligible, false, `${JSON.stringify(node)} -> reason ${v.reason}`);
        assert.match(v.reason!, re);
        assert.equal(v.isCod, cod, `isCod for ${JSON.stringify(node)}`);
      }
    });
  });
  it("a salesperson cannot see or create offers on an order that is not in the CRM (no lead scope exists for it)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      await assert.rejects(() => t.svc.getLiveUpgrade(t.rep, EXT), (e: any) => e.statusCode === 404);
      await assert.rejects(() => t.svc.createLiveOffer(t.rep, EXT, { discountType: "FIXED", discountValue: "100" }), (e: any) => e.statusCode === 404);
      assert.equal((await t.crmOrders()).length, 0);
    });
  });
});

describe("Shopify-only COD 699 -> Prepaid Upgrade -> Cashfree -> verified payment", () => {
  it("first offer brings in exactly this one order (number/source/Shopify id preserved); amounts are server-computed; still COD", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const r = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
      assert.deepEqual([r.offer!.status, r.offer!.originalAmount, r.offer!.discountAmount, r.offer!.prepaidAmount], ["OFFERED", "699", "100.00", "599.00"]);
      assert.equal(r.offer!.shopifyOrderNumber, "#ZZT900001");
      assert.ok(r.offer!.shopifyOrderId && r.offer!.shopifyOrderId.endsWith(EXT));
      const orders = await t.crmOrders();
      assert.equal(orders.length, 1, "no second order");
      assert.deepEqual([orders[0]!.orderNumber, orders[0]!.externalNumber, orders[0]!.source], ["SHP-ZZT900001", "#ZZT900001", "SHOPIFY"]);
      assert.equal(Number(orders[0]!.totalAmount), 699, "original total untouched by an offer");
      assert.equal(derivePaymentMode(orders[0]!.payments as never), "COD");
      // a second offer reuses the already-imported order instead of importing again
      const calls = t.shopifyCalls.length;
      await t.svc.createLiveOffer(t.admin, EXT, { discountType: "PERCENT", discountValue: "10" });
      assert.equal(t.shopifyCalls.length, calls, "no further Shopify fetch once the order exists in the CRM");
      assert.equal((await t.crmOrders()).length, 1);
    });
  });
  it("an invalid discount is rejected BEFORE anything is created in the CRM", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      await assert.rejects(() => t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "699" }), (e: any) => e.statusCode === 400);
      assert.equal((await t.crmOrders()).length, 0);
    });
  });
  it("link is for the discounted 599; payment link does NOT convert; the payment carries the offer id", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
      const [crm] = await t.crmOrders();
      const r = await t.svc.generateLink(t.admin, crm!.id, o.offer!.id);
      assert.equal(t.created.at(-1)!.link_amount, 599);
      assert.equal(r.offer!.status, "PAYMENT_PENDING");
      const after = (await t.crmOrders())[0]!;
      assert.equal(derivePaymentMode(after.payments as never), "COD");
      assert.equal(Number(after.totalAmount), 699);
      const cf = after.payments.find((p) => p.externalSource === "CASHFREE")!;
      assert.equal((cf.metadata as any).prepaidUpgradeId, o.offer!.id);
      // the live GET now resolves to the CRM order and shows the pending offer
      const live = await t.svc.getLiveUpgrade(t.admin, EXT);
      assert.deepEqual([live.orderId, live.offer!.status], [crm!.id, "PAYMENT_PENDING"]);
    });
  });
  it("verified success converts to PREPAID (total 599, prepaid discount separate from the original 0), is idempotent, and keeps the Shopify reference", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
      const [crm] = await t.crmOrders();
      const r = await t.svc.generateLink(t.admin, crm!.id, o.offer!.id);
      await t.pay(r.paymentId!, "599.00");
      await t.pay(r.paymentId!, "599.00"); // duplicate webhook
      const done = (await t.crmOrders())[0]!;
      assert.equal(derivePaymentMode(done.payments as never), "PREPAID");
      assert.equal(Number(done.totalAmount), 599);
      assert.equal(Number(done.discountAmount), 100);
      const offer = (done.metadata as any).prepaidUpgrade;
      assert.deepEqual([offer.status, offer.originalAmount, offer.originalDiscountAmount, offer.shopifyOrderNumber, done.orderNumber], ["UPGRADED", "699", "0", "#ZZT900001", "SHP-ZZT900001"]);
      assert.equal(await tx.activity.count({ where: { orderId: crm!.id, title: "Prepaid upgrade completed: COD -> Prepaid" } }), 1, "converted exactly once");
    });
  });
  it("a Shopify re-sync after the upgrade does NOT undo it (total, prepaid mode, offer record and payments all survive)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
      const [crm] = await t.crmOrders();
      const r = await t.svc.generateLink(t.admin, crm!.id, o.offer!.id);
      await t.pay(r.paymentId!, "599.00");
      // Shopify (now marked paid for the original 699 by the existing payment sync) is re-imported by a later webhook/backfill:
      const mapped = mapOrder(normalizeOrder(orderNodeSchema.parse({ ...orderNode({ financial: "PAID" }), updatedAt: new Date(NOW.getTime() + 60_000).toISOString() })));
      await upsertOrder(tx as never, mapped, { force: true });
      const after = (await t.crmOrders())[0]!;
      assert.equal(Number(after.totalAmount), 599, "not reverted to Shopify's 699");
      assert.equal(derivePaymentMode(after.payments as never), "PREPAID");
      assert.equal((after.metadata as any).prepaidUpgrade.status, "UPGRADED");
      assert.equal(after.payments.filter((p) => p.status === "SUCCESS").length, 1, "Shopify's 699 mark-as-paid is not mirrored on top of the 599 (no double counting)");
    });
  });
  for (const reason of ["Payment link expired", "Payment link cancelled", "Customer abandoned the payment"]) {
    it(`link ends as "${reason}": the order stays COD at the original total and the offer reopens`, async () => {
      await inRollback(async (tx, runner) => {
        const t = await setup(tx, runner);
        const o = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
        const [crm] = await t.crmOrders();
        const r = await t.svc.generateLink(t.admin, crm!.id, o.offer!.id);
        await t.fail(r.paymentId!, reason);
        const after = (await t.crmOrders())[0]!;
        assert.equal(derivePaymentMode(after.payments as never), "COD");
        assert.equal(Number(after.totalAmount), 699);
        assert.equal((after.metadata as any).prepaidUpgrade.status, "OFFERED");
      });
    });
  }
  it("a success for a payment that does not carry THIS offer's id is ignored (no conversion)", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
      const [crm] = await t.crmOrders();
      const r = await t.svc.generateLink(t.admin, crm!.id, o.offer!.id);
      await tx.payment.update({ where: { id: r.paymentId! }, data: { metadata: { prepaidUpgradeId: uid() } } });
      await t.pay(r.paymentId!, "599.00");
      const after = (await t.crmOrders())[0]!;
      assert.equal(Number(after.totalAmount), 699);
      assert.equal((after.metadata as any).prepaidUpgrade.status, "PAYMENT_PENDING");
    });
  });
});

describe("Shopify reconciliation after a verified prepaid-upgrade payment (699 original, 100 discount, 599 collected)", () => {
  async function upgraded(tx: Db, runner: TxRunner) {
    const t = await setup(tx, runner);
    const o = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
    const [crm] = await t.crmOrders();
    const r = await t.svc.generateLink(t.admin, crm!.id, o.offer!.id);
    await t.pay(r.paymentId!, "599.00");
    const shopify = new FakeShopifyOrder();
    const sync = () => syncShopifyPayment(tx, crm!.id, { source: ActivitySource.CASHFREE_WEBHOOK, now: NOW, getShopifyClient: () => shopify.client });
    return { t, crmId: crm!.id, shopify, sync, offerId: o.offer!.id };
  }

  it("Shopify ends at a net 599 (order edited by 100, payment of exactly 599) - never 699 collected - and the CRM keeps 699 / 100 / 599 for audit", async () => {
    await inRollback(async (tx, runner) => {
      const { t, crmId, shopify, sync } = await upgraded(tx, runner);
      const r = await sync();
      assert.equal(r.status, "synced");
      assert.deepEqual([shopify.total, shopify.received, shopify.outstanding, shopify.status], [59900, 59900, 0, "PAID"]);
      assert.equal(shopify.markAsPaidCalls, 0);
      assert.deepEqual(shopify.paymentsRecorded.map((p) => p.amount), [59900]);
      assert.equal(shopify.ordersCreated, 0);
      const crm = (await t.crmOrders())[0]!;
      const offer = (crm.metadata as any).prepaidUpgrade;
      assert.deepEqual([offer.originalAmount, offer.discountAmount, offer.prepaidAmount, offer.status], ["699", "100.00", "599.00", "UPGRADED"]);
      const sync2 = (crm.metadata as any).shopifyPaymentSync;
      assert.deepEqual([sync2.status, sync2.mode, sync2.originalAmount, sync2.discountAmount, sync2.collectedAmount, sync2.performed], ["synced", "PREPAID_UPGRADE", "699", "100.00", "599.00", "edit_and_payment"]);
      assert.equal(crm.orderNumber, "SHP-ZZT900001");
      assert.equal(crm.externalNumber, "#ZZT900001", "the original Shopify order number is unchanged");
      assert.equal((await t.svc.getUpgrade(t.admin, crmId)).shopifyReconciliation, "COMPLETED");
    });
  });
  it("a duplicate Cashfree success / duplicate sync does not touch Shopify again (one discount, one payment)", async () => {
    await inRollback(async (tx, runner) => {
      const { t, crmId, shopify, sync } = await upgraded(tx, runner);
      await sync();
      const [crm] = await t.crmOrders();
      const paymentId = crm!.payments.find((p) => p.externalSource === "CASHFREE")!;
      void paymentId;
      await sync(); // duplicate webhook -> same sync again
      assert.deepEqual([shopify.committedDiscounts.length, shopify.paymentsRecorded.length, shopify.received], [1, 1, 59900]);
      assert.equal((await t.svc.getUpgrade(t.admin, crmId)).shopifyReconciliation, "COMPLETED");
    });
  });
  it("Shopify failure does NOT roll back the legitimate payment: CRM stays PREPAID/paid 599, reconciliation FAILED, and a retry completes it without duplicating anything", async () => {
    await inRollback(async (tx, runner) => {
      const { t, crmId, shopify, sync } = await upgraded(tx, runner);
      shopify.failNext = "edit_commit";
      const failed = await sync();
      assert.equal(failed.status, "failed");
      const crm = (await t.crmOrders())[0]!;
      assert.equal(derivePaymentMode(crm.payments as never), "PREPAID");
      assert.equal(Number(crm.totalAmount), 599);
      assert.equal(crm.payments.find((p) => p.externalSource === "CASHFREE")!.status, "SUCCESS");
      assert.equal((crm.metadata as any).prepaidUpgrade.status, "UPGRADED");
      assert.equal((crm.metadata as any).shopifyPaymentSync.status, "failed");
      assert.deepEqual([shopify.total, shopify.received], [69900, 0], "Shopify untouched, no false payment");
      const view = await t.svc.getUpgrade(t.admin, crmId);
      assert.equal(view.shopifyReconciliation, "FAILED");
      assert.ok(!JSON.stringify(view).includes("Simulated Shopify failure"), "no technical error text in the telecaller-facing view");

      const retry = await sync();
      assert.equal(retry.status, "synced");
      assert.deepEqual([shopify.total, shopify.received, shopify.committedDiscounts.length, shopify.paymentsRecorded.length], [59900, 59900, 1, 1]);
      assert.equal((await t.svc.getUpgrade(t.admin, crmId)).shopifyReconciliation, "COMPLETED");
    });
  });
  it("failure at the payment step is also retry-safe (discount not applied twice)", async () => {
    await inRollback(async (tx, runner) => {
      const { shopify, sync } = await upgraded(tx, runner);
      shopify.failNext = "payment";
      assert.equal((await sync()).status, "failed");
      assert.equal((await sync()).status, "synced");
      assert.deepEqual([shopify.committedDiscounts.length, shopify.paymentsRecorded.length, shopify.received], [1, 1, 59900]);
    });
  });
  it("an upgrade whose link is still pending, or whose payment could not be converted, never marks Shopify paid for 699", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      const o = await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" });
      const [crm] = await t.crmOrders();
      const r = await t.svc.generateLink(t.admin, crm!.id, o.offer!.id);
      await tx.payment.update({ where: { id: r.paymentId! }, data: { metadata: { prepaidUpgradeId: uid() } } }); // wrong offer id: not converted
      await t.pay(r.paymentId!, "599.00");
      const shopify = new FakeShopifyOrder();
      const res = await syncShopifyPayment(tx, crm!.id, { source: ActivitySource.CASHFREE_WEBHOOK, now: NOW, getShopifyClient: () => shopify.client });
      assert.equal(res.status, "failed");
      assert.deepEqual([shopify.markAsPaidCalls, shopify.paymentsRecorded.length, shopify.calls.length], [0, 0, 0], "Shopify is not called at all");
    });
  });
  it("a normal (non-upgrade) Shopify order still uses the original mark-as-paid", async () => {
    await inRollback(async (tx, runner) => {
      const t = await setup(tx, runner);
      await t.svc.createLiveOffer(t.admin, EXT, { discountType: "FIXED", discountValue: "100" }); // brings the order into the CRM
      const [crm] = await t.crmOrders();
      // discard the offer: this order is now an ordinary one
      await tx.order.update({ where: { id: crm!.id }, data: { metadata: { ...(crm!.metadata as object), prepaidUpgrade: null } } });
      const shopify = new FakeShopifyOrder();
      const res = await syncShopifyPayment(tx, crm!.id, { source: ActivitySource.CASHFREE_WEBHOOK, now: NOW, getShopifyClient: () => shopify.client });
      assert.equal(res.status, "synced");
      assert.equal(shopify.markAsPaidCalls, 1);
    });
  });
  it("a later Shopify re-sync (Shopify now shows 599 paid) does not undo the upgrade", async () => {
    await inRollback(async (tx, runner) => {
      const { t, sync } = await upgraded(tx, runner);
      await sync();
      const mapped = mapOrder(normalizeOrder(orderNodeSchema.parse({ ...orderNode({ financial: "PAID", total: "599.00" }), updatedAt: new Date(NOW.getTime() + 120_000).toISOString() })));
      await upsertOrder(tx as never, mapped, { force: true });
      const after = (await t.crmOrders())[0]!;
      assert.equal(Number(after.totalAmount), 599);
      assert.equal(derivePaymentMode(after.payments as never), "PREPAID");
      assert.equal((after.metadata as any).prepaidUpgrade.status, "UPGRADED");
      assert.equal((after.metadata as any).shopifyPaymentSync.status, "synced");
      assert.equal(after.payments.filter((p) => p.status === "SUCCESS").length, 1);
    });
  });
});
