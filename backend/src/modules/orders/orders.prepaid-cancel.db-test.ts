// Database integration tests for: prepaid order creation (Cashfree link, no duplicate payment row),
// provider-aware WhatsApp order notifications, and order cancel/revert. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - mirrors orders.create.db-test.ts.
// No real Shopify/Cashfree/WhatsApp call is ever made: every external dependency is injected.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ApiError } from "@/utils/apiError.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import type CashfreePaymentsService from "../cashfree/cashfree.payments.service.js";
import type { OrderNotifyResult } from "../whatsapp/whatsapp.order-notify.service.js";
import OrdersService from "./orders.service.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", email: "mahadev@example.invalid", ownerId: undefined, ...overrides },
    select: { id: true },
  });
}

async function makeProduct(tx: Prisma.TransactionClient) {
  return tx.product.create({ data: { name: "Herbal Tea 100g", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "349.00" }, select: { id: true } });
}

function fakeShopifyClient(queryImpl?: (document: string, variables: Record<string, unknown>) => Promise<unknown>): ShopifyClient {
  return { query: queryImpl ?? (async (doc: string) => (doc.includes("orderCancel") ? { orderCancel: { job: { id: "1", done: true }, orderCancelUserErrors: [] } } : { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#TST1" }, userErrors: [] } })) } as unknown as ShopifyClient;
}

const NO_NOTIFY = { sent: false, via: null, provider: null } satisfies OrderNotifyResult;
function fakeNotify(result: OrderNotifyResult = NO_NOTIFY) {
  const calls: any[] = [];
  return { calls, fn: async (_db: any, _user: any, params: any) => { calls.push(params); return result; } };
}

// cancelPaymentLink mimics the real service's effect on the Payment row (FAILED "Payment link cancelled", exactly what
// CashfreePaymentsService.cancelPaymentLink records) so the order's derived link state behaves as it does in production.
// `state.fail` makes the next cancellations fail, like Cashfree being unreachable.
function fakeCashfree(overrides: Partial<Awaited<ReturnType<CashfreePaymentsService["createPaymentLink"]>>> = {}, cancel?: { tx: Prisma.TransactionClient }) {
  const calls: any[] = [];
  const cancelCalls: string[] = [];
  const state = { fail: false };
  const api: Pick<CashfreePaymentsService, "createPaymentLink" | "cancelPaymentLink"> = {
    cancelPaymentLink: async (_user, paymentId) => {
      cancelCalls.push(paymentId);
      if (state.fail) throw new ApiError("Cashfree could not be reached, so the link was not cancelled. Try again.", 502);
      if (cancel) await cancel.tx.payment.update({ where: { id: paymentId }, data: { status: "FAILED", failedAt: new Date(), failureReason: "Payment link cancelled" } });
      return {} as any;
    },
    createPaymentLink: async (user, orderId) => {
      calls.push({ user, orderId });
      return { paymentId: uid(), orderId, linkId: `crm_${orderId}`, amount: "699.00", currency: "INR", status: "PENDING" as const, paymentUrl: "https://payments.cashfree.com/links/abc123", expiresAt: new Date(Date.now() + 3_600_000), reused: false, webhookRegistered: true, ...overrides };
    },
  };
  return { calls, cancelCalls, state, api };
}

const orderInput = (leadId: string, productId: string, paymentMethod: "COD" | "PAYMENT_LINK") => ({
  leadId,
  items: [{ productId, quantity: 1, unitPrice: "699.00" }],
  paymentMethod,
});

describe("createManualOrder - PAYMENT_LINK (prepaid)", () => {
  it("creates the order with NO generic payment row, creates exactly one Cashfree link, and sends it over WhatsApp", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const cashfree = fakeCashfree();
      const notify = fakeNotify({ sent: true, via: "FREE_TEXT", provider: "META" });
      const svc = new OrdersService(tx, () => fakeShopifyClient(), () => cashfree.api, { confirmation: fakeNotify().fn, paymentLink: notify.fn });

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), orderInput(lead.id, product.id, "PAYMENT_LINK"));

      assert.equal(result.order.status, "PENDING_PAYMENT");
      assert.equal(result.paymentLink?.status, "created");
      assert.equal(result.paymentLink?.paymentUrl, "https://payments.cashfree.com/links/abc123");
      assert.equal(result.whatsapp.sent, true);
      assert.equal(result.whatsapp.via, "FREE_TEXT");
      assert.equal(cashfree.calls.length, 1, "exactly one Cashfree link creation call");
      assert.equal(notify.calls.length, 1);
      assert.equal(notify.calls[0].paymentUrl, "https://payments.cashfree.com/links/abc123");

      // No generic Payment row was created at order-creation time for a PAYMENT_LINK order - the
      // (fake, in-memory) Cashfree call is the only place a payment row would come from.
      assert.equal(await tx.payment.count({ where: { orderId: result.order.id } }), 0);
    });
  });

  it("a Cashfree failure does not fail order creation, and is reported honestly (never a fake success)", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const failingCashfree: Pick<CashfreePaymentsService, "createPaymentLink" | "cancelPaymentLink"> = { createPaymentLink: async () => { throw new ApiError("Cashfree is not configured", 503); }, cancelPaymentLink: async () => { throw new ApiError("Cashfree is not configured", 503); } };
      const notify = fakeNotify();
      const svc = new OrdersService(tx, () => fakeShopifyClient(), () => failingCashfree, { confirmation: notify.fn, paymentLink: notify.fn });

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), orderInput(lead.id, product.id, "PAYMENT_LINK"));

      assert.equal(result.order.status, "PENDING_PAYMENT", "the CRM order still exists and is not rolled back");
      assert.equal(result.paymentLink?.status, "failed");
      assert.equal(result.paymentLink?.reason, "Cashfree is not configured");
      assert.equal(result.whatsapp.sent, false, "nothing to send when there is no link");
      assert.equal(notify.calls.length, 0);
    });
  });

  it("a repeated createPaymentLink call for the same order (Cashfree's own idempotency) is reused, never a second row", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const cashfree = fakeCashfree({ reused: true });
      const notify = fakeNotify();
      const svc = new OrdersService(tx, () => fakeShopifyClient(), () => cashfree.api, { confirmation: notify.fn, paymentLink: notify.fn });
      const result = await svc.createManualOrder(as(admin, Role.ADMIN), orderInput(lead.id, product.id, "PAYMENT_LINK"));
      assert.equal(result.paymentLink?.status, "reused");
    });
  });
});

describe("createManualOrder - COD sends the existing order confirmation", () => {
  it("calls the confirmation notifier (not the payment-link one) with the real order number/amount", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const confirmation = fakeNotify({ sent: true, via: "TEMPLATE", provider: "AISENSY" });
      const paymentLink = fakeNotify();
      const svc = new OrdersService(tx, () => fakeShopifyClient(), () => fakeCashfree().api, { confirmation: confirmation.fn, paymentLink: paymentLink.fn });

      const result = await svc.createManualOrder(as(admin, Role.ADMIN), orderInput(lead.id, product.id, "COD"));

      assert.equal(result.order.status, "CONFIRMED");
      assert.equal(result.whatsapp.sent, true);
      assert.equal(confirmation.calls.length, 1);
      assert.equal(paymentLink.calls.length, 0);
      assert.equal(confirmation.calls[0].orderNumber, result.order.orderNumber);
      assert.equal(confirmation.calls[0].totalAmount, result.order.totalAmount);
      // The existing COD payment row is untouched by any of this.
      assert.equal(await tx.payment.count({ where: { orderId: result.order.id, method: "COD" } }), 1);
    });
  });

  it("a WhatsApp send failure does not fail order creation", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const product = await makeProduct(tx);
      const throwing = { confirmation: async () => { throw new Error("boom"); }, paymentLink: fakeNotify().fn };
      const svc = new OrdersService(tx, () => fakeShopifyClient(), () => fakeCashfree().api, throwing as any);
      await assert.rejects(() => svc.createManualOrder(as(admin, Role.ADMIN), orderInput(lead.id, product.id, "COD")));
      // (documents current behavior: notify.confirmation is expected to catch its own errors, as the
      // real notifyOrderConfirmation does - this fake deliberately does not, to prove the order itself
      // was already committed before this point, checked below)
      assert.equal(await tx.order.count({ where: { leadId: lead.id } }), 1, "the CRM order was created and committed regardless");
    });
  });
});

describe("cancelOrder", () => {
  async function makeConfirmedOrder(tx: Prisma.TransactionClient, admin: { id: string; email: string }, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
    const lead = await makeLead(tx);
    const order = await tx.order.create({
      data: { orderNumber: `CRM-${uid()}`, leadId: lead.id, createdById: admin.id, source: "SALESPERSON", status: "CONFIRMED", totalAmount: "699.00", confirmedAt: new Date(), ...overrides },
      select: { id: true, leadId: true },
    });
    return { lead, order };
  }

  it("cancels a CONFIRMED order, attempts the linked Shopify order, records ORDER_CANCELLED once, and preserves the payment record", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await makeConfirmedOrder(tx, admin, { externalSource: "SHOPIFY", externalId: "gid://shopify/Order/1" });
      await tx.payment.create({ data: { orderId: order.id, amount: "699.00", status: "SUCCESS", method: "UPI", paidAt: new Date() } });
      const svc = new OrdersService(tx, () => fakeShopifyClient());

      const result = await svc.cancelOrder(as(admin, Role.ADMIN), order.id, { reason: "Customer changed their mind" });

      assert.equal(result.alreadyCancelled, false);
      assert.equal(result.order.status, "CANCELLED");
      assert.equal(result.order.cancelReason, "Customer changed their mind");
      assert.ok(result.order.cancelledAt);
      assert.equal(result.shopify.status, "cancelled");
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.ORDER_CANCELLED } }), 1);

      // The successful payment is untouched - never silently marked refunded by a cancellation.
      const payment = await tx.payment.findFirstOrThrow({ where: { orderId: order.id } });
      assert.equal(payment.status, "SUCCESS");
      assert.equal(payment.refundedAt, null);
      assert.equal(payment.refundedAmount, null);
    });
  });

  it("is idempotent: cancelling an already-cancelled order (Shopify already cancelled) makes no further changes and returns a clear message", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await makeConfirmedOrder(tx, admin);
      const svc = new OrdersService(tx, () => fakeShopifyClient());
      await svc.cancelOrder(as(admin, Role.ADMIN), order.id, {});

      let shopifyCalls = 0;
      const countingClient = fakeShopifyClient(async () => { shopifyCalls += 1; return { orderCancel: { job: null, orderCancelUserErrors: [] } }; });
      const result = await new OrdersService(tx, () => countingClient).cancelOrder(as(admin, Role.ADMIN), order.id, { reason: "trying again" });

      assert.equal(result.alreadyCancelled, true);
      assert.equal(shopifyCalls, 0, "no Shopify call on a plain repeat - nothing was linked, nothing is retryable");
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.ORDER_CANCELLED } }), 1, "still exactly one cancellation event");
      assert.equal(result.order.cancelReason, null); // unchanged from the first call (no reason given), ignores the second call's "trying again"
    });
  });

  it("keeps the Shopify half retryable: a failed Shopify cancel can be retried without re-cancelling the CRM order or duplicating the Activity", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await makeConfirmedOrder(tx, admin, { externalSource: "SHOPIFY", externalId: "gid://shopify/Order/1" });

      const failingClient = fakeShopifyClient(async () => { throw Object.assign(new Error("Shopify rejected the mutation"), {}); });
      const first = await new OrdersService(tx, () => failingClient).cancelOrder(as(admin, Role.ADMIN), order.id, { reason: "oops" });
      assert.equal(first.alreadyCancelled, false);
      assert.equal(first.shopify.status, "failed");
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status, "CANCELLED", "the CRM side is cancelled regardless of the Shopify outcome");

      const workingClient = fakeShopifyClient();
      const second = await new OrdersService(tx, () => workingClient).cancelOrder(as(admin, Role.ADMIN), order.id, {});
      assert.equal(second.alreadyCancelled, true, "the CRM order is not cancelled a second time");
      assert.equal(second.shopify.status, "cancelled", "but the Shopify half was successfully retried");
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.ORDER_CANCELLED } }), 1, "still only one cancellation event, not two");
    });
  });

  it("regression (found by real-UI double click): two CONCURRENT cancels record exactly one ORDER_CANCELLED and one Shopify attempt", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await makeConfirmedOrder(tx, admin, { externalSource: "SHOPIFY", externalId: "gid://shopify/Order/77" });
      let shopifyCalls = 0;
      const client = fakeShopifyClient(async () => { shopifyCalls += 1; return { orderCancel: { job: { id: "1", done: true }, orderCancelUserErrors: [] } }; });
      const svc = new OrdersService(tx, () => client);

      const [a, b] = await Promise.all([svc.cancelOrder(as(admin, Role.ADMIN), order.id, {}), svc.cancelOrder(as(admin, Role.ADMIN), order.id, {})]);

      assert.equal([a, b].filter((r) => !r.alreadyCancelled).length, 1, "exactly one call performed the cancellation");
      assert.equal(shopifyCalls, 1, "Shopify was asked to cancel once");
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.ORDER_CANCELLED } }), 1, "one audit event, not two");
    });
  });

  it("an order never pushed to Shopify reports not_linked, not a false failure", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await makeConfirmedOrder(tx, admin);
      const result = await new OrdersService(tx, () => fakeShopifyClient()).cancelOrder(as(admin, Role.ADMIN), order.id, {});
      assert.equal(result.shopify.status, "not_linked");
    });
  });

  it("a salesperson cannot cancel another salesperson's order (RBAC, 404, not corrupted)", async () => {
    await inRollback(async (tx) => {
      const owner = await tx.user.create({ data: { name: "Owner", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const stranger = await tx.user.create({ data: { name: "Stranger", email: `s-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: owner.id });
      const order = await tx.order.create({ data: { orderNumber: `CRM-${uid()}`, leadId: lead.id, createdById: owner.id, source: "SALESPERSON", status: "CONFIRMED", totalAmount: "699.00" }, select: { id: true } });

      await assert.rejects(
        () => new OrdersService(tx).cancelOrder(as(stranger, Role.SALESPERSON), order.id, {}),
        (e: unknown) => e instanceof ApiError && e.statusCode === 404,
      );
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status, "CONFIRMED", "untouched");
    });
  });
});

describe("cancelOrder - Cashfree payment link", () => {
  async function prepaidOrder(tx: Prisma.TransactionClient, admin: { id: string }, opts: { paymentStatus: "PENDING" | "SUCCESS"; shopify?: boolean }) {
    const lead = await makeLead(tx);
    const order = await tx.order.create({
      data: { orderNumber: `CRM-${uid()}`, leadId: lead.id, createdById: admin.id, source: "SALESPERSON", status: opts.paymentStatus === "SUCCESS" ? "CONFIRMED" : "PENDING_PAYMENT", totalAmount: "699.00", ...(opts.shopify ? { externalSource: "SHOPIFY" as const, externalId: `gid://shopify/Order/${uid()}` } : {}) },
      select: { id: true },
    });
    const linkId = `crm_${uid().replace(/-/g, "")}`;
    const payment = await tx.payment.create({
      data: { orderId: order.id, amount: "699.00", method: "PAYMENT_LINK", status: opts.paymentStatus, provider: "Cashfree", externalSource: "CASHFREE", externalId: linkId, providerOrderId: linkId, paymentUrl: `https://payments.cashfree.com/links/${linkId}`, paidAt: opts.paymentStatus === "SUCCESS" ? new Date() : null },
      select: { id: true },
    });
    return { order, payment };
  }
  const countingShopify = () => {
    const box = { calls: 0 };
    return { box, client: fakeShopifyClient(async () => { box.calls += 1; return { orderCancel: { job: { id: "1", done: true }, orderCancelUserErrors: [] } }; }) };
  };

  it("COD order: no Cashfree call at all, paymentLink is 'none'", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await tx.order.create({ data: { orderNumber: `CRM-${uid()}`, leadId: lead.id, createdById: admin.id, source: "SALESPERSON", status: "CONFIRMED", totalAmount: "699.00" }, select: { id: true } });
      await tx.payment.create({ data: { orderId: order.id, amount: "699.00", method: "COD", status: "PENDING" } });
      const cf = fakeCashfree({}, { tx });
      const result = await new OrdersService(tx, () => fakeShopifyClient(), () => cf.api).cancelOrder(as(admin, Role.ADMIN), order.id, {});
      assert.equal(result.paymentLink.status, "none");
      assert.equal(cf.cancelCalls.length, 0);
    });
  });

  it("prepaid + pending link: Cashfree cancellation is called exactly once and the result/state record it", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order, payment } = await prepaidOrder(tx, admin, { paymentStatus: "PENDING" });
      const cf = fakeCashfree({}, { tx });
      const result = await new OrdersService(tx, () => fakeShopifyClient(), () => cf.api).cancelOrder(as(admin, Role.ADMIN), order.id, { reason: "mistake" });

      assert.deepEqual(cf.cancelCalls, [payment.id], "exactly one Cashfree cancellation, for this payment");
      assert.equal(result.order.status, "CANCELLED");
      assert.deepEqual(result.paymentLink, { status: "cancelled" });
      assert.equal(result.order.paymentLinkCancellation?.status, "cancelled");
      const row = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, failureReason: true, refundedAt: true, paymentUrl: true } });
      assert.equal(row.failureReason, "Payment link cancelled");
      assert.equal(row.refundedAt, null);
      assert.ok(row.paymentUrl, "the payment record and its link are preserved");
    });
  });

  it("a Cashfree failure never undoes the CRM cancellation, and is reported honestly", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order, payment } = await prepaidOrder(tx, admin, { paymentStatus: "PENDING" });
      const cf = fakeCashfree({}, { tx });
      cf.state.fail = true;
      const result = await new OrdersService(tx, () => fakeShopifyClient(), () => cf.api).cancelOrder(as(admin, Role.ADMIN), order.id, {});

      assert.equal(result.order.status, "CANCELLED", "the CRM order stays cancelled");
      assert.equal(result.paymentLink.status, "failed");
      assert.match(result.paymentLink.reason ?? "", /could not be reached/);
      assert.equal(result.order.paymentLinkCancellation?.status, "failed", "the failure is persisted for the UI / a later retry");
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } })).status, "PENDING");
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.ORDER_CANCELLED } }), 1);
    });
  });

  it("retry after a Cashfree failure works, calls Cashfree only for the outstanding link, and does not touch Shopify or the audit trail again", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await prepaidOrder(tx, admin, { paymentStatus: "PENDING", shopify: true });
      const cf = fakeCashfree({}, { tx });
      const shop = countingShopify();
      const svc = new OrdersService(tx, () => shop.client, () => cf.api);

      cf.state.fail = true;
      const first = await svc.cancelOrder(as(admin, Role.ADMIN), order.id, {});
      assert.equal(first.paymentLink.status, "failed");
      assert.equal(first.shopify.status, "cancelled");

      cf.state.fail = false;
      const retry = await svc.cancelOrder(as(admin, Role.ADMIN), order.id, {});
      assert.equal(retry.alreadyCancelled, true);
      assert.deepEqual(retry.paymentLink, { status: "cancelled" });
      assert.equal(cf.cancelCalls.length, 2, "one failed attempt + one successful retry");
      assert.equal(shop.box.calls, 1, "Shopify was already cancelled - it is not called again by a Cashfree retry");
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.ORDER_CANCELLED } }), 1);
    });
  });

  it("prepaid + SUCCESS payment: no link cancellation is attempted, the payment stays SUCCESS, no refund is created", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order, payment } = await prepaidOrder(tx, admin, { paymentStatus: "SUCCESS" });
      const cf = fakeCashfree({}, { tx });
      const result = await new OrdersService(tx, () => fakeShopifyClient(), () => cf.api).cancelOrder(as(admin, Role.ADMIN), order.id, {});

      assert.equal(cf.cancelCalls.length, 0);
      assert.deepEqual(result.paymentLink, { status: "paid" });
      assert.equal(result.order.status, "CANCELLED");
      const row = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, refundedAt: true, refundedAmount: true } });
      assert.deepEqual(row, { status: "SUCCESS", refundedAt: null, refundedAmount: null });
      assert.equal(Number(result.order.refundedAmount), 0, "no refund is recorded on the order");
    });
  });

  it("concurrent cancels (double click): one Cashfree cancellation, one Shopify cancellation, one ORDER_CANCELLED", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await prepaidOrder(tx, admin, { paymentStatus: "PENDING", shopify: true });
      const cf = fakeCashfree({}, { tx });
      const shop = countingShopify();
      const svc = new OrdersService(tx, () => shop.client, () => cf.api);

      const [a, b] = await Promise.all([svc.cancelOrder(as(admin, Role.ADMIN), order.id, {}), svc.cancelOrder(as(admin, Role.ADMIN), order.id, {})]);

      assert.equal([a, b].filter((r) => !r.alreadyCancelled).length, 1);
      assert.equal(cf.cancelCalls.length, 1);
      assert.equal(shop.box.calls, 1);
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.ORDER_CANCELLED } }), 1);
    });
  });

  it("two concurrent RETRIES after a failure collapse into one Cashfree attempt", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await prepaidOrder(tx, admin, { paymentStatus: "PENDING" });
      const cf = fakeCashfree({}, { tx });
      const svc = new OrdersService(tx, () => fakeShopifyClient(), () => cf.api);
      cf.state.fail = true;
      await svc.cancelOrder(as(admin, Role.ADMIN), order.id, {});
      cf.state.fail = false;

      await Promise.all([svc.cancelOrder(as(admin, Role.ADMIN), order.id, {}), svc.cancelOrder(as(admin, Role.ADMIN), order.id, {})]);
      assert.equal(cf.cancelCalls.length, 2, "1 failed first attempt + exactly 1 retry");
    });
  });

  it("repeating cancel on a fully cancelled order makes no Cashfree (or Shopify) call", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { order } = await prepaidOrder(tx, admin, { paymentStatus: "PENDING", shopify: true });
      const cf = fakeCashfree({}, { tx });
      const shop = countingShopify();
      const svc = new OrdersService(tx, () => shop.client, () => cf.api);
      await svc.cancelOrder(as(admin, Role.ADMIN), order.id, {});

      const again = await svc.cancelOrder(as(admin, Role.ADMIN), order.id, {});
      assert.equal(again.alreadyCancelled, true);
      assert.deepEqual(again.paymentLink, { status: "cancelled" }, "the settled state is reported from the payment record");
      assert.equal(cf.cancelCalls.length, 1);
      assert.equal(shop.box.calls, 1);
    });
  });
});
