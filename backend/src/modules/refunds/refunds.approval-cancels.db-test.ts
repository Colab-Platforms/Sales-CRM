// The refund business flow against the real schema: a refund can be REQUESTED on an eligible paid prepaid order while it is still ACTIVE (the request cancels nothing);
// the manager's APPROVAL cancels the order (through the real OrdersService.cancelOrder) and only then records the approval; a failed cancellation means no approval.
// One rolled-back transaction per test; fake Cashfree / Shopify only. Run with: npm run test:db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, RefundExecutionStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "../../lib/leadScope.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import type { CashfreeRefund } from "../cashfree/cashfree.client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "../orders/orders.service.js";
import RefundsService, { loadOrderRefundInfo, type CancelOrderFn } from "./refunds.service.js";
import RefundExecutionService, { type RefundApi } from "./refunds.execution.js";

class Rollback extends Error {}
after(() => prisma.$disconnect());
const uid = () => randomUUID();
const runnerOf = (tx: Db): TxRunner => ({ $transaction: (cb) => cb(tx) });
async function inRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const rejects = (p: Promise<unknown>, status: number, re?: RegExp) => assert.rejects(p, (e: any) => { assert.equal(e.statusCode, status, e.message); if (re) assert.match(e.message, re); return true; });
const SANDBOX = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_ENV: "sandbox", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret-not-real" });

type U = { id: string; username: string; role: Role };
async function actors(tx: Db) {
  const mk = (name: string, role: Role) => tx.user.create({ data: { name, username: `${name.toLowerCase()}-${uid()}`, role }, select: { id: true, username: true } }).then((u) => ({ id: u.id, username: u.username, role }) as U);
  const [sales, manager, admin] = await Promise.all([mk("Tele", Role.SALESPERSON), mk("Mgr", Role.MANAGER), mk("Admin", Role.ADMIN)]);
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: sales.id, joinedAt: new Date(), isActive: true } });
  const source = await tx.source.create({ data: { name: "Website", code: `web-${uid()}` }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Test", sourceId: source.id, ownerId: sales.id, groupId: group.id }, select: { id: true } });
  return { sales, manager, admin, leadId: lead.id };
}
type Actors = Awaited<ReturnType<typeof actors>>;

/** A CRM order (ACTIVE: CONFIRMED by default) with one INR 100 Cashfree payment; override the order / payment per case. */
async function order(tx: Db, a: Actors, opts: { status?: OrderStatus; payment?: Partial<Prisma.PaymentUncheckedCreateInput>; shopifyLinked?: boolean } = {}) {
  const o = await tx.order.create({
    data: { orderNumber: `RC-${uid().slice(0, 8)}`, leadId: a.leadId, source: OrderSource.SALESPERSON, status: opts.status ?? OrderStatus.CONFIRMED, totalAmount: "100.00", ...(opts.shopifyLinked ? { externalSource: "SHOPIFY", externalId: `9${Math.floor(Math.random() * 1e12)}` } : {}) },
    select: { id: true },
  });
  const base: Prisma.PaymentUncheckedCreateInput = { orderId: o.id, amount: "100.00", status: PaymentStatus.SUCCESS, method: PaymentMethod.PAYMENT_LINK, provider: "Cashfree", externalSource: "CASHFREE", externalId: `l_${uid().slice(0, 12)}`, providerPaymentId: "cfpay_flow_1", metadata: { cashfree: { cashfreeOrderId: "CFPay_flow_1" } }, paidAt: new Date() };
  const p = await tx.payment.create({ data: { ...base, ...opts.payment }, select: { id: true } });
  return { orderId: o.id, paymentId: p.id };
}

const fakeShopify = (fail?: string): ShopifyClient => ({ query: async (doc: string) => { if (fail) throw new Error(fail); return doc.includes("orderCancel") ? { orderCancel: { job: { id: "1", done: true }, orderCancelUserErrors: [] } } : {}; } }) as unknown as ShopifyClient;
const noCashfree = { createPaymentLink: async () => { throw new Error("not used"); }, cancelPaymentLink: async () => { throw new Error("not used"); } } as never;
const noNotify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
const ordersFor = (tx: Db, shopifyFail?: string) => new OrdersService(tx as unknown as DbClient, () => fakeShopify(shopifyFail), () => noCashfree, noNotify);
/** The REAL cancellation (OrdersService.cancelOrder) inside the test transaction, with a spy. */
function realCancel(tx: Db, shopifyFail?: string) {
  const calls: { orderId: string; reason: string }[] = [];
  const fn: CancelOrderFn = async (user, orderId, reason) => { calls.push({ orderId, reason }); return ordersFor(tx, shopifyFail).cancelOrder(user as never, orderId, { reason }) as never; };
  return { fn, calls };
}
const svc = (tx: Db, cancelOrder: CancelOrderFn) => new RefundsService(runnerOf(tx), { cancelOrder });
const ask = (s: RefundsService, user: U, o: { orderId: string; paymentId: string }, amount = "100") => s.createRequest(user, o.orderId, { paymentId: o.paymentId, amount, reason: "Customer asked for a refund" });
const status = async (tx: Db, orderId: string) => (await tx.order.findUniqueOrThrow({ where: { id: orderId } })).status;
const events = async (tx: Db, orderId: string) => (await tx.activity.findMany({ where: { orderId }, orderBy: { createdAt: "asc" }, select: { type: true, actorId: true, createdAt: true, title: true } }));
const count = (evts: Awaited<ReturnType<typeof events>>, type: ActivityType) => evts.filter((e) => e.type === type).length;
const answer = (over: Partial<CashfreeRefund> = {}): CashfreeRefund => ({ cfRefundId: "CFR-1", refundId: "x", orderId: "CFPay_flow_1", refundStatus: "PENDING", refundAmount: "100", refundCurrency: "INR", statusDescription: null, refundArn: null, processedAt: null, ...over });

describe("BEFORE the request: an eligible paid prepaid order is refundable while still ACTIVE", () => {
  it("the Refund action is available on a CONFIRMED order, and requesting it cancels nothing (telecaller, manager and admin alike)", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const spy = realCancel(tx);
      const s = svc(tx, spy.fn);
      const o = await order(tx, a);
      const view = (await loadOrderRefundInfo(tx, o.orderId)).payments[0]!;
      assert.deepEqual([view.eligible, view.refundableAmount, view.ineligibleReason], [true, "100.00", null]);
      const req = await ask(s, a.sales, o, "40");
      assert.equal(req.status, RefundRequestStatus.PENDING);
      assert.equal(await status(tx, o.orderId), OrderStatus.CONFIRMED, "the order is NOT cancelled by the request");
      assert.equal(spy.calls.length, 0);
      assert.equal(req.orderStatus, OrderStatus.CONFIRMED);
      for (const user of [a.manager, a.admin]) assert.equal((await ask(s, user, o, "10")).status, RefundRequestStatus.PENDING);
      assert.equal(await status(tx, o.orderId), OrderStatus.CONFIRMED);
    });
  });

  it("COD / unpaid / failed / non-Cashfree / fully refunded orders can not request a refund", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const s = svc(tx, realCancel(tx).fn);
      const cases: Array<[string, Partial<Prisma.PaymentUncheckedCreateInput>, RegExp]> = [
        ["COD", { method: PaymentMethod.COD, provider: "COD", externalSource: null, externalId: null, providerPaymentId: null, metadata: undefined, status: PaymentStatus.PENDING, paidAt: null }, /cash-on-delivery/],
        ["unpaid", { status: PaymentStatus.PENDING, paidAt: null }, /Only a successful payment/],
        ["failed", { status: PaymentStatus.FAILED, paidAt: null }, /Only a successful payment/],
        ["non-Cashfree", { externalSource: null, externalId: null, provider: "Other" }, /not collected through Cashfree/],
        ["fully refunded", { status: PaymentStatus.REFUNDED, refundedAmount: "100.00", refundedAt: new Date() }, /already been fully refunded/],
      ];
      for (const [label, payment, re] of cases) {
        const o = await order(tx, a, { payment });
        const view = (await loadOrderRefundInfo(tx, o.orderId)).payments[0]!;
        assert.equal(view.eligible, false, label);
        await rejects(ask(s, a.sales, o), 400, re);
        assert.equal(await status(tx, o.orderId), OrderStatus.CONFIRMED, `${label}: untouched`);
      }
    });
  });
});

describe("the manager's APPROVAL cancels the order", () => {
  it("approve: the order becomes CANCELLED, the refund APPROVED, and every step is audited separately with who did it", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const spy = realCancel(tx);
      const s = svc(tx, spy.fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      assert.equal(await status(tx, o.orderId), OrderStatus.CONFIRMED);
      const approved = await s.approve(a.manager, req.id);
      assert.deepEqual([approved.status, approved.orderStatus, approved.decidedBy?.id], [RefundRequestStatus.APPROVED, OrderStatus.CANCELLED, a.manager.id]);
      assert.equal(await status(tx, o.orderId), OrderStatus.CANCELLED);
      assert.equal(approved.executionStatus ?? null, null, "approved = ready for execution, not executed");
      assert.equal(spy.calls.length, 1);
      assert.match(spy.calls[0]!.reason, new RegExp(req.id));
      const row = await tx.order.findUniqueOrThrow({ where: { id: o.orderId } });
      assert.ok(row.cancelledAt);
      assert.equal((row.metadata as any).preCancelStatus, OrderStatus.CONFIRMED, "history kept so the cancellation can be understood");
      const evts = await events(tx, o.orderId);
      assert.deepEqual([count(evts, ActivityType.REFUND_REQUESTED), count(evts, ActivityType.ORDER_CANCELLED), count(evts, ActivityType.REFUND_APPROVED)], [1, 1, 1]);
      const by = (t: ActivityType) => evts.find((e) => e.type === t)!.actorId;
      assert.deepEqual([by(ActivityType.REFUND_REQUESTED), by(ActivityType.ORDER_CANCELLED), by(ActivityType.REFUND_APPROVED)], [a.sales.id, a.manager.id, a.manager.id]);
      assert.ok(evts.every((e) => e.createdAt instanceof Date));
      assert.match(evts.find((e) => e.type === ActivityType.REFUND_APPROVED)!.title ?? "", /the order was cancelled by this approval/);
    });
  });

  it("reject: the order stays NOT cancelled and no cancellation happens", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const spy = realCancel(tx);
      const s = svc(tx, spy.fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      assert.equal((await s.reject(a.manager, req.id, "Not a valid refund")).status, RefundRequestStatus.REJECTED);
      assert.equal(await status(tx, o.orderId), OrderStatus.CONFIRMED);
      assert.equal(spy.calls.length, 0);
      assert.equal(count(await events(tx, o.orderId), ActivityType.ORDER_CANCELLED), 0);
      // and the amount is released again
      assert.equal((await loadOrderRefundInfo(tx, o.orderId)).payments[0]!.refundableAmount, "100.00");
    });
  });

  it("a FAILED cancellation means NO approval: the request stays PENDING, the order stays active, and nothing can be executed; approving again later works", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      let broken = true;
      const real = realCancel(tx);
      const s = svc(tx, async (u, id, r) => { if (broken) throw new Error("database unavailable"); return real.fn(u, id, r); });
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      await rejects(s.approve(a.manager, req.id), 502, /could not be cancelled, so the refund was NOT approved: database unavailable/);
      const row = await tx.refundRequest.findUniqueOrThrow({ where: { id: req.id } });
      assert.deepEqual([row.status, row.decidedById, row.executionStatus], [RefundRequestStatus.PENDING, null, null]);
      assert.equal(await status(tx, o.orderId), OrderStatus.CONFIRMED);
      assert.equal(count(await events(tx, o.orderId), ActivityType.REFUND_APPROVED), 0);
      let sent = 0;
      const api: RefundApi = { createRefund: async () => { sent++; return answer(); }, getRefund: async () => answer() };
      await rejects(new RefundExecutionService(runnerOf(tx), { config: () => SANDBOX, client: () => api, env: {}, shopifyRefundable: async () => null }).execute(a.admin, req.id), 409, /approved refund request/);
      assert.equal(sent, 0);
      broken = false;
      assert.equal((await s.approve(a.manager, req.id)).status, RefundRequestStatus.APPROVED);
      assert.equal(await status(tx, o.orderId), OrderStatus.CANCELLED);
    });
  });

  it("a cancellation that does not end CANCELLED, or that Shopify refuses for a Shopify-linked order, also blocks the approval (and is retried safely)", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const o = await order(tx, a);
      const notCancelled = svc(tx, async () => ({ order: { status: "CONFIRMED" }, shopify: { status: "not_linked" } }));
      const req = await ask(notCancelled, a.sales, o);
      await rejects(notCancelled.approve(a.manager, req.id), 502, /could not be cancelled, so the refund was NOT approved/);
      assert.equal((await tx.refundRequest.findUniqueOrThrow({ where: { id: req.id } })).status, RefundRequestStatus.PENDING);

      // Shopify-linked order whose Shopify cancellation fails
      const o2 = await order(tx, a, { shopifyLinked: true });
      const s = svc(tx, realCancel(tx, "Shopify unreachable").fn);
      const r2 = await ask(s, a.sales, o2);
      await rejects(s.approve(a.manager, r2.id), 502, /cancelled in the CRM but could not be cancelled in Shopify .*Shopify unreachable.*NOT approved/);
      assert.equal((await tx.refundRequest.findUniqueOrThrow({ where: { id: r2.id } })).status, RefundRequestStatus.PENDING, "no approval while Shopify still has the order");
      assert.equal(count(await events(tx, o2.orderId), ActivityType.REFUND_APPROVED), 0);
      // Shopify recovers: approving again retries only the outstanding Shopify cancel and approves; the CRM cancellation is not repeated
      const healthy = svc(tx, realCancel(tx).fn);
      assert.equal((await healthy.approve(a.manager, r2.id)).status, RefundRequestStatus.APPROVED);
      assert.equal(count(await events(tx, o2.orderId), ActivityType.ORDER_CANCELLED), 1, "the order was cancelled once");
    });
  });

  it("DUPLICATE approval: the second one is refused - one cancellation, one approval event, one decision", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const spy = realCancel(tx);
      const s = svc(tx, spy.fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      await s.approve(a.manager, req.id);
      await rejects(s.approve(a.manager, req.id), 409, /already approved/);
      await rejects(s.approve(a.admin, req.id), 409, /already approved/);
      assert.equal(spy.calls.length, 1, "the order is not cancelled twice");
      const evts = await events(tx, o.orderId);
      assert.deepEqual([count(evts, ActivityType.ORDER_CANCELLED), count(evts, ActivityType.REFUND_APPROVED)], [1, 1]);
    });
  });

  it("an order the user already cancelled directly while the request was pending: approval does not cancel it twice", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const spy = realCancel(tx);
      const s = svc(tx, spy.fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      await ordersFor(tx).cancelOrder(a.sales as never, o.orderId, { reason: "Customer called to cancel" }); // the direct Cancel Order flow still works, and does not invalidate the request
      assert.equal(await status(tx, o.orderId), OrderStatus.CANCELLED);
      assert.equal((await tx.refundRequest.findUniqueOrThrow({ where: { id: req.id } })).status, RefundRequestStatus.PENDING);
      const approved = await s.approve(a.manager, req.id);
      assert.deepEqual([approved.status, spy.calls.length, count(await events(tx, o.orderId), ActivityType.ORDER_CANCELLED)], [RefundRequestStatus.APPROVED, 0, 1]);
      assert.equal(await tx.activity.count({ where: { orderId: o.orderId, type: ActivityType.REFUND_APPROVED } }), 1);
    });
  });

  it("a cancellation can not be reverted once a refund has been approved for the order (it can while the request is only pending)", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const s = svc(tx, realCancel(tx).fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      await ordersFor(tx).cancelOrder(a.admin as never, o.orderId, { reason: "x" });
      const revertedWhilePending = await ordersFor(tx).revertCancellation(a.admin as never, o.orderId);
      assert.equal(revertedWhilePending.restoredStatus, OrderStatus.CONFIRMED);
      await s.approve(a.manager, req.id); // cancels again and approves
      await rejects(ordersFor(tx).revertCancellation(a.admin as never, o.orderId), 409, /refund has been approved/);
      assert.equal(await status(tx, o.orderId), OrderStatus.CANCELLED);
    });
  });
});

describe("EXECUTION after the approval: Cashfree pending -> successful, or failed - the order stays CANCELLED", () => {
  const exec = (tx: Db, api: RefundApi) => new RefundExecutionService(runnerOf(tx), { config: () => SANDBOX, client: () => api, env: {}, shopifyRefundable: async () => ({ amount: "100.00", currency: "INR" }) });

  it("full flow: request on an active order -> manager approves (cancels) -> admin executes -> Pending -> Successful: payment REFUNDED, refunded 100, refundable 0, order CANCELLED, all events audited", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const s = svc(tx, realCancel(tx).fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      await s.approve(a.manager, req.id);
      let st = "PENDING";
      let sent = 0;
      const api: RefundApi = { createRefund: async (_o, body) => { sent++; return answer({ refundId: body.refund_id }); }, getRefund: async (_o, refundId) => answer({ refundId, refundStatus: st }) };
      const ex = exec(tx, api);
      assert.equal((await ex.execute(a.admin, req.id)).request.executionStatus, RefundExecutionStatus.PROCESSING);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).refundedAmount, null, "nothing refunded while Cashfree says pending");
      st = "SUCCESS";
      assert.equal((await ex.refresh(a.admin, req.id)).executionStatus, RefundExecutionStatus.COMPLETED);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      assert.deepEqual([p.status, p.refundedAmount?.toString()], [PaymentStatus.REFUNDED, "100"]);
      const v = (await loadOrderRefundInfo(tx, o.orderId)).payments[0]!;
      assert.deepEqual([v.eligible, v.refundableAmount, v.refundedAmount], [false, "0.00", "100.00"]);
      assert.equal(await status(tx, o.orderId), OrderStatus.CANCELLED);
      // DUPLICATE execution / re-check: no second refund
      for (let i = 0; i < 2; i++) await rejects(ex.execute(a.admin, req.id), 409);
      await ex.refresh(a.admin, req.id);
      assert.equal(sent, 1);
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).refundedAmount?.toString(), "100");
      await rejects(ask(s, a.sales, o), 400, /fully refunded/);
      const evts = await events(tx, o.orderId);
      for (const t of [ActivityType.REFUND_REQUESTED, ActivityType.REFUND_APPROVED, ActivityType.ORDER_CANCELLED, ActivityType.REFUND_EXECUTION_STARTED, ActivityType.PAYMENT_REFUNDED]) assert.equal(count(evts, t), 1, t);
    });
  });

  it("a Cashfree failure leaves the order CANCELLED (never restored), the refund FAILED with the real reason, nothing refunded, and a retry works", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const s = svc(tx, realCancel(tx).fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      await s.approve(a.manager, req.id);
      const { ProviderHttpError } = await import("../integrations/integrations.common.js");
      let reject = true;
      const api: RefundApi = { createRefund: async (_o, body) => { if (reject) throw new ProviderHttpError("CASHFREE", 400, "refund amount is more than the amount available to refund", false); return answer({ refundId: body.refund_id }); }, getRefund: async (_o, refundId) => answer({ refundId, refundStatus: "SUCCESS" }) };
      const ex = exec(tx, api);
      const failed = await ex.execute(a.admin, req.id);
      assert.equal(failed.request.executionStatus, RefundExecutionStatus.FAILED);
      assert.match(failed.request.failureReason!, /refund amount is more than the amount available to refund/);
      assert.equal(await status(tx, o.orderId), OrderStatus.CANCELLED, "the order is not restored because the refund failed");
      assert.equal((await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).refundedAmount, null);
      reject = false;
      assert.equal((await ex.execute(a.admin, req.id)).request.executionStatus, RefundExecutionStatus.PROCESSING, "Retry Refund");
    });
  });

  it("a legacy / inconsistent approved refund whose order is NOT cancelled is never sent to Cashfree", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const s = svc(tx, realCancel(tx).fn);
      const o = await order(tx, a);
      const req = await ask(s, a.sales, o);
      await tx.refundRequest.update({ where: { id: req.id }, data: { status: RefundRequestStatus.APPROVED, decidedById: a.manager.id, decidedByRole: Role.MANAGER, decisionAt: new Date() } });
      let sent = 0;
      const api: RefundApi = { createRefund: async () => { sent++; return answer(); }, getRefund: async () => answer() };
      await rejects(exec(tx, api).execute(a.admin, req.id), 400, /order is not cancelled/);
      assert.equal(sent, 0);
    });
  });

  it("PARTIAL then FULL: a ₹40 refund leaves the payment PARTIALLY_REFUNDED with ₹60 refundable; refunding the rest ends fully REFUNDED", async () => {
    await inRollback(async (tx) => {
      const a = await actors(tx);
      const s = svc(tx, realCancel(tx).fn);
      const o = await order(tx, a);
      const amounts = new Map<string, string>();
      const api: RefundApi = { createRefund: async (_o, body) => { amounts.set(body.refund_id, String(body.refund_amount)); return answer({ refundId: body.refund_id, refundAmount: String(body.refund_amount) }); }, getRefund: async (_o, refundId) => answer({ refundId, refundStatus: "SUCCESS", refundAmount: amounts.get(refundId) ?? "0" }) };
      const ex = new RefundExecutionService(runnerOf(tx), { config: () => SANDBOX, client: () => api, env: {}, shopifyRefundable: async () => ({ amount: "100.00", currency: "INR" }) });
      const first = await ask(s, a.sales, o, "40");
      await s.approve(a.manager, first.id);
      await ex.execute(a.admin, first.id);
      await ex.refresh(a.admin, first.id);
      let p = await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      assert.deepEqual([p.status, p.refundedAmount?.toString()], [PaymentStatus.PARTIALLY_REFUNDED, "40"]);
      const view = (await loadOrderRefundInfo(tx, o.orderId)).payments[0]!;
      assert.deepEqual([view.eligible, view.refundableAmount], [true, "60.00"]);
      await rejects(ask(s, a.sales, o, "60.01"), 400, /Only ₹60\.00 can still be refunded/);
      const second = await ask(s, a.sales, o, "60"); // the order is already cancelled: approval does not cancel it again
      await s.approve(a.manager, second.id);
      await ex.execute(a.admin, second.id);
      await ex.refresh(a.admin, second.id);
      p = await tx.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      assert.deepEqual([p.status, p.refundedAmount?.toString()], [PaymentStatus.REFUNDED, "100"]);
      assert.equal(count(await events(tx, o.orderId), ActivityType.ORDER_CANCELLED), 1, "cancelled once, by the first approval");
      await rejects(ask(s, a.sales, o, "1"), 400, /fully refunded/);
    });
  });
});
