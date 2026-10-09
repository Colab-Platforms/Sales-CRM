// Database tests: ORDER VISIBILITY is company-wide for ADMIN, MANAGER and SALESPERSON (telecaller), whatever team an order belongs to - while every ACTION on an order
// keeps its existing scope. Rolled-back transaction only; no Cashfree, no Shopify. Run with: npm run test:db
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, Role } from "../../../generated/prisma/enums.js";
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

// Two teams, each with a manager and a telecaller who owns that team's lead; orders on each lead. A tag in every order number isolates them from other data.
async function world(tx: Db) {
  const tag = `VIS${uid().slice(0, 8)}`;
  const mk = (role: Role, name: string) => tx.user.create({ data: { name, username: `u-${uid()}`, role }, select: { id: true, username: true } });
  const admin = await mk(Role.ADMIN, "Admin");
  const hr = { id: uid(), username: "hr-synthetic" }; // no DB row needed: scope comes from the role alone
  const mgrA = await mk(Role.MANAGER, "MgrA");
  const mgrB = await mk(Role.MANAGER, "MgrB");
  const teleA = await mk(Role.SALESPERSON, "TeleA");
  const teleB = await mk(Role.SALESPERSON, "TeleB");
  const source = await tx.source.create({ data: { name: "Web", code: `w-${uid()}` }, select: { id: true } });
  const team = async (manager: { id: string }, tele: { id: string }, first: string, mobile: string) => {
    const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
    await tx.groupMember.create({ data: { groupId: group.id, userId: tele.id, joinedAt: new Date(), isActive: true } });
    const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: first, lastName: tag, mobile, normalizedMobile: `+91${mobile}`, sourceId: source.id, ownerId: tele.id, groupId: group.id }, select: { id: true } });
    return lead.id;
  };
  const leadA = await team(mgrA, teleA, "Alpha", "9876511111");
  const leadB = await team(mgrB, teleB, "Beta", "9876522222");
  const order = (leadId: string, n: number, over: Record<string, unknown> = {}) =>
    tx.order.create({ data: { orderNumber: `${tag}-${n}`, leadId, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, currency: "INR", totalAmount: "100.00", ...over } as never, select: { id: true } }).then((o) => o.id);
  return { tag, admin, hr, mgrA, mgrB, teleA, teleB, leadA, leadB, order };
}

describe("order visibility is company-wide for admin, manager and salesperson", () => {
  it("every one of them lists orders from BOTH teams; HR sees none", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a1 = await w.order(w.leadA, 1);
      const b1 = await w.order(w.leadB, 2);
      const svc = new OrdersService(tx as never);
      const ids = async (u: { id: string; username: string }, role: Role) => (await svc.listOrders(as(u, role), { page: 1, pageSize: 50, search: w.tag })).items.map((i) => i.id).sort();
      for (const [u, role] of [[w.admin, Role.ADMIN], [w.mgrA, Role.MANAGER], [w.mgrB, Role.MANAGER], [w.teleA, Role.SALESPERSON], [w.teleB, Role.SALESPERSON]] as const) {
        assert.deepEqual(await ids(u, role), [a1, b1].sort(), `${role} must see both teams' orders`);
      }
      assert.deepEqual(await ids(w.hr, Role.HR), [], "HR still sees no orders");
    });
  });

  it("the count, pagination, filters and search behave the same for a manager and a telecaller of the OTHER team", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.order(w.leadA, 1, { status: OrderStatus.CONFIRMED, source: OrderSource.WEBSITE });
      await w.order(w.leadB, 2, { status: OrderStatus.CANCELLED, source: OrderSource.SALESPERSON });
      await w.order(w.leadB, 3, { status: OrderStatus.CONFIRMED, source: OrderSource.SALESPERSON });
      const svc = new OrdersService(tx as never);
      for (const [u, role] of [[w.mgrA, Role.MANAGER], [w.teleA, Role.SALESPERSON]] as const) {
        const me = as(u, role);
        const all = await svc.listOrders(me, { page: 1, pageSize: 50, search: w.tag });
        assert.equal(all.pagination.totalItems, 3, `${role} count`);
        const p1 = await svc.listOrders(me, { page: 1, pageSize: 2, search: w.tag });
        const p2 = await svc.listOrders(me, { page: 2, pageSize: 2, search: w.tag });
        assert.deepEqual([p1.items.length, p2.items.length, p1.pagination.totalItems, p1.pagination.totalPages], [2, 1, 3, 2]);
        assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.id)).size, 3);
        assert.equal((await svc.listOrders(me, { page: 1, pageSize: 50, search: w.tag, status: OrderStatus.CANCELLED })).items.length, 1);
        assert.equal((await svc.listOrders(me, { page: 1, pageSize: 50, search: w.tag, source: OrderSource.SALESPERSON })).items.length, 2);
        assert.equal((await svc.listOrders(me, { page: 1, pageSize: 50, search: `Beta ${w.tag}` })).items.length, 2);
        assert.equal((await svc.listOrders(me, { page: 1, pageSize: 50, search: `${w.tag}-2` })).items.length, 1);
      }
    });
  });

  it("every order that shows in the list opens: order page, timeline and audit history, for the other team's manager and telecaller too", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const b1 = await w.order(w.leadB, 1);
      const svc = new OrdersService(tx as never);
      const audit = new AuditService(tx as never);
      for (const [u, role] of [[w.admin, Role.ADMIN], [w.mgrA, Role.MANAGER], [w.teleA, Role.SALESPERSON]] as const) {
        const me = as(u, role);
        const listed = (await svc.listOrders(me, { page: 1, pageSize: 50, search: w.tag })).items.map((i) => i.id);
        assert.deepEqual(listed, [b1]);
        assert.equal((await svc.getOrder(me, listed[0]!)).id, b1);
        await svc.getStatusHistory(me, b1);
        await audit.getOrderAudit(me, b1, { page: 1, pageSize: 10 });
      }
      await assert.rejects(svc.getOrder(as(w.hr, Role.HR), b1), /Order not found/);
      await assert.rejects(svc.getOrder(as(w.teleA, Role.SALESPERSON), randomUUID()), /Order not found/);
    });
  });

  it("seeing an order grants no action: the other team's manager and telecaller still cannot cancel it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const b1 = await w.order(w.leadB, 1);
      const svc = new OrdersService(tx as never);
      await assert.rejects(svc.cancelOrder(as(w.mgrA, Role.MANAGER), b1, { reason: "not mine" }), /Order not found/);
      await assert.rejects(svc.cancelOrder(as(w.teleA, Role.SALESPERSON), b1, { reason: "not mine" }), /Order not found/);
      assert.equal((await tx.order.findUniqueOrThrow({ where: { id: b1 }, select: { status: true } })).status, OrderStatus.CONFIRMED, "the order was not changed");
    });
  });
});
