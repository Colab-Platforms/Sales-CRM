// Database integration tests for the Cashfree payment-link integration. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back, so nothing is ever committed and it is safe to run
// against a shared development database. The database must have the 20260921120000_add_cashfree_shiprocket_integration
// migration applied. Cashfree itself is never called: a fake stands in for it, so these tests need no credentials.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ActivityType, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ProviderHttpError, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { codOrderNode, money, normalized, orderNode, rawLineItem, rawTransaction } from "../shopify/shopify.fixtures.js";
import { upsertOrder } from "../shopify/shopify.persist.js";
import ReconciliationService from "../reconciliation/reconciliation.service.js";
import WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import type { WhatsAppProvider } from "../whatsapp/whatsapp.provider.js";
import type { CashfreeLink } from "./cashfree.client.js";
import { loadCashfreeConfig } from "./cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "./cashfree.payments.service.js";
import { processCashfreeEvent } from "./cashfree.webhook.processor.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx, { $transaction: (cb) => cb(tx) });
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });

async function makeRep(tx: Db, role: Role = Role.SALESPERSON) {
  return tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role }, select: { id: true, email: true } });
}

async function makeLead(tx: Db, ownerId: string, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  const source = await tx.source.create({ data: { name: "Website", code: `web-${uid()}` }, select: { id: true } });
  // Explicit select: the shared dev database has an unapplied lead-import migration, so a Lead is never read whole.
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "919876500000", email: "priya@example.invalid", sourceId: source.id, ownerId, ...overrides },
    select: { id: true },
  });
}

async function makeOrder(tx: Db, leadId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return tx.order.create({
    data: { orderNumber: `ORD-${uid()}`, leadId, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "649.00", ...overrides },
    select: { id: true, orderNumber: true },
  });
}

const addPayment = (tx: Db, orderId: string, data: Partial<Prisma.PaymentUncheckedCreateInput> & { amount: string }) =>
  tx.payment.create({ data: { orderId, status: PaymentStatus.SUCCESS, method: PaymentMethod.UPI, ...data }, select: { id: true } });

function fakeApi(over: Partial<CashfreeApi> = {}) {
  const calls = { create: [] as { request: Parameters<CashfreeApi["createLink"]>[0]; key: string }[], get: [] as string[], cancel: [] as string[] };
  const link = (linkId: string, over2: Partial<CashfreeLink> = {}): CashfreeLink => ({ cfLinkId: "1", linkId, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${linkId}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null, ...over2 });
  const api: CashfreeApi = {
    createLink: async (request, key) => {
      calls.create.push({ request, key });
      return link(request.link_id, { linkAmount: String(request.link_amount) });
    },
    getLink: async (linkId) => {
      calls.get.push(linkId);
      return link(linkId);
    },
    cancelLink: async (linkId) => {
      calls.cancel.push(linkId);
      return link(linkId, { linkStatus: "CANCELLED" });
    },
    ...over,
  };
  return { api, calls, link };
}

const service = (runner: TxRunner, api: CashfreeApi, extra: Record<string, unknown> = {}) => new CashfreePaymentsService(runner, { config: () => CONFIG, client: () => api, ...extra });
const cashfreePayments = (tx: Db, orderId: string) => tx.payment.findMany({ where: { orderId, externalSource: "CASHFREE" }, orderBy: { createdAt: "asc" } });
const activityTypes = async (tx: Db, orderId: string) => (await tx.activity.findMany({ where: { orderId }, select: { type: true } })).map((a) => a.type);

/** Delivers one webhook payload through the real store + processor, exactly as the route would. */
async function deliver(_tx: Db, runner: TxRunner, payload: unknown, deliveryKey = uid()) {
  const { store, rows } = memoryStore();
  const { id } = await store.record({ eventType: String((payload as { type?: string }).type), externalEventId: deliveryKey, payload });
  const outcome = await processCashfreeEvent(id, { store, runner });
  return { outcome, row: rows[0] };
}

const linkPaid = (linkId: string, paid = "649.00", extra: Record<string, unknown> = {}) => ({ type: "PAYMENT_LINK_EVENT", data: { link_id: linkId, link_status: "PAID", link_amount: 649, link_amount_paid: paid, ...extra } });

describe("creating a payment link", () => {
  it("creates ONE payment for the exact pending amount and returns it again on a repeat", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id);
      const order = await makeOrder(tx, lead.id);
      await addPayment(tx, order.id, { amount: "200.00", externalSource: "SHOPIFY", externalId: uid() });
      const { api, calls } = fakeApi();
      const svc = service(runner, api);

      const first = await svc.createPaymentLink(as(rep, Role.SALESPERSON), order.id);
      assert.equal(first.amount, "449.00");
      assert.equal(first.status, PaymentStatus.PENDING);
      assert.equal(first.reused, false);
      assert.equal(first.paymentUrl, `https://pay.test/${first.linkId}`);
      assert.equal(first.webhookRegistered, true);

      const [payment] = await cashfreePayments(tx, order.id);
      assert.equal(payment.method, PaymentMethod.PAYMENT_LINK);
      assert.equal(payment.provider, "Cashfree");
      assert.equal(payment.externalId, first.linkId);
      assert.equal(payment.providerOrderId, first.linkId);

      const sent = calls.create[0];
      assert.equal(sent.request.link_amount, 449);
      assert.equal(sent.request.link_partial_payments, false);
      assert.equal(sent.request.customer_details.customer_phone, "9876500000");
      assert.equal(sent.request.link_notes.crm_payment, payment.id);
      assert.equal(sent.key, payment.id); // idempotency key
      assert.equal(sent.request.link_meta?.notify_url, "https://crm.example.com/api/webhooks/cashfree");

      const again = await svc.createPaymentLink(as(rep, Role.SALESPERSON), order.id);
      assert.equal(again.reused, true);
      assert.equal(again.paymentId, first.paymentId);
      assert.equal(calls.create.length, 1);
      assert.equal((await cashfreePayments(tx, order.id)).length, 1);

      // Audited once, and the link itself never lands in the audit trail.
      const created = await tx.activity.findMany({ where: { orderId: order.id, type: ActivityType.PAYMENT_LINK_CREATED } });
      assert.equal(created.length, 1);
      assert.equal(created[0].actorId, rep.id);
      assert.ok(!JSON.stringify(created[0]).includes("pay.test"));
    });
  });

  it("does not create a payment for an order that is fully paid, cancelled, or for a customer with no mobile", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id);
      const svc = service(runner, fakeApi().api);
      const user = as(rep, Role.SALESPERSON);

      const paid = await makeOrder(tx, lead.id);
      await addPayment(tx, paid.id, { amount: "649.00", externalSource: "SHOPIFY", externalId: uid() });
      await assert.rejects(svc.createPaymentLink(user, paid.id), /no pending amount/);

      const cancelled = await makeOrder(tx, lead.id, { status: OrderStatus.CANCELLED });
      await assert.rejects(svc.createPaymentLink(user, cancelled.id), /cancelled order/);

      const noPhoneLead = await makeLead(tx, rep.id, { mobile: null, normalizedMobile: null });
      const noPhone = await makeOrder(tx, noPhoneLead.id);
      await assert.rejects(svc.createPaymentLink(user, noPhone.id), /10-digit mobile/);

      assert.equal((await cashfreePayments(tx, noPhone.id)).length, 0);
    });
  });

  it("refuses a second link for a different amount until the first is cancelled", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const manager = await makeRep(tx, Role.ADMIN);
      const lead = await makeLead(tx, rep.id);
      const order = await makeOrder(tx, lead.id);
      const svc = service(runner, fakeApi().api);
      const user = as(rep, Role.SALESPERSON);

      const first = await svc.createPaymentLink(user, order.id);
      await addPayment(tx, order.id, { amount: "100.00" }); // the customer paid part some other way; the pending amount is now 549
      await assert.rejects(svc.createPaymentLink(user, order.id), (e: { statusCode: number }) => e.statusCode === 409);

      await svc.cancelPaymentLink(as(manager, Role.ADMIN), first.paymentId);
      const second = await svc.createPaymentLink(user, order.id);
      assert.equal(second.amount, "549.00");
      assert.notEqual(second.paymentId, first.paymentId);
    });
  });

  it("survives a Cashfree outage without duplicating, and recovers a link Cashfree already made", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id);
      const user = as(rep, Role.SALESPERSON);

      // Outage: the payment row is kept (no URL yet); the retry fills in the SAME row.
      const outageOrder = await makeOrder(tx, lead.id);
      const down = fakeApi({ createLink: async () => { throw new ProviderHttpError("CASHFREE", null, "down", true); } });
      await assert.rejects(service(runner, down.api).createPaymentLink(user, outageOrder.id), (e: { statusCode: number }) => e.statusCode === 502);
      let rows = await cashfreePayments(tx, outageOrder.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].paymentUrl, null);
      assert.equal(rows[0].status, PaymentStatus.PENDING);

      const working = fakeApi();
      const result = await service(runner, working.api).createPaymentLink(user, outageOrder.id);
      rows = await cashfreePayments(tx, outageOrder.id);
      assert.equal(rows.length, 1);
      assert.equal(result.paymentId, rows[0].id);
      assert.ok(rows[0].paymentUrl);
      assert.equal(working.calls.create[0].key, rows[0].id); // same idempotency key as the failed attempt would have used

      // Cashfree already has this link id (an earlier attempt got through): read it back instead of failing.
      const dupOrder = await makeOrder(tx, lead.id);
      const dup = fakeApi({ createLink: async () => { throw new ProviderHttpError("CASHFREE", 409, "link already exists", false); } });
      const recovered = await service(runner, dup.api).createPaymentLink(user, dupOrder.id);
      assert.ok(recovered.paymentUrl);
      assert.equal(dup.calls.get.length, 1);
      assert.equal((await cashfreePayments(tx, dupOrder.id)).length, 1);
    });
  });

  it("marks the payment failed when Cashfree definitively refuses, and allows a fresh attempt", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id);
      const order = await makeOrder(tx, lead.id);
      const user = as(rep, Role.SALESPERSON);
      const refuse = fakeApi({ createLink: async () => { throw new ProviderHttpError("CASHFREE", 400, "link_amount invalid", false); } });
      await assert.rejects(service(runner, refuse.api).createPaymentLink(user, order.id), /rejected the payment link/);
      const [failed] = await cashfreePayments(tx, order.id);
      assert.equal(failed.status, PaymentStatus.FAILED);

      await service(runner, fakeApi().api).createPaymentLink(user, order.id);
      assert.equal((await cashfreePayments(tx, order.id)).length, 2);
    });
  });

  it("closes a link that lapsed unnoticed before making a new one", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id);
      const order = await makeOrder(tx, lead.id);
      const user = as(rep, Role.SALESPERSON);
      const t0 = new Date("2026-09-21T10:00:00Z");
      const first = await service(runner, fakeApi().api, { now: () => t0 }).createPaymentLink(user, order.id);
      const later = new Date(t0.getTime() + 100 * 3_600_000); // past the default 72h expiry
      const second = await service(runner, fakeApi().api, { now: () => later }).createPaymentLink(user, order.id);
      assert.notEqual(second.paymentId, first.paymentId);
      const old = await tx.payment.findUniqueOrThrow({ where: { id: first.paymentId } });
      assert.equal(old.status, PaymentStatus.FAILED);
      assert.match(old.failureReason ?? "", /expired/i);
    });
  });

  it("is scoped: someone else's order looks like it does not exist", async () => {
    await inRollback(async (tx, runner) => {
      const owner = await makeRep(tx);
      const stranger = await makeRep(tx);
      const lead = await makeLead(tx, owner.id);
      const order = await makeOrder(tx, lead.id);
      const svc = service(runner, fakeApi().api);
      await assert.rejects(svc.createPaymentLink(as(stranger, Role.SALESPERSON), order.id), /Order not found/);
      assert.equal((await cashfreePayments(tx, order.id)).length, 0);
      const admin = await makeRep(tx, Role.ADMIN);
      assert.ok((await svc.createPaymentLink(as(admin, Role.ADMIN), order.id)).paymentUrl);
    });
  });
});

describe("Cashfree webhooks", () => {
  async function linkedOrder(tx: Db, runner: TxRunner, total = "649.00") {
    const rep = await makeRep(tx);
    const lead = await makeLead(tx, rep.id);
    const order = await makeOrder(tx, lead.id, { totalAmount: total });
    const result = await service(runner, fakeApi().api).createPaymentLink(as(rep, Role.SALESPERSON), order.id);
    return { rep, lead, order, link: result };
  }

  it("settles the payment once, records who did it, and shows in reconciliation exactly once", async () => {
    await inRollback(async (tx, runner) => {
      const { rep, order, link } = await linkedOrder(tx, runner);
      const first = await deliver(tx, runner, linkPaid(link.linkId));
      assert.equal(first.outcome, "processed");

      const [payment] = await cashfreePayments(tx, order.id);
      assert.equal(payment.status, PaymentStatus.SUCCESS);
      assert.ok(payment.paidAt);
      assert.equal(payment.amount.toString(), "649");

      const changed = await tx.activity.findMany({ where: { orderId: order.id, type: ActivityType.PAYMENT_STATUS_CHANGED } });
      assert.equal(changed.length, 1);
      assert.equal(changed[0].source, ActivitySource.CASHFREE_WEBHOOK);
      assert.equal(changed[0].actorId, null);

      // The same event arriving again (different delivery id) changes nothing and adds no second audit row.
      const replay = await deliver(tx, runner, linkPaid(link.linkId));
      assert.equal(replay.outcome, "processed");
      assert.equal((await tx.activity.count({ where: { orderId: order.id, type: ActivityType.PAYMENT_STATUS_CHANGED } })), 1);
      assert.equal((await cashfreePayments(tx, order.id)).length, 1);

      const report = await new ReconciliationService(tx).getReconciliation(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20 });
      const row = report.items.find((r) => r.id === order.id)!;
      assert.equal(row.paidAmount, "649.00");
      assert.equal(row.outstandingAmount, "0.00");
      assert.equal(row.reconciliationStatus, "PAID");
      assert.equal(row.paymentProvider, "Cashfree");
    });
  });

  it("never lets a late failure, expiry or drop undo a successful payment", async () => {
    await inRollback(async (tx, runner) => {
      const { order, link } = await linkedOrder(tx, runner);
      await deliver(tx, runner, linkPaid(link.linkId));
      await deliver(tx, runner, { type: "PAYMENT_LINK_EVENT", data: { link_id: link.linkId, link_status: "EXPIRED" } });
      await deliver(tx, runner, { type: "PAYMENT_LINK_EVENT", data: { link_id: link.linkId, link_status: "CANCELLED" } });
      await deliver(tx, runner, { type: "PAYMENT_FAILED_WEBHOOK", data: { order: { order_id: "x", order_tags: { crm_payment: link.paymentId } }, payment: { cf_payment_id: 1, payment_status: "FAILED", payment_message: "late" } } });
      const [payment] = await cashfreePayments(tx, order.id);
      assert.equal(payment.status, PaymentStatus.SUCCESS);
      assert.equal(payment.failureReason, null);
    });
  });

  it("uses the payment webhook's details: real method, Cashfree payment id and bank reference", async () => {
    await inRollback(async (tx, runner) => {
      const { order, link } = await linkedOrder(tx, runner);
      const { outcome } = await deliver(tx, runner, {
        type: "PAYMENT_SUCCESS_WEBHOOK",
        data: {
          order: { order_id: "CFPay_1", order_tags: { crm_payment: link.paymentId } },
          payment: { cf_payment_id: 5551234, payment_status: "SUCCESS", payment_amount: 649, payment_time: "2026-09-21T10:00:00+05:30", bank_reference: "BANKREF1", payment_group: "upi" },
        },
      });
      assert.equal(outcome, "processed");
      const [payment] = await cashfreePayments(tx, order.id);
      assert.equal(payment.status, PaymentStatus.SUCCESS);
      assert.equal(payment.method, PaymentMethod.UPI);
      assert.equal(payment.providerPaymentId, "5551234");
      assert.equal(payment.transactionReference, "BANKREF1");
    });
  });

  it("keeps a link payable after a failed attempt, and closes it when it expires or is cancelled", async () => {
    await inRollback(async (tx, runner) => {
      const { order, link } = await linkedOrder(tx, runner);
      await deliver(tx, runner, { type: "PAYMENT_FAILED_WEBHOOK", data: { order: { order_id: "o1", order_tags: { crm_payment: link.paymentId } }, payment: { cf_payment_id: 9, payment_status: "FAILED", payment_message: "Bank declined" } } });
      let [payment] = await cashfreePayments(tx, order.id);
      assert.equal(payment.status, PaymentStatus.PENDING); // the customer can still pay through the same link
      assert.match(JSON.stringify(payment.metadata), /Bank declined/);

      await deliver(tx, runner, { type: "PAYMENT_LINK_EVENT", data: { link_id: link.linkId, link_status: "EXPIRED" } });
      [payment] = await cashfreePayments(tx, order.id);
      assert.equal(payment.status, PaymentStatus.FAILED);
      assert.match(payment.failureReason ?? "", /expired/i);
    });
  });

  it("stores the amount Cashfree actually reports, and flags it when it differs from the link", async () => {
    await inRollback(async (tx, runner) => {
      const { order, link } = await linkedOrder(tx, runner);
      await deliver(tx, runner, linkPaid(link.linkId, "500.00"));
      const [payment] = await cashfreePayments(tx, order.id);
      assert.equal(payment.status, PaymentStatus.SUCCESS);
      assert.equal(payment.amount.toString(), "500");
      assert.ok((await activityTypes(tx, order.id)).includes(ActivityType.PAYMENT_MISMATCH_DETECTED));
    });
  });

  it("reports over-collection instead of hiding it when the order was also paid another way", async () => {
    await inRollback(async (tx, runner) => {
      const { rep, order, link } = await linkedOrder(tx, runner);
      await addPayment(tx, order.id, { amount: "649.00", externalSource: "SHOPIFY", externalId: uid(), provider: "Cashfree" }); // paid through Shopify while the link was open
      await deliver(tx, runner, linkPaid(link.linkId));
      const report = await new ReconciliationService(tx).getReconciliation(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20 });
      assert.equal(report.items.find((r) => r.id === order.id)!.reconciliationStatus, "PAYMENT_MISMATCH");
      assert.ok((await activityTypes(tx, order.id)).includes(ActivityType.PAYMENT_MISMATCH_DETECTED));
    });
  });

  it("never turns a delivery into a payment: one that matches nothing is ignored, and Shopify-derived payments are untouched", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id);
      const order = await makeOrder(tx, lead.id);
      const shopifyPayment = await addPayment(tx, order.id, { amount: "649.00", externalSource: "SHOPIFY", externalId: "shopify-tx-1", provider: "Cashfree", providerPaymentId: "5551234", providerOrderId: "CFPay_shopify" });

      const { outcome, row } = await deliver(tx, runner, {
        type: "PAYMENT_SUCCESS_WEBHOOK",
        data: { order: { order_id: "CFPay_shopify" }, payment: { cf_payment_id: 5551234, payment_status: "SUCCESS", payment_amount: 649, payment_group: "upi" } },
      });
      assert.equal(outcome, "ignored");
      assert.equal(row.status, "IGNORED");
      assert.equal(await tx.payment.count({ where: { orderId: order.id } }), 1);
      const untouched = await tx.payment.findUniqueOrThrow({ where: { id: shopifyPayment.id } });
      assert.equal(untouched.externalSource, "SHOPIFY");
      assert.equal(untouched.status, PaymentStatus.SUCCESS);
      assert.equal(await tx.activity.count({ where: { orderId: order.id } }), 0);
    });
  });
});

describe("refreshing and cancelling a link", () => {
  it("reads the link from Cashfree and settles the payment; an active link stays open", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id);
      const order = await makeOrder(tx, lead.id);
      const user = as(rep, Role.SALESPERSON);
      const fake = fakeApi();
      const svc = service(runner, fake.api);
      const created = await svc.createPaymentLink(user, order.id);

      assert.equal((await svc.refreshPaymentLink(user, created.paymentId)).status, PaymentStatus.PENDING);

      const paid = service(runner, fakeApi({ getLink: async (id) => fake.link(id, { linkStatus: "PAID", linkAmountPaid: "649.00" }) }).api);
      const result = await paid.refreshPaymentLink(user, created.paymentId);
      assert.equal(result.status, PaymentStatus.SUCCESS);
      const activity = await tx.activity.findFirstOrThrow({ where: { orderId: order.id, type: ActivityType.PAYMENT_STATUS_CHANGED } });
      assert.equal(activity.source, ActivitySource.USER);
      assert.equal(activity.actorId, rep.id);
    });
  });

  it("cancels an unpaid link, audits it, and refuses to cancel one that is already paid", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const admin = await makeRep(tx, Role.ADMIN);
      const lead = await makeLead(tx, rep.id);
      const order = await makeOrder(tx, lead.id);
      const fake = fakeApi();
      const svc = service(runner, fake.api);
      const created = await svc.createPaymentLink(as(rep, Role.SALESPERSON), order.id);

      const cancelled = await svc.cancelPaymentLink(as(admin, Role.ADMIN), created.paymentId);
      assert.equal(cancelled.status, PaymentStatus.FAILED);
      assert.deepEqual(fake.calls.cancel, [created.linkId]);
      assert.ok((await activityTypes(tx, order.id)).includes(ActivityType.PAYMENT_LINK_CANCELLED));

      await assert.rejects(svc.cancelPaymentLink(as(admin, Role.ADMIN), created.paymentId), (e: { statusCode: number }) => e.statusCode === 409);
      assert.equal(fake.calls.cancel.length, 1); // Cashfree was not asked again
    });
  });
});

describe("Shopify sync alongside a payment link", () => {
  function shopifyNode(id: string, extra: Record<string, unknown> = {}) {
    const digits = () => Array.from({ length: 11 }, () => randomInt(0, 10)).join("");
    const productId = `9${digits()}`;
    return {
      ...codOrderNode(),
      id: `gid://shopify/Order/${id}`,
      name: `#DB${id.slice(-7)}`,
      updatedAt: "2026-09-19T10:05:00Z",
      email: null,
      phone: `5${digits().slice(0, 9)}`,
      customer: null,
      shippingAddress: { ...(orderNode().shippingAddress as Record<string, unknown>), phone: null },
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [rawLineItem({ id: `gid://shopify/LineItem/${id}1`, product: { id: `gid://shopify/Product/${productId}` }, variant: { id: `gid://shopify/ProductVariant/9${digits()}` } })] },
      transactions: [rawTransaction({ id: `gid://shopify/OrderTransaction/${id}1`, gateway: "Cash on Delivery (COD)", status: "PENDING", amountSet: money("699.0"), paymentId: `cod_${id}` })],
      ...extra,
    };
  }

  it("re-syncing the Shopify order neither deletes nor overwrites the Cashfree payment, and nothing is double counted", async () => {
    await inRollback(async (tx, runner) => {
      const id = `9${Array.from({ length: 11 }, () => randomInt(0, 10)).join("")}`;
      const { mapOrder } = await import("../shopify/shopify.mapper.js");
      // The Shopify-tagged order is created directly, so the sync takes its "existing order" path. (Importing a brand-new
      // order goes through resolveLead, which reads Lead without a select and so needs the unapplied lead-import columns.)
      const admin = await makeRep(tx, Role.ADMIN);
      const lead = await makeLead(tx, admin.id);
      const seeded = await tx.order.create({ data: { orderNumber: `SHP-${id}`, leadId: lead.id, source: OrderSource.SHOPIFY, status: OrderStatus.CONFIRMED, totalAmount: "699.00", externalSource: "SHOPIFY", externalId: id }, select: { id: true } });
      const first = await upsertOrder(tx, mapOrder(normalized(shopifyNode(id))), { force: true });
      const orderId = first.orderId!;
      assert.equal(orderId, seeded.id);
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, totalAmount: true } });

      const svc = service(runner, fakeApi().api);
      const link = await svc.createPaymentLink(as(admin, Role.ADMIN), orderId);
      assert.equal(link.amount, order.totalAmount.toFixed(2)); // COD: the whole amount is still pending
      await deliver(tx, runner, linkPaid(link.linkId, order.totalAmount.toFixed(2)));

      // Shopify reports the order again, changed: its own payment rows are re-synced, the Cashfree one is not its business.
      await upsertOrder(tx, mapOrder(normalized(shopifyNode(id, { updatedAt: "2026-09-21T10:05:00Z" }))), { force: true });

      const payments = await tx.payment.findMany({ where: { orderId }, select: { externalSource: true, status: true } });
      assert.equal(payments.filter((p) => p.externalSource === "CASHFREE").length, 1);
      assert.equal(payments.find((p) => p.externalSource === "CASHFREE")!.status, PaymentStatus.SUCCESS);
      assert.equal(payments.filter((p) => p.externalSource === "SHOPIFY").length, 1);

      // Even if Shopify stops reporting ANY transaction, the Cashfree payment survives untouched. (Shopify's own row is
      // replaced by its pending-COD placeholder - that is Shopify's to manage, and the sync only ever deletes its own.)
      await upsertOrder(tx, mapOrder(normalized(shopifyNode(id, { updatedAt: "2026-09-22T10:05:00Z", transactions: [] }))), { force: true });
      const after = await tx.payment.findMany({ where: { orderId }, select: { externalSource: true, status: true, amount: true } });
      const cashfree = after.filter((p) => p.externalSource === "CASHFREE");
      assert.equal(cashfree.length, 1);
      assert.equal(cashfree[0].status, PaymentStatus.SUCCESS);
      assert.equal(cashfree[0].amount.toFixed(2), order.totalAmount.toFixed(2));
    });
  });
});

describe("sending the payment link through WhatsApp", () => {
  const provider = (sent: { params: string[]; to: string }[]): WhatsAppProvider => ({
    id: "AISENSY",
    sendTemplateMessage: async (input) => {
      sent.push({ params: input.params, to: input.to });
      return { providerMessageId: `wamid-${uid()}`, raw: {} };
    },
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "n/a" }),
  });
  const template = (tx: Db, variables: string[]) =>
    tx.whatsAppTemplate.create({ data: { name: `t_${uid()}`, provider: "AISENSY", language: "en", body: variables.map((v) => `{{${v}}}`).join(" "), variables, status: WhatsAppTemplateStatus.APPROVED }, select: { id: true } });

  it("delivers the customer's real link and amount through the existing E7.3 sender", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const lead = await makeLead(tx, rep.id, { normalizedMobile: "+919876543210" });
      const order = await makeOrder(tx, lead.id);
      const user = as(rep, Role.SALESPERSON);
      const sent: { params: string[]; to: string }[] = [];
      const svc = service(runner, fakeApi().api, { messaging: () => new WhatsAppMessagingService(tx, () => provider(sent)) });

      const link = await svc.createPaymentLink(user, order.id);
      const t = await template(tx, ["customer_name", "payment_amount", "payment_link"]);
      const message = await svc.sendPaymentLinkWhatsApp(user, link.paymentId, t.id);

      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].params, ["Priya Shah", "₹649.00", link.paymentUrl]);
      assert.equal(message.orderId, order.id);
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 1);
    });
  });

  it("refuses a template without {{payment_link}}, a link that is no longer open, and someone else's payment", async () => {
    await inRollback(async (tx, runner) => {
      const rep = await makeRep(tx);
      const stranger = await makeRep(tx);
      const lead = await makeLead(tx, rep.id, { normalizedMobile: "+919876543210" });
      const order = await makeOrder(tx, lead.id);
      const user = as(rep, Role.SALESPERSON);
      const sent: { params: string[]; to: string }[] = [];
      const svc = service(runner, fakeApi().api, { messaging: () => new WhatsAppMessagingService(tx, () => provider(sent)) });
      const link = await svc.createPaymentLink(user, order.id);

      const plain = await template(tx, ["customer_name"]);
      await assert.rejects(svc.sendPaymentLinkWhatsApp(user, link.paymentId, plain.id), /payment_link/);

      const good = await template(tx, ["payment_link"]);
      await assert.rejects(svc.sendPaymentLinkWhatsApp(as(stranger, Role.SALESPERSON), link.paymentId, good.id), /Payment not found/);

      await deliver(tx, runner, linkPaid(link.linkId));
      await assert.rejects(svc.sendPaymentLinkWhatsApp(user, link.paymentId, good.id), /no open payment link/);
      assert.equal(sent.length, 0);
    });
  });
});
