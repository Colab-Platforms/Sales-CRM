// Database tests: opening the ORDER behind a refund request. Refund approval is company-wide, so a manager (or admin) who reviews a request must be able to open its order
// whichever team it belongs to - but ONLY orders that actually have a refund request, only to read, and nobody else gains anything. Run with: npm run test:db
// Rolled-back transaction only; no Cashfree, no Shopify.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "../../middlewares/auth.js";
import type { Db } from "../integrations/integrations.common.js";
import OrdersService from "./orders.service.js";
import AuditService from "../audit/audit.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; username: string }, role: Role): AuthUser => ({ id: u.id, username: u.username, role }) as AuthUser;
const notFound = (p: Promise<unknown>) => assert.rejects(p, /Order not found/);

describe("opening the order behind a refund request", () => {
  it("any manager and any admin can open an order that has a refund request; nobody gains access to orders without one", async () => {
    await inRollback(async (tx) => {
      const mk = (role: Role) => tx.user.create({ data: { name: role, username: `u-${uid()}`, role }, select: { id: true, username: true } });
      const [manager, otherManager, admin, tele, outsider] = [await mk(Role.MANAGER), await mk(Role.MANAGER), await mk(Role.ADMIN), await mk(Role.SALESPERSON), await mk(Role.SALESPERSON)];
      const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
      await tx.groupMember.create({ data: { groupId: group.id, userId: tele.id, joinedAt: new Date(), isActive: true } });
      const source = await tx.source.create({ data: { name: "Web", code: `w-${uid()}` }, select: { id: true } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Fake", lastName: "Customer", mobile: "9876500000", normalizedMobile: "+919876500000", sourceId: source.id, ownerId: tele.id, groupId: group.id }, select: { id: true } });
      const makeOrder = async () => (await tx.order.create({ data: { orderNumber: `FAKE-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, currency: "INR", totalAmount: "100.00" }, select: { id: true } })).id;
      const withRequest = await makeOrder();
      const withoutRequest = await makeOrder();
      const payment = await tx.payment.create({ data: { orderId: withRequest, amount: "100.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS, provider: "Cashfree", externalSource: "CASHFREE" }, select: { id: true } });
      await tx.refundRequest.create({ data: { orderId: withRequest, paymentId: payment.id, requestedById: tele.id, requestedByRole: Role.SALESPERSON, amount: "100.00", currency: "INR", reason: "TEST", status: RefundRequestStatus.PENDING } });

      const svc = new OrdersService(tx as never);
      // same-team access is unchanged
      assert.equal((await svc.getOrder(as(manager, Role.MANAGER), withRequest)).id, withRequest);
      assert.equal((await svc.getOrder(as(manager, Role.MANAGER), withoutRequest)).id, withoutRequest);
      assert.equal((await svc.getOrder(as(tele, Role.SALESPERSON), withRequest)).id, withRequest);
      // another team's manager: the order behind a refund request opens ...
      assert.equal((await svc.getOrder(as(otherManager, Role.MANAGER), withRequest)).id, withRequest);
      // ... but an order without one stays closed, and nothing else about the order is opened up for them
      await notFound(svc.getOrder(as(otherManager, Role.MANAGER), withoutRequest));
      await assert.rejects(svc.cancelOrder(as(otherManager, Role.MANAGER), withRequest, { reason: "not mine" }), /Order not found/);
      // the order page's timeline and audit history follow the same rule (they used to answer "Order not found" on an otherwise open page)
      const audit = new AuditService(tx as never);
      assert.equal((await svc.getStatusHistory(as(otherManager, Role.MANAGER), withRequest)).orderId ?? withRequest, withRequest);
      await audit.getOrderAudit(as(otherManager, Role.MANAGER), withRequest, { page: 1, pageSize: 10 });
      await notFound(svc.getStatusHistory(as(otherManager, Role.MANAGER), withoutRequest));
      await assert.rejects(audit.getOrderAudit(as(otherManager, Role.MANAGER), withoutRequest, { page: 1, pageSize: 10 }), /Order not found/);
      await notFound(svc.getStatusHistory(as(outsider, Role.SALESPERSON), withRequest));
      await assert.rejects(audit.getOrderAudit(as(outsider, Role.SALESPERSON), withRequest, { page: 1, pageSize: 10 }), /Order not found/);
      // an admin opens both
      assert.equal((await svc.getOrder(as(admin, Role.ADMIN), withRequest)).id, withRequest);
      assert.equal((await svc.getOrder(as(admin, Role.ADMIN), withoutRequest)).id, withoutRequest);
      // a telecaller outside the order's scope still cannot, even though a refund request exists
      await notFound(svc.getOrder(as(outsider, Role.SALESPERSON), withRequest));
      await notFound(svc.getOrder(as(outsider, Role.SALESPERSON), withoutRequest));
    });
  });
});
