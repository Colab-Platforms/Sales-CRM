// "My Orders": a user sees ONLY the orders they created (Order.createdById = the authenticated user), enforced in the database query and at the API.
// Service-level scoping runs in ONE rolled-back transaction; the HTTP-level checks use the REAL router and a locally signed token against the ISOLATED test database only.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { prisma } from "../../lib/prisma.js";
import { signToken } from "../../lib/jwt.js";
import { OrderSource, OrderStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import routes from "../../routes.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import OrdersService from "./orders.service.js";

if (!/127\.0\.0\.1:5544\/crm_iso$/.test(process.env.DATABASE_URL ?? "")) throw new Error("GUARD: this test only runs against the isolated database");

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

const uid = () => randomUUID();
const Q = (over: Record<string, unknown> = {}) => ({ page: 1, pageSize: 20, ...over }) as never;

async function world(tx: Prisma.TransactionClient) {
  const mk = (name: string, role: Role) => tx.user.create({ data: { name, username: `${name}-${uid()}`, role }, select: { id: true, username: true, role: true } });
  const [a, b, manager, admin] = await Promise.all([mk("tele-a", Role.SALESPERSON), mk("tele-b", Role.SALESPERSON), mk("mgr", Role.MANAGER), mk("adm", Role.ADMIN)]);
  const lead = (owner: string, label: string) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: label, mobile: "9811400001", normalizedMobile: "+919811400001", ownerId: owner }, select: { id: true } });
  const l1 = await lead(a.id, "OwnedByA");
  const l2 = await lead(b.id, "OwnedByB");
  const order = (leadId: string, createdById: string | null, over: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId, source: OrderSource.SALESPERSON, status: OrderStatus.CONFIRMED, totalAmount: "500.00", createdById, ...over }, select: { id: true } });
  const oA1 = await order(l1.id, a.id);                       // created by A, A's own customer
  const oA2 = await order(l2.id, a.id);                       // created by A for B's customer
  const oB1 = await order(l1.id, b.id);                       // created by B, for A's customer (A is the lead owner / "assigned" salesperson)
  const oB2 = await order(l2.id, b.id);
  const oShop = await order(l1.id, null, { source: OrderSource.WEBSITE }); // synced / no creator
  const svc = new OrdersService(tx as never);
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id).sort();
  return { a, b, manager, admin, l1, l2, oA1, oA2, oB1, oB2, oShop, svc, as, ids, order };
}

describe("listMyOrders (service): only the orders the signed-in user created", () => {
  it("a telecaller sees exactly their own created orders - not orders assigned to them, not other creators', not no-creator orders", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mine = await w.svc.listMyOrders(w.as(w.a), Q());
      assert.deepEqual(w.ids(mine), [w.oA1.id, w.oA2.id].sort());
      assert.equal(mine.pagination.totalItems, 2);
      assert.ok(!w.ids(mine).includes(w.oB1.id), "an order for A's own customer created by someone else is NOT in A's list");
      assert.ok(!w.ids(mine).includes(w.oShop.id), "an order with no creator (Shopify-synced) is not in anyone's list");
      assert.deepEqual(w.ids(await w.svc.listMyOrders(w.as(w.b), Q())), [w.oB1.id, w.oB2.id].sort());
    });
  });

  it("the existing Orders list is unchanged: it still returns everything visible to the role", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const all = await w.svc.listOrders(w.as(w.a), Q());
      for (const o of [w.oA1, w.oA2, w.oB1, w.oB2, w.oShop]) assert.ok(w.ids(all).includes(o.id));
    });
  });

  it("My Orders is Salesperson-only: a manager, admin, HR or recruiter is refused by the service itself, and nobody's rows leak", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.order(w.l1.id, w.manager.id);
      for (const u of [w.manager, w.admin]) await assert.rejects(() => w.svc.listMyOrders(w.as(u), Q()), (e: { statusCode?: number }) => e.statusCode === 403);
      for (const role of [Role.HR, Role.RECRUITER]) await assert.rejects(() => w.svc.listMyOrders({ id: w.a.id, username: "x", role }, Q()), (e: { statusCode?: number }) => e.statusCode === 403);
    });
  });

  it("no request parameter can widen it: another user's id as salespersonId only narrows to nothing; an unknown createdById is ignored by the validator", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const hostile = await w.svc.listMyOrders(w.as(w.a), Q({ salespersonId: w.b.id }));
      assert.equal(hostile.pagination.totalItems, 0);
      const { validateListOrdersQuery } = await import("./orders.validators.js");
      const parsed = validateListOrdersQuery({ createdById: w.b.id, page: "1" });
      assert.ok(!parsed.error);
      assert.equal((parsed.value as unknown as Record<string, unknown>).createdById, undefined, "the validator drops it");
    });
  });

  it("search, status and payment filters work inside My Orders and never leave it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const paid = await w.order(w.l1.id, w.a.id, { status: OrderStatus.PENDING_PAYMENT, orderNumber: `FIND-${uid()}` });
      const byStatus = await w.svc.listMyOrders(w.as(w.a), Q({ status: OrderStatus.PENDING_PAYMENT }));
      assert.deepEqual(w.ids(byStatus), [paid.id]);
      const byNumber = await w.svc.listMyOrders(w.as(w.a), Q({ search: "FIND-" }));
      assert.deepEqual(w.ids(byNumber), [paid.id]);
      // the same search by another creator's order number finds nothing in A's list
      const bOrder = await w.order(w.l2.id, w.b.id, { orderNumber: `OTHERS-${uid()}` });
      assert.equal((await w.svc.listMyOrders(w.as(w.a), Q({ search: "OTHERS-" }))).pagination.totalItems, 0);
      assert.ok(bOrder.id);
    });
  });

  it("pagination is computed over the user's own orders", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (let i = 0; i < 3; i++) await w.order(w.l1.id, w.a.id);
      const page1 = await w.svc.listMyOrders(w.as(w.a), Q({ pageSize: 2 }));
      assert.deepEqual([page1.items.length, page1.pagination.totalItems, page1.pagination.totalPages], [2, 5, 3]);
      const page3 = await w.svc.listMyOrders(w.as(w.a), Q({ pageSize: 2, page: 3 }));
      assert.equal(page3.items.length, 1);
    });
  });

  it("a user who created nothing gets a clean empty result", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const fresh = await tx.user.create({ data: { name: "fresh", username: `f-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true, role: true } });
      const r = await w.svc.listMyOrders(w.as(fresh), Q());
      assert.deepEqual([r.items.length, r.pagination.totalItems, r.pagination.totalPages], [0, 0, 0]);
    });
  });
});
describe("GET /api/orders/mine (HTTP, real router, isolated database)", () => {
  let server: Server;
  let base = "";
  before(async () => {
    const app = express();
    app.use("/api", routes);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  });
  const token = (sub: string, role: string) => signToken({ sub, role, username: `t-${role}` } as never);
  const get = (path: string, bearer?: string) => fetch(base + path, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

  it("no token -> 401; HR (no orders) -> 403; the path is not read as an order id", async () => {
    assert.equal((await get("/orders/mine")).status, 401);
    assert.equal((await get("/orders/mine", token(uid(), "HR"))).status, 403);
    const res = await get("/orders/mine", token(uid(), "SALESPERSON"));
    assert.equal(res.status, 200, "'mine' is a route of its own, not an invalid order id");
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.deepEqual(body.data.items, []);
  });

  it("a request naming another creator cannot reveal their orders: the result is always the caller's own", async () => {
    const someoneWithOrders = (await prisma.order.findFirst({ where: { createdById: { not: null } }, select: { createdById: true } }))?.createdById;
    if (!someoneWithOrders) return; // nothing to impersonate in this database
    const stranger = uid();
    for (const qs of [`?createdById=${someoneWithOrders}`, `?salespersonId=${someoneWithOrders}`, `?createdBy=${someoneWithOrders}&userId=${someoneWithOrders}`]) {
      const body = (await (await get(`/orders/mine${qs}`, token(stranger, "SALESPERSON"))).json()) as any;
      assert.equal(body.data.pagination.totalItems, 0, qs);
    }
    // and the real owner of those orders sees exactly the count the database holds for them
    const expected = await prisma.order.count({ where: { createdById: someoneWithOrders } });
    const mine = (await (await get("/orders/mine?pageSize=100", token(someoneWithOrders, "SALESPERSON"))).json()) as any;
    assert.equal(mine.data.pagination.totalItems, expected);
  });
});
