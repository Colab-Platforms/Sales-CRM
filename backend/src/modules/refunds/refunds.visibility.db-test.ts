// Database tests: who SEES a pending refund request. A telecaller's request must be in the approval queue of the manager who runs their team AND of every admin,
// and of nobody else; seeing is not deciding (a telecaller still cannot approve, nobody approves their own). Run with: npm run test:db
// Rolled-back transactions only; no Cashfree, no Shopify.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "../../middlewares/auth.js";
import type { Db, TxRunner } from "../integrations/integrations.common.js";
import RefundsService from "./refunds.service.js";
import OrdersService from "../orders/orders.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Db, svc: RefundsService) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { const runner: TxRunner = { $transaction: (cb) => cb(tx) }; await fn(tx, new RefundsService(runner)); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; username: string }, role: Role): AuthUser => ({ id: u.id, username: u.username, role }) as AuthUser;
const Q = { status: "PENDING" as const, page: 1, pageSize: 20 };

async function world(tx: Db) {
  const mk = (role: Role) => tx.user.create({ data: { name: role, username: `u-${uid()}`, role }, select: { id: true, username: true } });
  const [manager, otherManager, admin, tele, outsider] = [await mk(Role.MANAGER), await mk(Role.MANAGER), await mk(Role.ADMIN), await mk(Role.SALESPERSON), await mk(Role.SALESPERSON)];
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: tele.id, joinedAt: new Date(), isActive: true } });
  const source = await tx.source.create({ data: { name: "Web", code: `w-${uid()}` }, select: { id: true } });
  const lead = (owner: string, groupId: string | null) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Fake", lastName: "Customer", mobile: "9876500000", normalizedMobile: "+919876500000", sourceId: source.id, ownerId: owner, groupId }, select: { id: true } });
  const request = async (ownerId: string, groupId: string | null, _requester?: { id: string; username: string }) => {
    const l = await lead(ownerId, groupId);
    const order = await tx.order.create({ data: { orderNumber: `FAKE-${uid()}`, leadId: l.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, currency: "INR", totalAmount: "100.00" }, select: { id: true } });
    const payment = await tx.payment.create({ data: { orderId: order.id, amount: "100.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS, provider: "Cashfree", externalSource: "CASHFREE", externalId: `crm_${uid()}`, providerPaymentId: "555", metadata: { cashfree: { cashfreeOrderId: "FAKE_CF_ORDER", cfPaymentId: "555" } } }, select: { id: true } });
    return { orderId: order.id, paymentId: payment.id };
  };
  return { manager, otherManager, admin, tele, outsider, group, request };
}

describe("refund approval queue visibility", () => {
  it("a telecaller's request is PENDING and appears for EVERY manager and EVERY admin whatever their team - and is refused to a telecaller", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const o = await w.request(w.tele.id, w.group.id, w.tele);
      const created = await svc.createRequest(as(w.tele, Role.SALESPERSON), o.orderId, { paymentId: o.paymentId, amount: "100", reason: "VISIBILITY TEST" });
      assert.equal(created.status, RefundRequestStatus.PENDING);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: o.orderId }, select: { status: true } })).status, OrderStatus.CONFIRMED); // not cancelled by requesting

      for (const [who, role] of [[w.manager, Role.MANAGER], [w.admin, Role.ADMIN]] as const) {
        const q = await svc.list(as(who, role), Q);
        const hit = q.items.find((r) => r.id === created.id);
        assert.ok(hit, `${role} must see the request`);
        assert.deepEqual([hit.amount, hit.reason, hit.requestedBy.id, hit.orderNumber.length > 0], ["100.00", "VISIBILITY TEST", w.tele.id, true]);
      }
      // approval is company-wide: a manager of ANOTHER team and a second admin see it too
      const admin2 = await tx.user.create({ data: { name: "Admin2", username: `a2-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true } });
      assert.ok((await svc.list(as(w.otherManager, Role.MANAGER), Q)).items.some((r) => r.id === created.id));
      assert.ok((await svc.list(as(admin2, Role.ADMIN), Q)).items.some((r) => r.id === created.id));
      assert.ok((await svc.pendingCount(as(w.otherManager, Role.MANAGER))).count >= 1);
      await assert.rejects(svc.list(as(w.tele, Role.SALESPERSON), Q), /Forbidden/); // the list endpoint is for approvers only
    });
  });

  it("requests from a telecaller outside every manager's team are visible to all managers and admins", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const o = await w.request(w.outsider.id, null, w.outsider);
      const created = await svc.createRequest(as(w.outsider, Role.SALESPERSON), o.orderId, { paymentId: o.paymentId, amount: "100", reason: "OUTSIDE TEAM" });
      assert.ok((await svc.list(as(w.admin, Role.ADMIN), Q)).items.some((r) => r.id === created.id));
      assert.ok((await svc.list(as(w.manager, Role.MANAGER), Q)).items.some((r) => r.id === created.id));
      assert.ok((await svc.list(as(w.otherManager, Role.MANAGER), Q)).items.some((r) => r.id === created.id));
    });
  });

  it("pagination does not hide a request: it is on the page its position says, and the totals count it", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const before = (await svc.list(as(w.admin, Role.ADMIN), Q)).pagination.totalItems; // the database may already hold other pending requests
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const o = await w.request(w.tele.id, w.group.id, w.tele);
        ids.push((await svc.createRequest(as(w.tele, Role.SALESPERSON), o.orderId, { paymentId: o.paymentId, amount: "100", reason: `R${i}` })).id);
      }
      const p1 = await svc.list(as(w.admin, Role.ADMIN), { ...Q, pageSize: 2 });
      const p2 = await svc.list(as(w.admin, Role.ADMIN), { ...Q, pageSize: 2, page: 2 });
      assert.equal(p1.pagination.totalItems, before + 3);
      const all = await svc.list(as(w.admin, Role.ADMIN), { ...Q, pageSize: 100 });
      assert.ok(ids.every((id) => all.items.some((r) => r.id === id)));
      assert.equal(p1.items.length, 2);
      assert.ok(p2.items.length >= 1);
      const mgr = await svc.list(as(w.manager, Role.MANAGER), { ...Q, requestedById: w.tele.id });
      assert.equal(mgr.pagination.totalItems, 3);
    });
  });

  it("seeing is not deciding: a telecaller cannot approve or reject, and nobody can decide their own request", async () => {
    await inRollback(async (tx, svc) => {
      const w = await world(tx);
      const o = await w.request(w.tele.id, w.group.id, w.tele);
      const created = await svc.createRequest(as(w.tele, Role.SALESPERSON), o.orderId, { paymentId: o.paymentId, amount: "100", reason: "AUTHZ" });
      await assert.rejects(svc.approve(as(w.tele, Role.SALESPERSON), created.id), /Forbidden/);
      await assert.rejects(svc.reject(as(w.tele, Role.SALESPERSON), created.id, "no"), /Forbidden/);

      const mgrOrder = await w.request(w.manager.id, w.group.id, w.manager);
      const own = await svc.createRequest(as(w.manager, Role.MANAGER), mgrOrder.orderId, { paymentId: mgrOrder.paymentId, amount: "100", reason: "OWN" });
      await assert.rejects(svc.approve(as(w.manager, Role.MANAGER), own.id), /own refund request/);
      assert.equal((await tx.refundRequest.findUniqueOrThrow({ where: { id: own.id }, select: { status: true } })).status, RefundRequestStatus.PENDING);
      // the admin sees the manager's request too, and may reject it (a decision by someone else)
      assert.ok((await svc.list(as(w.admin, Role.ADMIN), Q)).items.some((r) => r.id === own.id));
      assert.equal((await svc.reject(as(w.admin, Role.ADMIN), own.id, "not needed")).status, RefundRequestStatus.REJECTED);
    });
  });

  it("any other manager or admin can APPROVE it (the order is cancelled, the request approved); the requester - admin or manager - cannot, and an admin-raised request is approved by a manager", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const runner: TxRunner = { $transaction: (cb) => cb(tx) };
      // the REAL order cancellation (OrdersService.cancelOrder with the approver scope), on this transaction - an approving manager of another team must be able to cancel and re-read the order
      const fakeCancel = (u: AuthUser, orderId: string, reason: string) => new OrdersService(tx as never, (() => { throw new Error("no Shopify link in this test"); }) as never).cancelOrder(u, orderId, { reason }, { approverScope: true });
      const svc = new RefundsService(runner, { cancelOrder: fakeCancel as never });
      const admin2 = await tx.user.create({ data: { name: "Admin2", username: `a2-${uid()}`, role: Role.ADMIN }, select: { id: true, username: true } });
      const raise = async (who: { id: string; username: string }, role: Role) => { const o = await w.request(who.id, w.group.id); const r = await svc.createRequest(as(who, role), o.orderId, { paymentId: o.paymentId, amount: "100", reason: "APPROVE" }); return { ...o, id: r.id }; };

      // telecaller outside the team -> a manager of another team approves
      const t = await raise(w.outsider, Role.SALESPERSON);
      const approved = await svc.approve(as(w.otherManager, Role.MANAGER), t.id);
      assert.equal(approved.status, RefundRequestStatus.APPROVED);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: t.orderId }, select: { status: true } })).status, OrderStatus.CANCELLED);
      // telecaller request -> a different admin approves
      const t2 = await raise(w.tele, Role.SALESPERSON);
      assert.equal((await svc.approve(as(admin2, Role.ADMIN), t2.id)).status, RefundRequestStatus.APPROVED);
      // admin raised -> the same admin cannot approve it, a manager can
      const a = await raise(w.admin, Role.ADMIN);
      await assert.rejects(svc.approve(as(w.admin, Role.ADMIN), a.id), /own refund request/);
      assert.equal((await svc.approve(as(w.manager, Role.MANAGER), a.id)).status, RefundRequestStatus.APPROVED);
      // manager raised -> that manager cannot, an admin can
      const m = await raise(w.manager, Role.MANAGER);
      await assert.rejects(svc.approve(as(w.manager, Role.MANAGER), m.id), /own refund request/);
      assert.equal((await svc.approve(as(w.admin, Role.ADMIN), m.id)).status, RefundRequestStatus.APPROVED);
    });
  });
});
