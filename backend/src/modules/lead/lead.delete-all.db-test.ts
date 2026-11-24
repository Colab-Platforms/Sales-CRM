// "Delete All Leads": 2,577 leads, no filter, no search, over HTTP through the REAL lead router, on real tables. Run on the ISOLATED database only (it deletes every lead the Leads page lists, by design) - the suite refuses to
// run anywhere else and removes what it created. 5 of the 2,577 have orders (with items, a payment and a shipment): those must survive, together with everything attached to them.
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

const tag = randomUUID().slice(0, 6);
const TOTAL = 2577;
const WITH_ORDERS = 5;
let server: Server;
let base = "";
const users: Record<string, { id: string }> = {};
const tokens: Record<string, string> = {};
const orderIds: string[] = [];
const orderLeadIds: string[] = [];
let baseline = 0; // leads that were already in the isolated database
let base0 = { matched: 0, deletable: 0, skippedWithOrders: 0 }; // and how many of those already have orders

async function makeUser(key: string, role: Role) {
  const username = `da-${tag}-${key}`;
  const u = await prisma.user.create({ data: { name: `DA ${key}`, username, role }, select: { id: true } });
  users[key] = u;
  tokens[key] = signToken({ sub: u.id, role, username } as never);
}
const api = async (who: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json: any = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
};
const mine = () => prisma.lead.count({ where: { leadNumber: { startsWith: `DA-${tag}-` } } });

before(async () => {
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (rows[0]?.current_database !== "crm_iso") throw new Error(`GUARD: this suite deletes every lead and only runs on crm_iso (got ${rows[0]?.current_database})`);
  await makeUser("admin", Role.ADMIN);
  await makeUser("manager", Role.MANAGER);
  await makeUser("sales", Role.SALESPERSON);
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use("/lead", leadRoutes);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base0 = (await api("admin", "POST", "/lead/leads/bulk/delete/preview", { all: true })).json.data;
  baseline = base0.matched;
  const leads = Array.from({ length: TOTAL }, (_, i) => ({ id: randomUUID(), leadNumber: `DA-${tag}-${String(i).padStart(5, "0")}`, firstName: `Lead${i}`, assignedManagerId: i % 3 === 0 ? users.manager!.id : null }));
  for (let i = 0; i < leads.length; i += 1000) await prisma.lead.createMany({ data: leads.slice(i, i + 1000) });
  await prisma.activity.createMany({ data: leads.slice(0, 600).map((l) => ({ leadId: l.id, type: "LEAD_CREATED" as never, title: "test" })) });
  for (const l of leads.slice(0, WITH_ORDERS)) {
    orderLeadIds.push(l.id);
    const o = await prisma.order.create({
      data: {
        orderNumber: `DAORD-${tag}-${orderIds.length}`,
        leadId: l.id,
        source: "SALESPERSON",
        status: "CONFIRMED",
        totalAmount: "549.00",
        items: { create: [{ productNameSnapshot: "Herbal Masala", quantity: 1, unitPrice: "549.00", totalPrice: "549.00" }] },
        payments: { create: [{ amount: "549.00", method: "COD", status: "PENDING" }] },
        shipments: { create: [{ status: "SHIPPED", courier: "Test", trackingNumber: `AWB-${tag}-${orderIds.length}` }] },
      } as never,
      select: { id: true },
    });
    orderIds.push(o.id);
  }
});

after(async () => {
  server?.close();
  if (orderIds.length) {
    await prisma.$executeRaw`DELETE FROM shipments WHERE order_id = ANY(${orderIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM payments WHERE order_id = ANY(${orderIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM order_items WHERE order_id = ANY(${orderIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM orders WHERE id = ANY(${orderIds}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM activities WHERE lead_id IN (SELECT id FROM leads WHERE lead_number LIKE ${`DA-${tag}-%`})`;
  await prisma.$executeRaw`DELETE FROM leads WHERE lead_number LIKE ${`DA-${tag}-%`}`;
  await prisma.$executeRaw`DELETE FROM users WHERE username LIKE ${`da-${tag}-%`}`;
  await prisma.$disconnect();
});

describe(`Delete All Leads against ${TOTAL.toLocaleString("en-IN")} leads (no filter, no search)`, () => {
  it("the count comes from the database and covers every lead, not the 100 on a page", async () => {
    const preview = await api("admin", "POST", "/lead/leads/bulk/delete/preview", { all: true });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json.data, { matched: baseline + TOTAL, deletable: base0.deletable + TOTAL - WITH_ORDERS, skippedWithOrders: base0.skippedWithOrders + WITH_ORDERS });
    const page = await api("admin", "GET", "/lead/leads?limit=100&page=1");
    assert.equal(page.json.data.data.length, 100, "one page shows 100 rows");
    assert.equal(page.json.data.pagination.total, baseline + TOTAL, "while the total is every lead");
  });

  it("only an Admin can delete all; the typed phrase, the confirm flag and the exact count are all required, and nothing is deleted without them", async () => {
    const body = { all: true, expectedCount: base0.deletable + TOTAL - WITH_ORDERS, confirm: true, confirmText: "DELETE ALL" };
    assert.equal((await api("manager", "POST", "/lead/leads/bulk/delete", body)).status, 403);
    assert.equal((await api("sales", "POST", "/lead/leads/bulk/delete/preview", { all: true })).status, 403);
    assert.equal((await api(null, "POST", "/lead/leads/bulk/delete", body)).status, 401);
    const { confirmText: _t, ...noPhrase } = body;
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", noPhrase)).status, 400, "no phrase");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { ...body, confirmText: "delete all" })).status, 400, "the phrase is exact");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { ...body, confirm: undefined })).status, 400, "no confirm flag");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { ...body, filter: { search: "x" } })).status, 400, "all together with a filter");
    const stale = await api("admin", "POST", "/lead/leads/bulk/delete", { ...body, expectedCount: 100 });
    assert.equal(stale.status, 409, "the confirmed count (100, one page) is not the real one");
    assert.equal(await mine(), TOTAL, "nothing was deleted");
  });

  it("deletes ALL of them in batches, reports progress, skips the leads with orders, and keeps every order, item, payment and shipment", async () => {
    const expected = base0.deletable + TOTAL - WITH_ORDERS;
    let deleted = 0;
    let calls = 0;
    let last: any = null;
    const progress: number[] = [];
    for (let first = true; ; first = false) {
      const r = await api("admin", "POST", "/lead/leads/bulk/delete", { all: true, confirmText: "DELETE ALL", expectedCount: expected, confirm: true, ...(first ? {} : { continuation: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      calls++;
      deleted += r.json.data.deleted;
      progress.push(deleted);
      last = r.json.data;
      if (r.json.data.done || r.json.data.deleted === 0) break;
    }
    assert.equal(deleted, expected, "every deletable lead was deleted: all 2,577 (minus those with orders), not just a page");
    assert.equal(deleted, TOTAL - WITH_ORDERS + base0.deletable);
    assert.ok(deleted > 100 && deleted > 1000, "far more than one page");
    assert.deepEqual([last.done, last.remaining, last.skippedWithOrders], [true, 0, base0.skippedWithOrders + WITH_ORDERS]);
    assert.ok(progress.every((v, i) => i === 0 || v >= progress[i - 1]!), "progress only goes up");
    assert.equal(await mine(), WITH_ORDERS, "only the leads that have orders are left");
    assert.equal(await prisma.lead.count({ where: { id: { in: orderLeadIds } } }), WITH_ORDERS);
    assert.equal(await prisma.order.count({ where: { id: { in: orderIds } } }), WITH_ORDERS, "orders kept");
    assert.equal(await prisma.orderItem.count({ where: { orderId: { in: orderIds } } }), WITH_ORDERS, "order items kept");
    assert.equal(await prisma.payment.count({ where: { orderId: { in: orderIds } } }), WITH_ORDERS, "payments kept");
    assert.equal(await prisma.shipment.count({ where: { orderId: { in: orderIds } } }), WITH_ORDERS, "shipments kept");
    // the list and the count now show only what could not be deleted
    const after = await api("admin", "GET", "/lead/leads?limit=100&page=1");
    assert.equal(after.json.data.pagination.total, base0.skippedWithOrders + WITH_ORDERS);
    assert.deepEqual((await api("admin", "POST", "/lead/leads/bulk/delete/preview", { all: true })).json.data, { matched: base0.skippedWithOrders + WITH_ORDERS, deletable: 0, skippedWithOrders: base0.skippedWithOrders + WITH_ORDERS });
    // a second run has nothing to delete
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/delete", { all: true, confirmText: "DELETE ALL", expectedCount: 0, confirm: true })).status, 400);
    console.log(`DELETE ALL RESULT: targeted ${(baseline + TOTAL).toLocaleString("en-IN")} leads (${TOTAL} created + ${baseline} already there), deleted ${deleted}, skipped ${WITH_ORDERS} with orders, ${calls} call(s)`);
  });
});

// REGRESSION: a lead with real call data. call_recordings and call_transcripts (and a WhatsApp message with per-user state) point at their parents with RESTRICT, so they must be deleted first;
// the first version deleted calls before their recordings and failed with a foreign-key violation, in the single delete and in Delete All.
describe("leads with calls, recordings, transcripts, notes, tasks and WhatsApp messages", () => {
  const made: { leadId: string; orderId?: string }[] = [];
  let agentId = "";
  const extraTag = randomUUID().slice(0, 5);

  async function realisticLead(i: number, withOrder: boolean) {
    const lead = await prisma.lead.create({ data: { leadNumber: `DEP-${tag}-${extraTag}-${i}`, firstName: `Dep${i}`, mobile: `5${String(i).padStart(9, "0")}` }, select: { id: true } });
    const call = await prisma.call.create({ data: { leadId: lead.id, agentId, provider: "TEST", direction: "OUTBOUND", status: "COMPLETED", startedAt: new Date() } as never, select: { id: true } });
    await prisma.callRecording.create({ data: { callId: call.id, recordingUrl: "https://rec.test/x.mp3", status: "READY" } as never });
    await prisma.callTranscript.create({ data: { callId: call.id, transcriptText: "hello", summary: "s" } as never });
    await prisma.activity.create({ data: { leadId: lead.id, type: "LEAD_CREATED" as never, title: "note", description: "a note" } });
    await prisma.task.create({ data: { leadId: lead.id, assignedToId: agentId, type: "CALLBACK", title: "call back", scheduledAt: new Date() } as never });
    const msg = await prisma.whatsAppMessage.create({ data: { leadId: lead.id, provider: "GUPSHUP", direction: "OUTBOUND", status: "SENT", body: "hi" } as never, select: { id: true } });
    await prisma.whatsAppMessageUserState.create({ data: { messageId: msg.id, userId: agentId, starred: true } as never });
    let orderId: string | undefined;
    if (withOrder) {
      const o = await prisma.order.create({
        data: { orderNumber: `DEPORD-${tag}-${extraTag}-${i}`, leadId: lead.id, source: "SALESPERSON", status: "CONFIRMED", totalAmount: "549.00", items: { create: [{ productNameSnapshot: "X", quantity: 1, unitPrice: "549.00", totalPrice: "549.00" }] }, payments: { create: [{ amount: "549.00", method: "COD", status: "PENDING" }] }, shipments: { create: [{ status: "SHIPPED", courier: "T" }] } } as never,
        select: { id: true },
      });
      orderId = o.id;
      orderIds.push(o.id);
    }
    made.push({ leadId: lead.id, orderId });
    return lead.id;
  }
  const dependents = (ids: string[]) =>
    Promise.all([
      prisma.call.count({ where: { leadId: { in: ids } } }),
      prisma.callRecording.count({ where: { call: { leadId: { in: ids } } } }),
      prisma.callTranscript.count({ where: { call: { leadId: { in: ids } } } }),
      prisma.activity.count({ where: { leadId: { in: ids } } }),
      prisma.task.count({ where: { leadId: { in: ids } } }),
      prisma.whatsAppMessage.count({ where: { leadId: { in: ids } } }),
      prisma.whatsAppMessageUserState.count({ where: { message: { leadId: { in: ids } } } }),
    ]);

  before(async () => {
    agentId = users.sales!.id;
  });

  it("single delete of a lead with all of that data: no foreign-key error, and everything attached is gone", async () => {
    const id = await realisticLead(900, false);
    assert.deepEqual(await dependents([id]), [1, 1, 1, 1, 1, 1, 1]);
    const r = await api("admin", "DELETE", `/lead/leads/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await prisma.lead.count({ where: { id } }), 0);
    assert.deepEqual(await dependents([id]), [0, 0, 0, 0, 0, 0, 0]);
  });

  it("Delete All across SEVERAL batches (1,200 leads with calls > the 500 batch size): all deleted, none left half-deleted, leads with orders skipped and their whole history kept", async () => {
    const withData: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      // bulk-create the cheap parts; the first 40 get the full realistic set, 3 of those also have an order
      if (i < 40) withData.push(await realisticLead(i, i < 3));
      else {
        const l = await prisma.lead.create({ data: { leadNumber: `DEP-${tag}-${extraTag}-${i}`, firstName: `Dep${i}` }, select: { id: true } });
        const c = await prisma.call.create({ data: { leadId: l.id, agentId, provider: "TEST", direction: "OUTBOUND", status: "COMPLETED" } as never, select: { id: true } });
        await prisma.callRecording.create({ data: { callId: c.id, status: "READY" } as never });
        withData.push(l.id);
      }
    }
    const orderLeads = made.filter((m) => m.orderId).map((m) => m.leadId);
    assert.equal(orderLeads.length, 3);
    const mineIds = withData;
    const before = await api("admin", "POST", "/lead/leads/bulk/delete/preview", { all: true });
    const expected = before.json.data.deletable;
    let deleted = 0;
    let calls = 0;
    let last: any;
    for (let first = true; ; first = false) {
      const r = await api("admin", "POST", "/lead/leads/bulk/delete", { all: true, confirmText: "DELETE ALL", expectedCount: expected, confirm: true, ...(first ? {} : { continuation: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      calls++;
      deleted += r.json.data.deleted;
      last = r.json.data;
      if (r.json.data.done || r.json.data.deleted === 0) break;
    }
    assert.equal(deleted, expected, "the returned deleted count is exactly what was deletable");
    assert.ok(deleted >= 1197, "more than one 500-lead batch was processed");
    assert.equal(last.done, true);
    assert.ok(last.skippedWithOrders >= 3, "the leads with orders are reported as skipped");
    // everything of the deletable leads is gone, in every dependent table; nothing half-deleted
    const gone = mineIds.filter((id) => !orderLeads.includes(id));
    assert.equal(await prisma.lead.count({ where: { id: { in: gone } } }), 0);
    assert.deepEqual(await dependents(gone), [0, 0, 0, 0, 0, 0, 0]);
    // the leads with orders keep their complete data and their order history
    assert.equal(await prisma.lead.count({ where: { id: { in: orderLeads } } }), 3);
    assert.deepEqual(await dependents(orderLeads), [3, 3, 3, 3, 3, 3, 3], "their calls, recordings, transcripts, notes, tasks and messages are untouched too (the lead is kept as a whole)");
    const oids = made.filter((m) => m.orderId).map((m) => m.orderId!);
    assert.equal(await prisma.order.count({ where: { id: { in: oids } } }), 3);
    assert.equal(await prisma.orderItem.count({ where: { orderId: { in: oids } } }), 3);
    assert.equal(await prisma.payment.count({ where: { orderId: { in: oids } } }), 3);
    assert.equal(await prisma.shipment.count({ where: { orderId: { in: oids } } }), 3);
    console.log(`DEPENDENTS RESULT: ${calls} call(s), deleted ${deleted}, skipped ${last.skippedWithOrders}`);
  });

  after(async () => {
    const ids = made.map((m) => m.leadId);
    if (ids.length) {
      await prisma.$executeRaw`DELETE FROM whatsapp_message_user_states WHERE message_id IN (SELECT id FROM whatsapp_messages WHERE lead_id = ANY(${ids}::uuid[]))`;
      await prisma.$executeRaw`DELETE FROM whatsapp_messages WHERE lead_id = ANY(${ids}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM call_recordings WHERE call_id IN (SELECT id FROM calls WHERE lead_id = ANY(${ids}::uuid[]))`;
      await prisma.$executeRaw`DELETE FROM call_transcripts WHERE call_id IN (SELECT id FROM calls WHERE lead_id = ANY(${ids}::uuid[]))`;
      await prisma.$executeRaw`DELETE FROM calls WHERE lead_id = ANY(${ids}::uuid[])`;
      await prisma.$executeRaw`DELETE FROM tasks WHERE lead_id = ANY(${ids}::uuid[])`;
    }
  });
});
