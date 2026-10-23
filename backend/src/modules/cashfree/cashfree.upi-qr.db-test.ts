// Dynamic UPI QR against the real schema: order association, exact amount / currency, idempotent retries, the sandbox-only gate, payment confirmation through the webhook (only Cashfree's own answer counts),
// and the WhatsApp send with its link-QR fallback. ONE rolled-back transaction per test on the isolated test database. Cashfree, Shopify and Meta are fakes: nothing real is called or sent.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { loadCashfreeConfig } from "./cashfree.config.js";
import { PNG_SIGNATURE, type CashfreeOrder } from "./cashfree.client.js";
import { closeOpenMethods, ensureUpiQr, qrOrderIdFor, verifyQrOrderPaid, type UpiQrApi } from "./cashfree.upi-qr.js";
import { processCashfreeEvent } from "./cashfree.webhook.processor.js";
import { handleCashfreeWebhook } from "./cashfree.webhook.handler.js";
import { reconcileCashfreePayment } from "./cashfree.reconcile.js";
import { sendPaymentQr, loadPaymentQrPng, renderStoredPaymentQr } from "../whatsapp/whatsapp.payment-qr.js";

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
const SANDBOX_ENV = { CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "test-id", CASHFREE_CLIENT_SECRET: "test-secret", CASHFREE_UPI_QR_ENABLED: "true", PUBLIC_BACKEND_URL: "https://crm.example.com" };
const CONFIG = loadCashfreeConfig(SANDBOX_ENV);
/** A REAL, decodable QR image (as a provider would return): the UPI pay request for `amount` / `currency`, or - for the negative cases - a web link or a request for another amount. */
const qrOf = (text: string) => QRCode.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 400 });
const upiText = (amount: string | number, currency = "INR", tn = "x") => `upi://pay?pa=simulated@mock&pn=SIMULATED&am=${amount}&cu=${currency}&tn=${tn}`;

/** A scripted Cashfree: it remembers orders (so a retry finds them), counts every call, and can be told to answer wrongly. */
function fakeCashfree(opts: { amountOverride?: string; unusablePay?: boolean; payAmount?: string; qr?: "web" | "wrongAmount" | "wrongCurrency" | "noAmount" | "unreadable" } = {}) {
  const orders = new Map<string, CashfreeOrder>();
  const calls = { create: 0, get: 0, pay: 0, requests: [] as { order_id: string; order_amount: number; order_currency: string }[] };
  const state = { status: "ACTIVE", payments: [] as { cfPaymentId: string; paymentStatus: string; paymentAmount: string }[] };
  const api: UpiQrApi = {
    getOrder: async (orderId) => {
      calls.get++;
      const o = orders.get(orderId);
      if (!o) throw Object.assign(new Error("order not found"), { status: 404 });
      return { ...o, orderStatus: state.status };
    },
    createOrder: async (request) => {
      calls.create++;
      calls.requests.push({ order_id: request.order_id, order_amount: request.order_amount, order_currency: request.order_currency });
      const o: CashfreeOrder = { cfOrderId: `cf-${calls.create}`, orderId: request.order_id, orderStatus: "ACTIVE", paymentSessionId: `session-${request.order_id}`, orderAmount: opts.amountOverride ?? String(request.order_amount), orderCurrency: request.order_currency, orderExpiryTime: null };
      orders.set(o.orderId, o);
      return o;
    },
    payUpiQr: async (session) => {
      calls.pay++;
      if (opts.unusablePay) throw new Error("Cashfree answered without a usable UPI QR image");
      const order = [...orders.values()].find((o) => o.paymentSessionId === session)!;
      const amount = order.orderAmount!;
      const text = opts.qr === "web" ? `https://payments-test.cashfree.com/links/${order.orderId}` : opts.qr === "wrongAmount" ? upiText("1.00", "INR", order.orderId) : opts.qr === "wrongCurrency" ? upiText(amount, "USD", order.orderId) : opts.qr === "noAmount" ? `upi://pay?pa=simulated@mock&pn=SIMULATED&cu=INR&tn=${order.orderId}` : upiText(amount, "INR", order.orderId);
      const image = opts.qr === "unreadable" ? Buffer.concat([PNG_SIGNATURE, Buffer.alloc(600, 9)]) : await qrOf(text);
      return { png: image, cfPaymentId: `cfp-${session.length}`, paymentAmount: opts.payAmount ?? null };
    },
    getOrderPayments: async () => state.payments.map((p) => ({ ...p, bankReference: "UTR9", paymentGroup: "upi", paymentTime: null })),
  };
  return { api, calls, state, orders };
}

async function seed(tx: Db, o: { amount?: string; currency?: string; status?: PaymentStatus; orderStatus?: OrderStatus; expiresAt?: Date | null; mobile?: string } = {}) {
  const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Test", mobile: "9876500000", normalizedMobile: o.mobile ?? "+919876500000", ownerId: rep.id }, select: { id: true } });
  const order = await tx.order.create({
    data: { orderNumber: `FAKE-${uid()}`, leadId: lead.id, source: OrderSource.SALESPERSON, status: o.orderStatus ?? OrderStatus.PENDING_PAYMENT, currency: "INR", subtotal: o.amount ?? "249.00", totalAmount: o.amount ?? "249.00", metadata: { paymentMode: "PREPAID" } },
    select: { id: true, orderNumber: true },
  });
  const linkId = `crm_${uid().replace(/-/g, "")}`;
  const payment = await tx.payment.create({
    data: { orderId: order.id, amount: o.amount ?? "249.00", currency: o.currency ?? "INR", method: PaymentMethod.PAYMENT_LINK, status: o.status ?? PaymentStatus.PENDING, provider: "Cashfree", externalSource: "CASHFREE", externalId: linkId, providerOrderId: linkId, paymentUrl: `https://payments.cashfree.com/links/${linkId.slice(-16)}`, paymentExpiresAt: o.expiresAt === undefined ? new Date(Date.now() + 3 * 86_400_000) : o.expiresAt },
    select: { id: true },
  });
  return { orderId: order.id, orderNumber: order.orderNumber, leadId: lead.id, paymentId: payment.id, linkId, repId: rep.id };
}

const deps = (runner: TxRunner, api: UpiQrApi, env: NodeJS.ProcessEnv = SANDBOX_ENV) => ({ runner, api, config: CONFIG, env });

describe("UPI QR creation", () => {
  it("creates ONE Cashfree order for the payment with the exact amount and currency, stores the QR on that payment, and a retry returns the same QR without any new request", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx, { amount: "249.50" });
      const cf = fakeCashfree();
      const first = await ensureUpiQr(deps(runner, cf.api), w.paymentId);
      assert.equal(first.orderId, qrOrderIdFor(w.paymentId));
      assert.deepEqual(cf.calls.requests, [{ order_id: qrOrderIdFor(w.paymentId), order_amount: 249.5, order_currency: "INR" }]);
      assert.equal(first.png.subarray(0, 8).equals(PNG_SIGNATURE), true);
      const again = await ensureUpiQr(deps(runner, cf.api), w.paymentId);
      const third = await Promise.all([ensureUpiQr(deps(runner, cf.api), w.paymentId), ensureUpiQr(deps(runner, cf.api), w.paymentId)]);
      assert.deepEqual([cf.calls.create, cf.calls.pay], [1, 1], "no duplicate Cashfree order or Order Pay");
      assert.ok(again.png.equals(first.png) && third.every((t) => t.png.equals(first.png)));
      const stored = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true, amount: true, externalId: true, metadata: true } });
      assert.deepEqual([stored.status, stored.amount.toString(), stored.externalId], [PaymentStatus.PENDING, "249.5", w.linkId], "creating a QR never changes the payment");
      const meta = stored.metadata as { upiQr: Record<string, unknown> };
      assert.equal(meta.upiQr.orderId, qrOrderIdFor(w.paymentId));
      assert.ok(!JSON.stringify(stored.metadata).includes("session-"), "the payment session id is never stored");
    });
  });

  it("a Cashfree order that already exists for the payment is reused, not created again; two payments never share an order or a QR", async () => {
    await inRollback(async (tx, runner) => {
      const a = await seed(tx);
      const b = await seed(tx);
      const cf = fakeCashfree();
      cf.orders.set(qrOrderIdFor(a.paymentId), { cfOrderId: "pre", orderId: qrOrderIdFor(a.paymentId), orderStatus: "ACTIVE", paymentSessionId: "s-pre", orderAmount: "249.00", orderCurrency: "INR", orderExpiryTime: null });
      const qa = await ensureUpiQr(deps(runner, cf.api), a.paymentId);
      assert.equal(cf.calls.create, 0);
      const qb = await ensureUpiQr(deps(runner, cf.api), b.paymentId);
      assert.notEqual(qa.orderId, qb.orderId);
      assert.equal(qb.orderId, qrOrderIdFor(b.paymentId));
      assert.equal(cf.calls.create, 1);
    });
  });

  it("refuses without calling Cashfree: feature off, production, a paid / expired payment, a cancelled order, a non-INR payment, a missing mobile", async () => {
    await inRollback(async (tx, runner) => {
      const cf = fakeCashfree();
      const ok = await seed(tx);
      await assert.rejects(ensureUpiQr(deps(runner, cf.api, { ...SANDBOX_ENV, CASHFREE_UPI_QR_ENABLED: "" }), ok.paymentId), /not enabled/);
      const production = { ...CONFIG, environment: "production" as const };
      await assert.rejects(ensureUpiQr({ runner, api: cf.api, config: production, env: SANDBOX_ENV }, ok.paymentId), /sandbox only/);
      for (const [label, o, rx] of [
        ["paid", { status: PaymentStatus.SUCCESS }, /already success/],
        ["expired", { expiresAt: new Date(Date.now() - 1000) }, /expired/],
        ["cancelled order", { orderStatus: OrderStatus.CANCELLED }, /no longer payable/],
        ["usd", { currency: "USD" }, /INR/],
        ["no mobile", { mobile: "" }, /mobile/],
      ] as const) {
        const w = await seed(tx, o);
        await assert.rejects(ensureUpiQr(deps(runner, cf.api), w.paymentId), rx, label);
      }
      assert.deepEqual([cf.calls.create, cf.calls.get, cf.calls.pay], [0, 0, 0]);
    });
  });

  it("a Cashfree order for another amount, an unusable QR answer, or a QR for another amount is rejected and nothing is stored", async () => {
    await inRollback(async (tx, runner) => {
      const wrongAmount = await seed(tx);
      await assert.rejects(ensureUpiQr(deps(runner, fakeCashfree({ amountOverride: "1.00" }).api), wrongAmount.paymentId), /does not match/);
      const unusable = await seed(tx);
      await assert.rejects(ensureUpiQr(deps(runner, fakeCashfree({ unusablePay: true }).api), unusable.paymentId), /usable UPI QR/);
      const wrongQr = await seed(tx);
      await assert.rejects(ensureUpiQr(deps(runner, fakeCashfree({ payAmount: "1" }).api), wrongQr.paymentId), /different amount/);
      for (const w of [wrongAmount, unusable, wrongQr]) {
        const p = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { metadata: true, status: true } });
        assert.equal(JSON.stringify(p.metadata ?? {}).includes("upiQr"), false);
        assert.equal(p.status, PaymentStatus.PENDING);
      }
    });
  });
});

const successEvent = (orderId: string, amount: string, id = uid(), cfPaymentId = "cfp-1") => ({ id, type: "PAYMENT_SUCCESS_WEBHOOK", payload: { type: "PAYMENT_SUCCESS_WEBHOOK", event_time: "2026-10-22T12:00:00+05:30", data: { order: { order_id: orderId, order_amount: Number(amount), order_currency: "INR" }, payment: { cf_payment_id: cfPaymentId, payment_status: "SUCCESS", payment_amount: Number(amount), payment_currency: "INR", payment_group: "upi", bank_reference: "UTR9", payment_time: "2026-10-22T12:00:00+05:30" }, customer_details: {} } } });
async function deliver(runner: TxRunner, ev: ReturnType<typeof successEvent>, extra: Partial<Parameters<typeof processCashfreeEvent>[1]> = {}) {
  const { store } = memoryStore();
  const stored = await store.record({ eventType: ev.type, externalEventId: ev.id, payload: ev.payload, ignored: false });
  return processCashfreeEvent(stored.id, { store, runner, ...extra });
}

describe("payment confirmation for the QR's order", () => {
  const verifier = (cf: ReturnType<typeof fakeCashfree>) => (orderId: string, expected: { amount: string; currency: string }) => verifyQrOrderPaid(cf.api, orderId, expected);

  it("a signed SUCCESS delivery for the QR order marks the payment paid ONLY when Cashfree itself says the order is PAID for the exact amount; the payment link is not consulted; a duplicate is harmless", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      const cf = fakeCashfree();
      await ensureUpiQr(deps(runner, cf.api), w.paymentId);
      const orderId = qrOrderIdFor(w.paymentId);
      const verifyLink = async () => { throw new Error("the payment link must not be consulted for the QR's order"); };

      // Cashfree still says ACTIVE: the delivery alone is not believed
      cf.state.status = "ACTIVE";
      assert.equal(await deliver(runner, successEvent(orderId, "249.00"), { verifyLink, verifyQrOrder: verifier(cf) }), "ignored");
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true } })).status, PaymentStatus.PENDING);

      // Cashfree confirms: PAID, one successful payment of the exact amount
      cf.state.status = "PAID";
      cf.state.payments = [{ cfPaymentId: "cfp-1", paymentStatus: "SUCCESS", paymentAmount: "249.00" }];
      assert.equal(await deliver(runner, successEvent(orderId, "249.00"), { verifyLink, verifyQrOrder: verifier(cf) }), "processed");
      const paid = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true, amount: true } });
      assert.deepEqual([paid.status, paid.amount.toString()], [PaymentStatus.SUCCESS, "249"]);
      assert.equal(await tx.payment.count({ where: { orderId: w.orderId } }), 1, "still one payment for the order");
      const again = await deliver(runner, successEvent(orderId, "249.00"), { verifyLink, verifyQrOrder: verifier(cf) });
      assert.ok(["processed", "ignored"].includes(again));
      assert.equal(await tx.activity.count({ where: { orderId: w.orderId, type: "PAYMENT_STATUS_CHANGED" } }) >= 1, true);
    });
  });

  it("a wrong amount in the delivery, or Cashfree reporting a different amount, is not applied and a mismatch is recorded for admins", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      const cf = fakeCashfree();
      await ensureUpiQr(deps(runner, cf.api), w.paymentId);
      const orderId = qrOrderIdFor(w.paymentId);
      assert.equal(await deliver(runner, successEvent(orderId, "1.00"), { verifyQrOrder: verifier(cf) }), "ignored", "the delivery reports 1.00 for a 249.00 payment");
      cf.orders.set(orderId, { ...cf.orders.get(orderId)!, orderAmount: "1.00" });
      cf.state.status = "PAID";
      assert.equal(await deliver(runner, successEvent(orderId, "249.00"), { verifyQrOrder: verifier(cf) }), "ignored", "Cashfree says the order was for 1.00");
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true } })).status, PaymentStatus.PENDING);
      assert.ok((await tx.activity.count({ where: { orderId: w.orderId, type: "PAYMENT_MISMATCH_DETECTED" } })) >= 1);
    });
  });
});

describe("WhatsApp delivery of the UPI QR", () => {
  const meta = () => {
    const sent: { to: string; mediaId?: string; link?: string; caption?: string }[] = [];
    const uploads: Buffer[] = [];
    const state = { failSend: false };
    const provider = {
      uploadMedia: async (data: Buffer) => { uploads.push(data); return `MEDIA-${uploads.length}`; },
      sendImage: async (input: { to: string; mediaId?: string; link?: string; caption?: string }) => { sent.push(input); if (state.failSend) throw new Error("Meta rejected the image (token EAAB123456789secretvalue)"); return { providerMessageId: `wamid.${sent.length}`, raw: {} }; },
    };
    const freeText = { getCapability: async () => ({ capability: { freeText: { allowed: true, reason: null, message: null } }, meta: provider }) } as never;
    return { sent, uploads, state, freeText };
  };
  const actor = (id: string) => ({ id, username: "rep", role: Role.SALESPERSON }) as never;

  it("sends the order-specific UPI QR image (not the link QR), says so, and the public image URL serves the same bytes", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      const cf = fakeCashfree();
      const m = meta();
      const result = await sendPaymentQr(tx, actor(w.repId), w.paymentId, { freeText: m.freeText, publicBaseUrl: "https://crm.example.com", upiQr: deps(runner, cf.api) });
      assert.deepEqual([result.status, result.kind, result.fallbackReason], ["SENT", "UPI", undefined]);
      const stored = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { metadata: true } });
      const qrBytes = Buffer.from((stored.metadata as { upiQr: { png: string } }).upiQr.png, "base64");
      assert.ok(m.uploads[0]!.equals(qrBytes), "the uploaded image IS the stored Cashfree QR");
      assert.equal(m.sent[0]!.mediaId, "MEDIA-1");
      assert.match(m.sent[0]!.caption ?? "", /^Scan to pay ₹249\.00 for order /);
      const token = (stored.metadata as { qrToken?: string }).qrToken;
      if (token) assert.ok((await loadPaymentQrPng(tx, w.paymentId, token))!.equals(qrBytes));
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { status: true } })).status, PaymentStatus.PENDING, "sending a QR never marks anything paid");
    });
  });

  it("when the direct UPI QR cannot be made (e.g. S2S not enabled) NOTHING is sent in its place - no website QR - and the result says why", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      const m = meta();
      const cf = fakeCashfree({ unusablePay: true });
      const result = await sendPaymentQr(tx, actor(w.repId), w.paymentId, { freeText: m.freeText, publicBaseUrl: "https://crm.example.com", upiQr: deps(runner, cf.api) });
      assert.equal(result.status, "FAILED");
      assert.match(result.reason ?? "", /direct UPI QR could not be created.*usable UPI QR.*No website QR was sent/);
      assert.deepEqual([m.uploads.length, m.sent.length], [0, 0], "no image of any kind went out");
    });
  });

  it("a provider failure is FAILED (not SENT) and carries no credential; with the feature off the link QR is sent exactly as before", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      const m = meta();
      m.state.failSend = true;
      const failed = await sendPaymentQr(tx, actor(w.repId), w.paymentId, { freeText: m.freeText, publicBaseUrl: "https://crm.example.com", upiQr: deps(runner, fakeCashfree().api) });
      assert.equal(failed.status, "FAILED");
      assert.ok(!JSON.stringify(failed).includes("EAAB123456789secretvalue"));
      const plain = await seed(tx);
      const m2 = meta();
      const off = await sendPaymentQr(tx, actor(plain.repId), plain.paymentId, { freeText: m2.freeText, publicBaseUrl: "https://crm.example.com", upiQr: null });
      assert.deepEqual([off.status, off.kind], ["SENT", "LINK"]);
    });
  });
});

// ------------------------------------------------------------------ duplicate payments, cancellation / expiry, late payments
const linkOrderOf = (linkId: string) => `CFPay_${linkId.slice(-16)}_b3ea_1791374485548`;
const exceptions = async (tx: Db, orderId: string) => ((await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } })).metadata as { paymentExceptions?: { kind: string; status: string; amount: string; cfPaymentId: string | null }[] } | null)?.paymentExceptions ?? [];
const exceptionRows = (tx: Db, orderId: string) => tx.activity.count({ where: { orderId, type: "PAYMENT_MISMATCH_DETECTED", metadata: { path: ["needsRefund"], equals: true } } });
const linkPaid = async () => ({ cfLinkId: "1", linkId: "x", linkStatus: "PAID", linkUrl: "https://pay.test/x", linkAmount: "249", linkAmountPaid: "249.00", linkExpiryTime: null }) as never;

describe("one payment per order: the link and the QR together", () => {
  const setup = async (tx: Db, runner: TxRunner) => {
    const w = await seed(tx);
    const cf = fakeCashfree();
    await ensureUpiQr(deps(runner, cf.api), w.paymentId);
    const closed: { terminated: string[]; cancelled: string[] } = { terminated: [], cancelled: [] };
    const api = { terminateOrder: async (id: string) => { closed.terminated.push(id); return { cfOrderId: null, orderId: id, orderStatus: "TERMINATED", paymentSessionId: null, orderAmount: null, orderCurrency: null, orderExpiryTime: null }; }, cancelLink: async (id: string) => { closed.cancelled.push(id); return null; } };
    const processorDeps = { verifyLink: linkPaid, verifyQrOrder: (o: string, e: { amount: string; currency: string }) => verifyQrOrderPaid(cf.api, o, e), closeOpenMethods: async (id: string, to: "SUCCESS" | "FAILED", via: string | null) => void (await closeOpenMethods({ runner, api }, id, to, via)) };
    const qrPaid = () => { cf.state.status = "PAID"; cf.state.payments = [{ cfPaymentId: "cfp-QR", paymentStatus: "SUCCESS", paymentAmount: "249.00" }]; };
    return { w, cf, closed, processorDeps, qrPaid, qrOrder: qrOrderIdFor(w.paymentId), linkOrder: linkOrderOf(w.linkId) };
  };
  const paymentOf = (tx: Db, id: string) => tx.payment.findUniqueOrThrow({ where: { id }, select: { status: true, providerPaymentId: true } });

  it("QR paid first, then the link is ALSO paid: the QR stays the payment, the link is cancelled, and the second payment is recorded for refund exactly once", async () => {
    await inRollback(async (tx, runner) => {
      const s = await setup(tx, runner);
      s.qrPaid();
      assert.equal(await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-QR"), s.processorDeps), "processed");
      assert.deepEqual(s.closed.cancelled, [s.w.linkId], "paid by QR -> the payment link is cancelled");
      assert.deepEqual(s.closed.terminated, []);
      assert.deepEqual(await paymentOf(tx, s.w.paymentId), { status: PaymentStatus.SUCCESS, providerPaymentId: "cfp-QR" });

      // the customer also paid through the link before it was cancelled
      await deliver(runner, successEvent(s.linkOrder, "249.00", uid(), "cfp-LINK"), s.processorDeps);
      await deliver(runner, successEvent(s.linkOrder, "249.00", uid(), "cfp-LINK"), s.processorDeps); // redelivered
      assert.deepEqual(await paymentOf(tx, s.w.paymentId), { status: PaymentStatus.SUCCESS, providerPaymentId: "cfp-QR" }, "the first payment is untouched");
      const list = await exceptions(tx, s.w.orderId);
      assert.deepEqual(list.map((e) => [e.kind, e.status, e.amount, e.cfPaymentId]), [["duplicate", "NEEDS_REFUND", "249.00", "cfp-LINK"]]);
      assert.equal(await exceptionRows(tx, s.w.orderId), 1);
      assert.equal(await tx.payment.count({ where: { orderId: s.w.orderId } }), 1, "no second Payment row");
    });
  });

  it("link paid first, then the QR is ALSO paid: the link stays the payment, the QR order is terminated, and the QR payment is recorded for refund", async () => {
    await inRollback(async (tx, runner) => {
      const s = await setup(tx, runner);
      assert.equal(await deliver(runner, successEvent(s.linkOrder, "249.00", uid(), "cfp-LINK"), s.processorDeps), "processed");
      assert.deepEqual(s.closed.terminated, [s.qrOrder], "paid by link -> the QR's Cashfree order is terminated");
      assert.deepEqual(await paymentOf(tx, s.w.paymentId), { status: PaymentStatus.SUCCESS, providerPaymentId: "cfp-LINK" });

      s.qrPaid();
      await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-QR"), s.processorDeps);
      assert.deepEqual(await paymentOf(tx, s.w.paymentId), { status: PaymentStatus.SUCCESS, providerPaymentId: "cfp-LINK" });
      assert.deepEqual((await exceptions(tx, s.w.orderId)).map((e) => [e.kind, e.cfPaymentId]), [["duplicate", "cfp-QR"]]);
    });
  });

  it("repeated success webhooks for the SAME payment change nothing: one status change, no exception, the link cancelled once", async () => {
    await inRollback(async (tx, runner) => {
      const s = await setup(tx, runner);
      s.qrPaid();
      for (const _ of [1, 2, 3]) await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-QR"), s.processorDeps);
      assert.deepEqual(await paymentOf(tx, s.w.paymentId), { status: PaymentStatus.SUCCESS, providerPaymentId: "cfp-QR" });
      assert.equal(await tx.activity.count({ where: { orderId: s.w.orderId, type: "PAYMENT_STATUS_CHANGED", referenceId: s.w.paymentId } }), 1);
      assert.deepEqual(await exceptions(tx, s.w.orderId), []);
      assert.equal(s.closed.cancelled.length, 1, "the link is cancelled once, not once per delivery");
    });
  });
});

describe("cancellation and expiry while the QR is active", () => {
  const terminator = () => {
    const calls: { terminate: string[]; keys: string[] } = { terminate: [], keys: [] };
    return { calls, api: { terminateOrder: async (id: string, key: string) => { calls.terminate.push(id); calls.keys.push(key); return { cfOrderId: null, orderId: id, orderStatus: "TERMINATION_REQUESTED", paymentSessionId: null, orderAmount: null, orderCurrency: null, orderExpiryTime: null }; } } };
  };

  it("a failed / cancelled / expired payment terminates the QR order once, records the outcome, and the QR is never served or sent again", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      const cf = fakeCashfree();
      await ensureUpiQr(deps(runner, cf.api), w.paymentId);
      const t = terminator();
      const dispatch = async (id: string, to: "SUCCESS" | "FAILED", via: string | null) => void (await closeOpenMethods({ runner, api: t.api }, id, to, via));
      // the same reconciliation every path (webhook, Refresh, catch-up) ends in: the link expired
      const applied = await reconcileCashfreePayment({ runner, closeOpenMethods: dispatch }, w.paymentId, { status: "FAILED", failureReason: "Payment link expired" }, { source: ActivitySource.CASHFREE_WEBHOOK });
      assert.equal(applied.outcome, "updated");
      assert.deepEqual(t.calls.terminate, [qrOrderIdFor(w.paymentId)]);
      const stored = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { metadata: true, status: true } });
      assert.equal(stored.status, PaymentStatus.FAILED);
      assert.equal((stored.metadata as { upiQr: { closed: { ok: boolean } } }).upiQr.closed.ok, true);
      assert.equal(await closeOpenMethods({ runner, api: t.api }, w.paymentId, "FAILED", null), "nothing", "already terminated: no second request");
      assert.equal(t.calls.terminate.length, 1);
      await assert.rejects(ensureUpiQr(deps(runner, cf.api), w.paymentId), /already failed/);
      const m = { sent: 0 };
      const fakeText = { getCapability: async () => ({ capability: { freeText: { allowed: true, reason: null, message: null } }, meta: { uploadMedia: async () => "M", sendImage: async () => { m.sent++; return { providerMessageId: "w", raw: {} }; } } }) } as never;
      const sendResult = await sendPaymentQr(tx, { id: w.repId, username: "r", role: Role.SALESPERSON } as never, w.paymentId, { freeText: fakeText, publicBaseUrl: "https://crm.example.com", upiQr: deps(runner, cf.api) });
      assert.deepEqual([sendResult.status, m.sent], ["NOT_SENT", 0]);
    });
  });

  it("if Cashfree refuses to terminate, nothing throws, the failure is recorded, and a retry is possible; a payment that never had a QR makes no Cashfree request at all", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      await ensureUpiQr(deps(runner, fakeCashfree().api), w.paymentId);
      const refusing = { terminateOrder: async () => { throw new Error("order cannot be terminated (token EAAB123456789secretvalue)"); } };
      assert.equal(await closeOpenMethods({ runner, api: refusing }, w.paymentId, "FAILED", null), "failed");
      const closed = ((await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { metadata: true } })).metadata as { upiQr: { closed: { ok: boolean; error: string } } }).upiQr.closed;
      assert.equal(closed.ok, false);
      assert.ok(!closed.error.includes("EAAB123456789secretvalue"));
      const t = terminator();
      assert.equal(await closeOpenMethods({ runner, api: t.api }, w.paymentId, "FAILED", null), "closed", "the next attempt terminates it");

      const plain = await seed(tx);
      const never = terminator();
      assert.equal(await closeOpenMethods({ runner, api: never.api }, plain.paymentId, "FAILED", null), "nothing");
      assert.deepEqual(never.calls.terminate, []);
    });
  });
});

describe("a verified payment that arrives LATE is never applied as a normal payment", () => {
  const lateSetup = async (tx: Db, runner: TxRunner, o: { orderStatus: OrderStatus; failure: string; expiresAt?: Date }) => {
    // the QR is made while everything is still open; the order is then cancelled / the payment closed, as it would be in real life
    const w = await seed(tx);
    const cf = fakeCashfree();
    await ensureUpiQr(deps(runner, cf.api), w.paymentId);
    await tx.order.update({ where: { id: w.orderId }, data: { status: o.orderStatus } });
    await tx.payment.update({ where: { id: w.paymentId }, data: { status: PaymentStatus.FAILED, failureReason: o.failure, failedAt: new Date(), ...(o.expiresAt ? { paymentExpiresAt: o.expiresAt } : {}) } });
    cf.state.status = "PAID";
    cf.state.payments = [{ cfPaymentId: "cfp-LATE", paymentStatus: "SUCCESS", paymentAmount: "249.00" }];
    const d = { verifyQrOrder: (id: string, e: { amount: string; currency: string }) => verifyQrOrderPaid(cf.api, id, e), verifyLink: linkPaid };
    return { w, cf, d, qrOrder: qrOrderIdFor(w.paymentId) };
  };

  it("after the order was CANCELLED: the payment and order stay as they are, the money is recorded for refund once, repeated deliveries add nothing", async () => {
    await inRollback(async (tx, runner) => {
      const s = await lateSetup(tx, runner, { orderStatus: OrderStatus.CANCELLED, failure: "Payment link cancelled" });
      assert.equal(await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-LATE"), s.d), "processed");
      await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-LATE"), s.d);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: s.w.paymentId }, select: { status: true } })).status, PaymentStatus.FAILED);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: s.w.orderId }, select: { status: true } })).status, OrderStatus.CANCELLED);
      assert.deepEqual((await exceptions(tx, s.w.orderId)).map((e) => [e.kind, e.status, e.amount, e.cfPaymentId]), [["late", "NEEDS_REFUND", "249.00", "cfp-LATE"]]);
      assert.equal(await exceptionRows(tx, s.w.orderId), 1);
    });
  });

  it("for a payment the CRM had cancelled while the order is still waiting for payment: not confirmed, recorded for refund", async () => {
    await inRollback(async (tx, runner) => {
      const s = await lateSetup(tx, runner, { orderStatus: OrderStatus.PENDING_PAYMENT, failure: "Payment link cancelled" });
      await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-LATE"), s.d);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: s.w.orderId }, select: { status: true } })).status, OrderStatus.PENDING_PAYMENT, "the order is NOT confirmed by it");
      assert.equal((await exceptions(tx, s.w.orderId)).length, 1);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: s.w.paymentId }, select: { status: true } })).status, PaymentStatus.FAILED);
    });
  });

  it("a QR payment after the payment's expiry is late; a LINK payment moments after it expired is still the ordinary paid-just-before-expiry case and is applied", async () => {
    await inRollback(async (tx, runner) => {
      const expired = await lateSetup(tx, runner, { orderStatus: OrderStatus.PENDING_PAYMENT, failure: "Payment link expired", expiresAt: new Date("2026-10-22T00:00:00Z") });
      await deliver(runner, successEvent(expired.qrOrder, "249.00", uid(), "cfp-LATE"), expired.d);
      assert.deepEqual((await exceptions(tx, expired.w.orderId)).map((e) => e.kind), ["late"]);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: expired.w.paymentId }, select: { status: true } })).status, PaymentStatus.FAILED);

      const raceWinner = await lateSetup(tx, runner, { orderStatus: OrderStatus.PENDING_PAYMENT, failure: "Payment link expired", expiresAt: new Date("2026-10-22T00:00:00Z") });
      await deliver(runner, successEvent(linkOrderOf(raceWinner.w.linkId), "249.00", uid(), "cfp-LINK"), raceWinner.d);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: raceWinner.w.paymentId }, select: { status: true } })).status, PaymentStatus.SUCCESS);
      assert.deepEqual(await exceptions(tx, raceWinner.w.orderId), []);
    });
  });

  it("not believed without Cashfree: a late delivery whose order is not PAID, has another amount or another currency records nothing and applies nothing", async () => {
    await inRollback(async (tx, runner) => {
      const s = await lateSetup(tx, runner, { orderStatus: OrderStatus.CANCELLED, failure: "Payment link cancelled" });
      s.cf.state.status = "ACTIVE";
      assert.equal(await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-LATE"), s.d), "ignored");
      s.cf.state.status = "PAID";
      s.cf.orders.set(s.qrOrder, { ...s.cf.orders.get(s.qrOrder)!, orderCurrency: "USD" });
      assert.equal(await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-LATE"), s.d), "ignored", "currency mismatch");
      s.cf.orders.set(s.qrOrder, { ...s.cf.orders.get(s.qrOrder)!, orderCurrency: "INR", orderAmount: "1.00" });
      assert.equal(await deliver(runner, successEvent(s.qrOrder, "249.00", uid(), "cfp-LATE"), s.d), "ignored", "amount mismatch");
      assert.deepEqual(await exceptions(tx, s.w.orderId), []);
    });
  });

  it("an invalid signature is rejected before anything is stored or processed", async () => {
    const m = memoryStore();
    const scheduled: string[] = [];
    const body = Buffer.from(JSON.stringify(successEvent("qr_x", "249.00").payload));
    const result = await handleCashfreeWebhook({ rawBody: body, headers: { "x-webhook-timestamp": String(Date.now()), "x-webhook-signature": "forged" } }, { config: { secret: "test-secret" }, store: m.store, schedule: (id: string) => void scheduled.push(id) });
    assert.equal(result.status, 401);
    assert.deepEqual([m.rows.length, scheduled.length], [0, 0]);
  });
});

describe("only a provider QR that really is a direct UPI payment request for this amount is used", () => {
  it("a QR that opens a web page, one for another amount or currency, one with no amount, and an unreadable picture are all refused and never stored", async () => {
    await inRollback(async (tx, runner) => {
      for (const [qr, rx] of [
        ["web", /opens a web page/],
        ["wrongAmount", /exact amount/],
        ["wrongCurrency", /currency/],
        ["noAmount", /exact amount/],
        ["unreadable", /could not be read/],
      ] as const) {
        const w = await seed(tx);
        await assert.rejects(ensureUpiQr(deps(runner, fakeCashfree({ qr }).api), w.paymentId), rx, qr);
        const p = await tx.payment.findUniqueOrThrow({ where: { id: w.paymentId }, select: { metadata: true } });
        assert.equal(JSON.stringify(p.metadata ?? {}).includes("upiQr"), false, qr + " was stored");
      }
    });
  });

  it("with the direct UPI QR on, the order page / public image show only the verified provider QR - never the payment-link web QR - and WhatsApp sends nothing when the QR is refused", async () => {
    await inRollback(async (tx, runner) => {
      const w = await seed(tx);
      const on = deps(runner, fakeCashfree().api);
      assert.equal(await renderStoredPaymentQr(tx, w.paymentId, w.orderId, { upiQr: on }), null, "no direct QR yet: the website card is NOT shown in its place");
      const stored = await ensureUpiQr(on, w.paymentId);
      const shown = await renderStoredPaymentQr(tx, w.paymentId, w.orderId, { upiQr: on });
      assert.ok(shown && shown.png.equals(stored.png), "the page shows the exact provider QR");
      // and the picture it shows decodes to the UPI request for the exact amount
      const { assertDirectUpiQr } = await import("./cashfree.upi-qr-decode.js");
      assert.equal(assertDirectUpiQr(shown.png, { amount: "249.00", currency: "INR" }).kind, "upi_pay");
      // feature off (default): the long-standing link QR is unchanged
      const legacy = await seed(tx);
      assert.ok(await renderStoredPaymentQr(tx, legacy.paymentId, legacy.orderId, { upiQr: null }));

      const refused = await seed(tx);
      const sent: unknown[] = [];
      const freeText = { getCapability: async () => ({ capability: { freeText: { allowed: true, reason: null, message: null } }, meta: { uploadMedia: async () => "M", sendImage: async (i: unknown) => { sent.push(i); return { providerMessageId: "w", raw: {} }; } } }) } as never;
      const r = await sendPaymentQr(tx, { id: refused.repId, username: "r", role: Role.SALESPERSON } as never, refused.paymentId, { freeText, publicBaseUrl: "https://crm.example.com", upiQr: deps(runner, fakeCashfree({ qr: "web" }).api) });
      assert.deepEqual([r.status, sent.length], ["FAILED", 0]);
    });
  });
});

describe("configured merchant UPI id (CASHFREE_UPI_QR_EXPECTED_PAYEE)", () => {
  it("when set, only a QR paying exactly that payee is used; a QR for any other payee is refused and not stored (MOCKED provider)", async () => {
    await inRollback(async (tx, runner) => {
      const wrong = await seed(tx);
      await assert.rejects(ensureUpiQr(deps(runner, fakeCashfree().api, { ...SANDBOX_ENV, CASHFREE_UPI_QR_EXPECTED_PAYEE: "real-merchant@bank" }), wrong.paymentId), /different payee/);
      assert.equal(JSON.stringify((await tx.payment.findUniqueOrThrow({ where: { id: wrong.paymentId }, select: { metadata: true } })).metadata ?? {}).includes("upiQr"), false);
      const right = await seed(tx);
      const ok = await ensureUpiQr(deps(runner, fakeCashfree().api, { ...SANDBOX_ENV, CASHFREE_UPI_QR_EXPECTED_PAYEE: "Simulated@Mock" }), right.paymentId);
      assert.equal(ok.orderId, qrOrderIdFor(right.paymentId));
    });
  });
});
