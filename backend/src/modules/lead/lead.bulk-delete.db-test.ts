// Lead pagination (20 / 50 / 100) and bulk deletion over HTTP through the REAL lead router and middleware, on real tables. The service uses the global Prisma client, so the throwaway data is COMMITTED: the suite
// refuses to run anywhere but the isolated database crm_iso and removes everything it created. 250 leads are created; 4 of them have orders (those must never be deleted).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { prisma } from "../../lib/prisma.js";
import { signToken } from "../../lib/jwt.js";
import { Role } from "../../../generated/prisma/enums.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { requestId } from "../../middlewares/requestId.js";
import leadRoutes from "./lead.routes.js";
import LeadService from "./lead.service.js";

const tag = randomUUID().slice(0, 6);
const TOKEN = `BDX${tag}`; // every test lead's first name starts with this, so a search filter selects exactly them
const TOTAL = 250;
const WITH_ORDERS = 4;
let server: Server;
let base = "";
const users: Record<string, { id: string; username: string; role: Role }> = {};
const tokens: Record<string, string> = {};
let segmentId = "";
const orderLeadIds: string[] = [];
const orderIds: string[] = [];
let pageDeleted = 0;

async function makeUser(key: string, role: Role) {
  const username = `bd-${tag}-${key}`;
  const u = await prisma.user.create({ data: { name: `BD ${key}`, username, role }, select: { id: true } });
  users[key] = { id: u.id, username, role };
  tokens[key] = signToken({ sub: u.id, role, username } as never);
}
const api = async (who: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json: any = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
};
const alive = () => prisma.lead.count({ where: { firstName: { startsWith: TOKEN } } });
const searchFilter = { search: TOKEN };

before(async () => {
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (rows[0]?.current_database !== "crm_iso") throw new Error(`GUARD: this suite commits throwaway data and only runs on crm_iso (got ${rows[0]?.current_database})`);
  await makeUser("admin", Role.ADMIN);
  await makeUser("manager", Role.MANAGER);
  await makeUser("sales", Role.SALESPERSON);
  segmentId = (await prisma.segment.create({ data: { name: `BD seg ${tag}`, nameKey: `bd seg ${tag}`, createdById: users.admin!.id }, select: { id: true } })).id;
  const mk = (i: number) => ({ id: randomUUID(), leadNumber: `BD-${tag}-${i}`, firstName: `${TOKEN}-${String(i).padStart(3, "0")}`, mobile: `6${tag.replace(/\D/g, "1")}${String(i).padStart(4, "0")}`.slice(0, 12), ownerId: i % 2 ? users.sales!.id : null, assignedManagerId: i % 2 ? users.manager!.id : null });
  const leads = Array.from({ length: TOTAL }, (_, i) => mk(i));
  await prisma.lead.createMany({ data: leads });
  await prisma.leadSegment.createMany({ data: leads.map((l) => ({ leadId: l.id, segmentId })) });
  await prisma.activity.createMany({ data: leads.slice(0, 50).map((l) => ({ leadId: l.id, type: "LEAD_CREATED" as never, title: "test" })) });
  for (const l of leads.slice(0, WITH_ORDERS)) {
    orderLeadIds.push(l.id);
    const o = await prisma.order.create({ data: { orderNumber: `BDORD-${tag}-${orderLeadIds.length}`, leadId: l.id, source: "SALESPERSON", status: "CONFIRMED", totalAmount: "500.00" } as never, select: { id: true } });
    orderIds.push(o.id);
  }
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use("/lead", leadRoutes);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const ids = (await prisma.lead.findMany({ where: { firstName: { startsWith: TOKEN } }, select: { id: true } })).map((l) => l.id);
  if (orderIds.length) {
    await prisma.$executeRaw`DELETE FROM activities WHERE order_id = ANY(${orderIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM shipments WHERE order_id = ANY(${orderIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM payments WHERE order_id = ANY(${orderIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM order_items WHERE order_id = ANY(${orderIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM orders WHERE id = ANY(${orderIds}::uuid[])`;
  }
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM activities WHERE lead_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM leads WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM segments WHERE id = ${segmentId}::uuid`;
  await prisma.$executeRaw`DELETE FROM users WHERE username LIKE ${`bd-${tag}-%`}`;
  await prisma.$disconnect();
});

describe("pagination: 20 (default), 50 and 100 per page, filters kept", () => {
  it("each page size returns that many rows and the right page count, with the filter and search unchanged", async () => {
    for (const [limit, pages] of [[20, 13], [50, 5], [100, 3]] as const) {
      const first = await api("admin", "GET", `/lead/leads?limit=${limit}&page=1&search=${TOKEN}`);
      assert.equal(first.status, 200);
      assert.equal(first.json.data.data.length, limit);
      assert.deepEqual([first.json.data.pagination.limit, first.json.data.pagination.total, first.json.data.pagination.totalPages], [limit, TOTAL, pages], `limit ${limit}`);
      const last = await api("admin", "GET", `/lead/leads?limit=${limit}&page=${pages}&search=${TOKEN}`);
      assert.equal(last.json.data.data.length, TOTAL - limit * (pages - 1));
    }
    // default is 20, and the filter still narrows the total
    const def = await api("admin", "GET", `/lead/leads?search=${TOKEN}`);
    assert.equal(def.json.data.data.length, 20);
    const seg = await api("admin", "GET", `/lead/leads?limit=100&search=${TOKEN}&segmentId=${segmentId}`);
    assert.equal(seg.json.data.pagination.total, TOTAL);
    assert.equal((await api("admin", "GET", `/lead/leads?limit=100&search=${TOKEN}-00`)).json.data.pagination.total, 10, "search narrows the total");
    // pages do not overlap
    const p1 = (await api("admin", "GET", `/lead/leads?limit=50&page=1&search=${TOKEN}`)).json.data.data.map((l: any) => l.id);
    const p2 = (await api("admin", "GET", `/lead/leads?limit=50&page=2&search=${TOKEN}`)).json.data.data.map((l: any) => l.id);
    assert.equal(new Set([...p1, ...p2]).size, 100);
    assert.equal((await api("admin", "GET", `/lead/leads?limit=101&search=${TOKEN}`)).status, 400, "more than 100 per page is refused");
  });
});

describe("bulk delete: who may, and the confirmation rules", () => {
  it("only an Admin; a manager, a salesperson and an anonymous caller are refused and nothing is deleted", async () => {
    const body = { filter: searchFilter, expectedCount: TOTAL - WITH_ORDERS, confirm: true };
    for (const who of ["manager", "sales"]) {
      assert.equal((await api(who, "POST", "/lead/leads/bulk/delete", body)).status, 403, who);
      assert.equal((await api(who, "POST", "/lead/leads/bulk/delete/preview", { filter: searchFilter })).status, 403, who);
    }
    assert.equal((await api(null, "POST", "/lead/leads/bulk/delete", body)).status, 401);
    assert.equal(await alive(), TOTAL);
  });

  it("without confirm, with a wrong shape, or with a stale count, nothing is deleted", async () => {
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { filter: searchFilter, expectedCount: TOTAL - WITH_ORDERS })).status, 400, "no confirm flag");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { filter: searchFilter, expectedCount: 5, confirm: true, continuation: true })).status, 409, "a continuation is not a way around the check on a stale count... ");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { filter: searchFilter, leadIds: [randomUUID()], expectedCount: 1, confirm: true })).status, 400, "ids and filter together");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { expectedCount: 1, confirm: true })).status, 400, "neither");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { filter: {}, expectedCount: 1, confirm: true })).status, 400, "an empty filter would mean every lead");
    const stale = await api("admin", "POST", "/lead/leads/bulk/delete", { filter: searchFilter, expectedCount: TOTAL, confirm: true });
    assert.equal(stale.status, 409);
    assert.match(stale.json.message, /number of leads changed/);
    assert.equal(await alive(), TOTAL);
  });

  it("the preview counts what will be deleted and what is kept because it has orders", async () => {
    const p = await api("admin", "POST", "/lead/leads/bulk/delete/preview", { filter: searchFilter });
    assert.deepEqual(p.json.data, { matched: TOTAL, deletable: TOTAL - WITH_ORDERS, skippedWithOrders: WITH_ORDERS });
  });
});

describe("current page deletion versus all-matching deletion (250 leads, 4 with orders, 20 per page)", () => {
  it("Option 1: deleting the current page removes exactly those leads and nothing on other pages", async () => {
    const page = (await api("admin", "GET", `/lead/leads?limit=20&page=3&search=${TOKEN}`)).json.data.data.map((l: any) => l.id) as string[];
    assert.equal(page.length, 20);
    // rows created in one batch share a timestamp, so which page holds the leads that have orders varies; those are kept, so the expected count is computed
    const deletable = page.filter((id) => !orderLeadIds.includes(id));
    pageDeleted = deletable.length;
    const pv = await api("admin", "POST", "/lead/leads/bulk/delete/preview", { leadIds: page });
    assert.deepEqual(pv.json.data, { matched: 20, deletable: pageDeleted, skippedWithOrders: 20 - pageDeleted });
    const r = await api("admin", "POST", "/lead/leads/bulk/delete", { leadIds: page, expectedCount: pageDeleted, confirm: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.data.deleted, r.json.data.done], [pageDeleted, true]);
    assert.equal(await prisma.lead.count({ where: { id: { in: deletable } } }), 0);
    assert.equal(await prisma.lead.count({ where: { id: { in: page.filter((id) => orderLeadIds.includes(id)) } } }), 20 - pageDeleted, "a lead with orders on the page is kept");
    assert.equal(await alive(), TOTAL - pageDeleted, "everything on the other pages is untouched");
    // the list and its count follow
    assert.equal((await api("admin", "GET", `/lead/leads?limit=20&search=${TOKEN}`)).json.data.pagination.total, TOTAL - pageDeleted);
    // a segment loses those members, and the segment itself stays
    assert.equal(await prisma.leadSegment.count({ where: { segmentId } }), TOTAL - pageDeleted);
    assert.ok(await prisma.segment.findUnique({ where: { id: segmentId } }));
  });

  it("a page that contains leads with orders keeps them, and says so", async () => {
    const withOrders = await prisma.lead.findMany({ where: { id: { in: orderLeadIds } }, select: { id: true } });
    const r = await api("admin", "POST", "/lead/leads/bulk/delete", { leadIds: withOrders.map((l) => l.id), expectedCount: 0, confirm: true });
    assert.equal(r.status, 400, "none of them can be deleted");
    assert.equal(await prisma.lead.count({ where: { id: { in: orderLeadIds } } }), WITH_ORDERS);
  });

  it("the explicit-ids selection is limited to 100 leads", async () => {
    const r = await api("admin", "POST", "/lead/leads/bulk/delete/preview", { leadIds: Array.from({ length: 101 }, () => randomUUID()) });
    assert.equal(r.status, 400);
  });

  it("Option 2: all-matching deletion removes every matching lead across all pages, in several calls when the time budget runs out, and keeps leads with orders and their orders", async () => {
    const svc = new LeadService();
    const admin = { id: users.admin!.id, role: Role.ADMIN, username: users.admin!.username };
    const remainingBefore = await alive();
    assert.equal(remainingBefore, TOTAL - pageDeleted);
    // a zero budget deletes nothing and reports what is left: the client then repeats the call
    const none = await svc.bulkDeleteLeads(admin as never, { filter: searchFilter, expectedCount: remainingBefore - WITH_ORDERS }, 0);
    assert.deepEqual([none.deleted, none.remaining, none.done], [0, remainingBefore - WITH_ORDERS, false]);
    const done = await svc.bulkDeleteLeads(admin as never, { filter: searchFilter, expectedCount: remainingBefore - WITH_ORDERS, continuation: true });
    assert.deepEqual([done.deleted, done.remaining, done.done, done.skippedWithOrders], [remainingBefore - WITH_ORDERS, 0, true, WITH_ORDERS]);
    assert.equal(await alive(), WITH_ORDERS, "only the leads with orders are left");
    assert.equal(await prisma.order.count({ where: { id: { in: orderIds } } }), WITH_ORDERS, "no order was deleted");
    assert.equal(await prisma.leadSegment.count({ where: { segmentId } }), WITH_ORDERS);
    // the lists show the new totals
    assert.equal((await api("admin", "GET", `/lead/leads?limit=100&search=${TOKEN}`)).json.data.pagination.total, WITH_ORDERS);
  });

  it("the same call over HTTP: confirm is required and a second identical call finds nothing more to delete", async () => {
    const again = await api("admin", "POST", "/lead/leads/bulk/delete", { filter: searchFilter, expectedCount: 0, confirm: true });
    assert.equal(again.status, 400);
    assert.equal(await alive(), WITH_ORDERS);
  });
});

describe("ownership scope is applied again by the service", () => {
  it("a non-admin caller of the service only ever reaches their own leads", async () => {
    // the route is Admin-only; this proves the service itself does not widen a manager's reach if it were ever exposed
    const mk = await prisma.lead.createMany({ data: [
      { id: randomUUID(), leadNumber: `BD-${tag}-s1`, firstName: `${TOKEN}-S1`, assignedManagerId: users.manager!.id },
      { id: randomUUID(), leadNumber: `BD-${tag}-s2`, firstName: `${TOKEN}-S2` },
    ] });
    assert.equal(mk.count, 2);
    const svc = new LeadService();
    const preview = await svc.previewBulkDelete({ id: users.manager!.id, role: Role.MANAGER, username: "m" } as never, { filter: { search: `${TOKEN}-S` } });
    assert.equal(preview.matched, 1, "only the manager's own lead");
  });
});

describe("single lead deletion never touches orders, items, payments or shipments", () => {
  it("a lead WITH an order is refused (409, with the order count); the lead, order, items, payment and shipment all remain", async () => {
    const lead = await prisma.lead.create({ data: { leadNumber: `BD-${tag}-single-o`, firstName: `${TOKEN}-SINGLE-ORDER` }, select: { id: true } });
    const order = await prisma.order.create({
      data: {
        orderNumber: `BDORD-${tag}-single`,
        leadId: lead.id,
        source: "SALESPERSON",
        status: "CONFIRMED",
        totalAmount: "549.00",
        items: { create: [{ productNameSnapshot: "Herbal Masala", quantity: 1, unitPrice: "500.00", totalPrice: "500.00" }, { productNameSnapshot: "Gift", quantity: 1, unitPrice: "0.00", totalPrice: "0.00" }] },
        payments: { create: [{ amount: "549.00", method: "COD", status: "PENDING" }] },
        shipments: { create: [{ status: "SHIPPED", courier: "Test Courier", trackingNumber: `AWB-${tag}` }] },
      } as never,
      select: { id: true },
    });
    orderIds.push(order.id);
    await prisma.activity.create({ data: { leadId: lead.id, orderId: order.id, type: "LEAD_CREATED" as never, title: "history" } });

    const r = await api("admin", "DELETE", `/lead/leads/${lead.id}`);
    assert.equal(r.status, 409);
    assert.match(r.json.message, /has 1 order, so it cannot be deleted/);
    assert.equal(await prisma.lead.count({ where: { id: lead.id } }), 1, "the lead is kept");
    assert.equal(await prisma.order.count({ where: { id: order.id } }), 1, "the order is kept");
    assert.equal(await prisma.orderItem.count({ where: { orderId: order.id } }), 2, "its items are kept");
    assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 1, "its payment is kept");
    assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 1, "its shipment is kept");
    assert.equal(await prisma.activity.count({ where: { leadId: lead.id } }), 1, "the lead's history is kept too (nothing was half-deleted)");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { totalAmount: true, leadId: true } });
    assert.deepEqual([o.totalAmount.toString(), o.leadId], ["549", lead.id]);
  });

  it("a lead with no orders is deleted together with its own working history, and only that lead", async () => {
    const lead = await prisma.lead.create({ data: { leadNumber: `BD-${tag}-single-n`, firstName: `${TOKEN}-SINGLE-PLAIN` }, select: { id: true } });
    const other = await prisma.lead.create({ data: { leadNumber: `BD-${tag}-single-x`, firstName: `${TOKEN}-SINGLE-OTHER` }, select: { id: true } });
    await prisma.activity.create({ data: { leadId: lead.id, type: "LEAD_CREATED" as never, title: "history" } });
    await prisma.activity.create({ data: { leadId: other.id, type: "LEAD_CREATED" as never, title: "history" } });
    const r = await api("admin", "DELETE", `/lead/leads/${lead.id}`);
    assert.equal(r.status, 200);
    assert.equal(await prisma.lead.count({ where: { id: lead.id } }), 0);
    assert.equal(await prisma.activity.count({ where: { leadId: lead.id } }), 0);
    assert.equal(await prisma.lead.count({ where: { id: other.id } }), 1);
    assert.equal(await prisma.activity.count({ where: { leadId: other.id } }), 1);
  });

  it("only an Admin may delete a lead; an unknown lead is 404", async () => {
    const lead = await prisma.lead.create({ data: { leadNumber: `BD-${tag}-single-p`, firstName: `${TOKEN}-SINGLE-PERM`, assignedManagerId: users.manager!.id, ownerId: users.sales!.id }, select: { id: true } });
    assert.equal((await api("manager", "DELETE", `/lead/leads/${lead.id}`)).status, 403);
    assert.equal((await api("sales", "DELETE", `/lead/leads/${lead.id}`)).status, 403);
    assert.equal((await api(null, "DELETE", `/lead/leads/${lead.id}`)).status, 401);
    assert.equal(await prisma.lead.count({ where: { id: lead.id } }), 1);
    assert.equal((await api("admin", "DELETE", `/lead/leads/${randomUUID()}`)).status, 404);
  });
});
