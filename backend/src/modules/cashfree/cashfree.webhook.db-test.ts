// Database tests for the Cashfree webhook: payment-link success (matching, verification, discounted order, idempotency) and refund status. Run with: npm run test:db
// Every test runs in ONE rolled-back transaction. Cashfree and Shopify are fakes; nothing real is called, no real order is referenced.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, RefundExecutionStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { ENV as SHOPIFY_ENV } from "../shopify/shopify.fixtures.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import type { CashfreeLink, CashfreeRefund } from "./cashfree.client.js";
import { computeSignature } from "./cashfree.hmac.js";
import { handleCashfreeWebhook } from "./cashfree.webhook.handler.js";
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
const SHOPIFY_CONFIG = loadShopifyConfig(SHOPIFY_ENV);
const SECRET = "test-client-secret-not-real";
const LINK_CODE = "testlinkcode_TESTCODE0001";
const CF_ORDER = `CFPay_${LINK_CODE}_b3ea_1791374485548`;

/** A stateful fake of the Shopify order (list price 1199, unpaid); counts its writes. */
function fakeShopify() {
  const s = { total: 119900, received: 0, staged: 0, writes: { edit: 0, payment: 0, markPaid: 0 } };
  const money = (c: number) => ({ shopMoney: { amount: (c / 100).toFixed(1) } });
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    let data: unknown;
    if (query.includes("crmPrepaidUpgradeOrderState")) data = { order: { id: String(variables.id), displayFinancialStatus: s.received > 0 && s.received >= s.total ? "PAID" : "PENDING", cancelledAt: null, currentTotalPriceSet: money(s.total), totalOutstandingSet: money(s.total - s.received), totalReceivedSet: money(s.received) } };
    else if (query.includes("crmPrepaidUpgradeEditBegin")) data = { orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/1", lineItems: { nodes: [{ id: "li1", quantity: 1, originalUnitPriceSet: money(119900) }] } }, userErrors: [] } };
    else if (query.includes("crmPrepaidUpgradeEditDiscount")) { s.staged = s.total - Math.round(Number((variables.discount as { fixedValue: { amount: string } }).fixedValue.amount) * 100); data = { orderEditAddLineItemDiscount: { calculatedOrder: { totalPriceSet: money(s.staged), totalOutstandingSet: money(s.staged) }, userErrors: [] } }; }
    else if (query.includes("crmPrepaidUpgradeEditCommit")) { s.writes.edit++; s.total = s.staged; data = { orderEditCommit: { order: { id: "x" }, userErrors: [] } }; }
    else if (query.includes("crmPrepaidUpgradeManualPayment")) { s.writes.payment++; s.received = s.total; data = { orderCreateManualPayment: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }; }
    else if (query.includes("crmOrderMarkAsPaid")) { s.writes.markPaid++; data = { orderMarkAsPaid: { order: { id: "x", displayFinancialStatus: "PAID" }, userErrors: [] } }; }
    else throw new Error(`unexpected Shopify call: ${query.slice(0, 60)}`);
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { state: s, client: () => new ShopifyClient(SHOPIFY_CONFIG, { fetchImpl }) };
}

async function seedBase(tx: Db) {
  const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON }, select: { id: true } });
  const source = await tx.source.create({ data: { name: "Web", code: `w-${uid()}` }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Fake", lastName: "Customer", mobile: "9876500000", normalizedMobile: "+919876500000", sourceId: source.id, ownerId: rep.id }, select: { id: true } });
  return { rep, lead };
}

/** A WhatsApp-Inbox style order: list 1199, CRM discount 1198, payable 1, with its open Cashfree payment-link payment (the link URL carries the link code). */
async function seedLinkOrder(tx: Db) {
  const { lead } = await seedBase(tx);
  const order = await tx.order.create({
    data: { orderNumber: `FAKE-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.PENDING_PAYMENT, currency: "INR", subtotal: "1199.00", discountAmount: "1198.00", totalAmount: "1.00", externalSource: "SHOPIFY", externalId: `9${Date.now()}${Math.floor(Math.random() * 1000)}`, metadata: { createdVia: "WHATSAPP_INBOX", discount: { originalSubtotal: "1199.00", discountAmount: "1198.00" } } },
    select: { id: true },
  });
  const linkId = `crm_${uid().replace(/-/g, "")}`;
  const payment = await tx.payment.create({
    data: { orderId: order.id, amount: "1.00", method: PaymentMethod.PAYMENT_LINK, status: PaymentStatus.PENDING, provider: "Cashfree", externalSource: "CASHFREE", externalId: linkId, providerOrderId: linkId, paymentUrl: `https://payments.cashfree.com/links/${LINK_CODE}` },
    select: { id: true },
  });
  return { orderId: order.id, paymentId: payment.id, linkId };
}

const successBody = (orderId: string, amount: number | string, deliveryId = uid()) => ({ id: deliveryId, type: "PAYMENT_SUCCESS_WEBHOOK", payload: { type: "PAYMENT_SUCCESS_WEBHOOK", event_time: "2026-10-07T12:01:50+05:30", data: { order: { order_id: orderId, order_amount: amount }, payment: { cf_payment_id: 111222, payment_status: "SUCCESS", payment_amount: amount, payment_time: "2026-10-07T17:31:50+05:30", bank_reference: "REF1", payment_group: "upi" } } } });
const refundBody = (refundId: string, orderId: string, status: string, amount: number | string, deliveryId = uid()) => ({ id: deliveryId, type: "REFUND_STATUS_WEBHOOK", payload: { type: "REFUND_STATUS_WEBHOOK", event_time: "2026-10-07T18:00:00+05:30", data: { refund: { cf_refund_id: 777, refund_id: refundId, order_id: orderId, refund_amount: amount, refund_status: status } } } });

type Body = { id: string; type: string; payload: unknown };
async function deliver(runner: TxRunner, ev: Body, deps: Partial<Parameters<typeof processCashfreeEvent>[1]> = {}) {
  const { store } = memoryStore();
  const stored = await store.record({ eventType: ev.type, externalEventId: ev.id, payload: ev.payload, ignored: false });
  return processCashfreeEvent(stored.id, { store, runner, ...deps });
}

const link = (status: string, paid: string): CashfreeLink => ({ cfLinkId: "1", linkId: "x", linkStatus: status, linkUrl: "https://pay.test/x", linkAmount: "1", linkAmountPaid: paid, linkExpiryTime: null }) as CashfreeLink;
const acts = (tx: Db, orderId: string, type: string) => tx.activity.count({ where: { orderId, type: type as never } });

describe("payment-link success webhook", () => {
  it("reconciles a discounted CRM order (1199 - 1198 = 1) once: payment SUCCESS, one Shopify edit + payment, CRM total stays 1, duplicate is harmless", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seedLinkOrder(tx);
      const shop = fakeShopify();
      const deps = { getShopifyClient: shop.client, verifyLink: async () => link("PAID", "1.00") };
      assert.equal(await deliver(runner, successBody(CF_ORDER, "1.00"), deps), "processed");
      const duplicate = await deliver(runner, successBody(CF_ORDER, "1.00"), deps); // a different delivery of the same payment
      assert.ok(["processed", "ignored"].includes(duplicate));

      const payment = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true, amount: true, providerPaymentId: true } });
      assert.deepEqual([payment.status, payment.amount.toString(), payment.providerPaymentId], [PaymentStatus.SUCCESS, "1", "111222"]);
      assert.equal(await tx.payment.count({ where: { orderId: w.orderId } }), 1);
      assert.deepEqual(shop.state.writes, { edit: 1, payment: 1, markPaid: 0 });
      assert.equal(shop.state.total, 100);
      assert.equal(shop.state.received, 100);
      const order = await tx.order.findUniqueOrThrow({ where: { id: w.orderId }, select: { subtotal: true, discountAmount: true, totalAmount: true } });
      assert.deepEqual([order.subtotal.toString(), order.discountAmount.toString(), order.totalAmount.toString()], ["1199", "1198", "1"]);
      assert.equal(await acts(tx, w.orderId, "PAYMENT_STATUS_CHANGED"), 2); // "Payment success" + "Shopify payment synced", each exactly once
    });
  });

  it("a wrong amount in the delivery, a link Cashfree does not report as PAID, or a different paid amount at Cashfree: nothing is reconciled", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seedLinkOrder(tx);
      const shop = fakeShopify();
      const check = async () => {
        const p = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true } });
        assert.equal(p.status, PaymentStatus.PENDING);
        assert.deepEqual(shop.state.writes, { edit: 0, payment: 0, markPaid: 0 });
      };
      assert.equal(await deliver(runner, successBody(CF_ORDER, "2.00"), { getShopifyClient: shop.client, verifyLink: async () => link("PAID", "1.00") }), "ignored");
      await check();
      assert.equal(await deliver(runner, successBody(CF_ORDER, "1.00"), { getShopifyClient: shop.client, verifyLink: async () => link("ACTIVE", "0") }), "ignored");
      await check();
      assert.equal(await deliver(runner, successBody(CF_ORDER, "1.00"), { getShopifyClient: shop.client, verifyLink: async () => link("PAID", "0.50") }), "ignored");
      await check();
    });
  });

  it("a delivery that matches no CRM payment is stored and leaves everything unchanged", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seedLinkOrder(tx);
      assert.equal(await deliver(runner, successBody("CFPay_someoneelse_other_ab12_1791374485548", "1.00"), { verifyLink: async () => link("PAID", "1.00") }), "ignored");
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true } })).status, PaymentStatus.PENDING);
    });
  });
});

describe("webhook endpoint contract", () => {
  const raw = (o: unknown) => Buffer.from(JSON.stringify(o));
  const signed = (body: Buffer, ts = String(Date.now())) => ({ "x-webhook-timestamp": ts, "x-webhook-signature": computeSignature(ts, body, SECRET) });

  it("invalid signature -> 401 and nothing is stored; unknown event -> stored and 200; a repeated delivery is acknowledged without a second record", async () => {
    const m = memoryStore();
    const scheduled: string[] = [];
    const deps = { config: { secret: SECRET }, store: m.store, schedule: (id: string) => void scheduled.push(id) };
    const body = raw({ type: "PAYMENT_SUCCESS_WEBHOOK", data: {} });
    assert.equal((await handleCashfreeWebhook({ rawBody: body, headers: { "x-webhook-timestamp": "1", "x-webhook-signature": "bad" } }, deps)).status, 401);
    assert.equal(m.rows.length, 0);

    const unknown = raw({ type: "SOMETHING_NEW_WEBHOOK", data: {} });
    assert.equal((await handleCashfreeWebhook({ rawBody: unknown, headers: signed(unknown) }, deps)).status, 200);
    assert.equal(m.rows.length, 1);
    assert.equal(scheduled.length, 0); // not a handled type: recorded, acknowledged, not processed

    const refund = raw({ type: "REFUND_STATUS_WEBHOOK", data: { refund: { refund_id: "rfx", refund_status: "SUCCESS" } } });
    const headers = { ...signed(refund), "x-idempotency-key": "same-delivery" };
    assert.equal((await handleCashfreeWebhook({ rawBody: refund, headers }, deps)).status, 200);
    assert.equal((await handleCashfreeWebhook({ rawBody: refund, headers }, deps)).message, "Duplicate delivery ignored");
    assert.equal(scheduled.length, 1); // REFUND_STATUS_WEBHOOK is now a handled type, scheduled once
  });
});

async function seedRefund(tx: Db, over: { executionStatus?: RefundExecutionStatus | null; status?: RefundRequestStatus; amount?: string } = {}) {
  const { rep, lead } = await seedBase(tx);
  const order = await tx.order.create({ data: { orderNumber: `FAKE-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.CANCELLED, currency: "INR", totalAmount: "100.00" }, select: { id: true } });
  const payment = await tx.payment.create({ data: { orderId: order.id, amount: "100.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS, provider: "Cashfree", externalSource: "CASHFREE", externalId: `crm_${uid()}`, providerPaymentId: "555", metadata: { cashfree: { cashfreeOrderId: "FAKE_CF_ORDER_1", cfPaymentId: "555" } } }, select: { id: true } });
  const refundId = `rf${uid().replace(/-/g, "")}`;
  const request = await tx.refundRequest.create({
    data: { orderId: order.id, paymentId: payment.id, requestedById: rep.id, requestedByRole: Role.SALESPERSON, amount: over.amount ?? "100.00", currency: "INR", reason: "TEST", status: over.status ?? RefundRequestStatus.APPROVED, refundId, executionStatus: over.executionStatus === undefined ? RefundExecutionStatus.PROCESSING : over.executionStatus },
    select: { id: true },
  });
  return { orderId: order.id, paymentId: payment.id, requestId: request.id, refundId };
}

const cfRefund = (refundId: string, status: string, amount: string | null): CashfreeRefund => ({ cfRefundId: "777", refundId, orderId: "FAKE_CF_ORDER_1", refundStatus: status, refundAmount: amount, refundCurrency: "INR", statusDescription: null, refundArn: null, processedAt: null });

describe("refund status webhook", () => {
  it("SUCCESS (verified at Cashfree, exact amount) completes the refund once; a duplicate adds no second audit event", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seedRefund(tx);
      let calls = 0;
      const verifyRefund = async (_o: string, id: string) => { calls++; return cfRefund(id, "SUCCESS", "100"); };
      assert.equal(await deliver(runner, refundBody(w.refundId, "FAKE_CF_ORDER_1", "SUCCESS", 100), { verifyRefund }), "processed");
      assert.equal(await deliver(runner, refundBody(w.refundId, "FAKE_CF_ORDER_1", "SUCCESS", 100), { verifyRefund }), "ignored");
      const r = await tx.refundRequest.findUniqueOrThrow({ where: { id: w.requestId }, select: { executionStatus: true, providerStatus: true } });
      const p = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true, refundedAmount: true } });
      assert.deepEqual([r.executionStatus, r.providerStatus, p.status, p.refundedAmount?.toString()], [RefundExecutionStatus.COMPLETED, "SUCCESS", PaymentStatus.REFUNDED, "100"]);
      assert.equal(await acts(tx, w.orderId, "REFUND_COMPLETED"), 1);
      assert.equal(await acts(tx, w.orderId, "PAYMENT_REFUNDED"), 1);
      assert.equal(calls, 1); // the duplicate never even reached Cashfree
    });
  });

  it("the delivery body is never trusted: it says SUCCESS but Cashfree says PENDING -> still processing; a wrong confirmed amount does not complete it", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seedRefund(tx);
      assert.equal(await deliver(runner, refundBody(w.refundId, "FAKE_CF_ORDER_1", "SUCCESS", 100), { verifyRefund: async (_o, id) => cfRefund(id, "PENDING", "100") }), "processed");
      let r = await tx.refundRequest.findUniqueOrThrow({ where: { id: w.requestId }, select: { executionStatus: true } });
      assert.equal(r.executionStatus, RefundExecutionStatus.PROCESSING);
      assert.equal(await deliver(runner, refundBody(w.refundId, "FAKE_CF_ORDER_1", "SUCCESS", 100), { verifyRefund: async (_o, id) => cfRefund(id, "SUCCESS", "50") }), "processed");
      r = await tx.refundRequest.findUniqueOrThrow({ where: { id: w.requestId }, select: { executionStatus: true } });
      assert.equal(r.executionStatus, RefundExecutionStatus.PROCESSING);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true, refundedAmount: true } });
      assert.deepEqual([p.status, p.refundedAmount], [PaymentStatus.SUCCESS, null]);
      assert.equal(await acts(tx, w.orderId, "REFUND_COMPLETED"), 0);
    });
  });

  it("FAILED / CANCELLED -> the CRM refund FAILED (retryable) with one audit event even when delivered twice; PENDING and ONHOLD stay processing", async () => {
    await inRollback(async (tx, runner) => {
      const pending = await seedRefund(tx);
      assert.equal(await deliver(runner, refundBody(pending.refundId, "FAKE_CF_ORDER_1", "PENDING", 100), { verifyRefund: async (_o, id) => cfRefund(id, "ONHOLD", "100") }), "processed");
      assert.equal((await tx.refundRequest.findUniqueOrThrow({ where: { id: pending.requestId }, select: { executionStatus: true } })).executionStatus, RefundExecutionStatus.PROCESSING);
      assert.equal(await acts(tx, pending.orderId, "REFUND_EXECUTION_FAILED"), 0);

      const failed = await seedRefund(tx);
      const verifyRefund = async (_o: string, id: string) => cfRefund(id, "CANCELLED", "100");
      assert.equal(await deliver(runner, refundBody(failed.refundId, "FAKE_CF_ORDER_1", "CANCELLED", 100), { verifyRefund }), "processed");
      assert.equal(await deliver(runner, refundBody(failed.refundId, "FAKE_CF_ORDER_1", "CANCELLED", 100), { verifyRefund }), "ignored");
      assert.equal((await tx.refundRequest.findUniqueOrThrow({ where: { id: failed.requestId }, select: { executionStatus: true } })).executionStatus, RefundExecutionStatus.FAILED);
      assert.equal(await acts(tx, failed.orderId, "REFUND_EXECUTION_FAILED"), 1);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: failed.paymentId }, select: { status: true } })).status, PaymentStatus.SUCCESS);
    });
  });

  it("a webhook can never start or approve a refund: unknown refund, not-yet-executed, pending-approval, wrong Cashfree order, or no verifier -> ignored, nothing changes", async () => {
    await inRollback(async (tx, runner) => {
      let lookups = 0;
      const verifyRefund = async (_o: string, id: string) => { lookups++; return cfRefund(id, "SUCCESS", "100"); };
      assert.equal(await deliver(runner, refundBody("rf-does-not-exist", "FAKE_CF_ORDER_1", "SUCCESS", 100), { verifyRefund }), "ignored");
      const notStarted = await seedRefund(tx, { executionStatus: null });
      assert.equal(await deliver(runner, refundBody(notStarted.refundId, "FAKE_CF_ORDER_1", "SUCCESS", 100), { verifyRefund }), "ignored");
      const pendingApproval = await seedRefund(tx, { status: RefundRequestStatus.PENDING, executionStatus: null });
      assert.equal(await deliver(runner, refundBody(pendingApproval.refundId, "FAKE_CF_ORDER_1", "SUCCESS", 100), { verifyRefund }), "ignored");
      const live = await seedRefund(tx);
      assert.equal(await deliver(runner, refundBody(live.refundId, "SOME_OTHER_ORDER", "SUCCESS", 100), { verifyRefund }), "ignored");
      assert.equal(await deliver(runner, refundBody(live.refundId, "FAKE_CF_ORDER_1", "SUCCESS", 100)), "ignored"); // no verifier configured
      assert.equal(lookups, 0);
      for (const w of [notStarted, pendingApproval, live]) {
        const r = await tx.refundRequest.findUniqueOrThrow({ where: { id: w.requestId }, select: { status: true, executionStatus: true } });
        assert.notEqual(r.executionStatus, RefundExecutionStatus.COMPLETED);
        assert.equal(await acts(tx, w.orderId, "REFUND_COMPLETED"), 0);
      }
    });
  });
});
