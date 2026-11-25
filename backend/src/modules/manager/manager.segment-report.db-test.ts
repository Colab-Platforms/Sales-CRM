// SEGMENT LEAD REPORT over HTTP through the REAL manager router, on real tables (isolated crm_iso only; committed throwaway data, removed afterwards).
// A small world with known answers: a built-in style segment, a custom segment, leads outside both, a deactivated member, two managers, two salespeople; calls, follow-ups, activities and orders inside and outside the period.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/prisma.js";
import { signToken } from "../../lib/jwt.js";
import { Role } from "../../../generated/prisma/enums.js";
import { errorHandler } from "../../middlewares/errorHandler.js";
import { requestId } from "../../middlewares/requestId.js";
import managerRoutes from "./manager.routes.js";

const tag = randomUUID().slice(0, 6);
const FROM = "2026-11-10";
const TO = "2026-11-12";
const IN = new Date("2026-11-11T12:00:00+05:30");
const BEFORE = new Date("2026-10-01T12:00:00+05:30");
const RANGE = `from=${FROM}&to=${TO}`;
let server: Server;
let base = "";
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
const lead: Record<string, string> = {};
const segment: Record<string, string> = {};
const orderIds: string[] = [];

async function makeUser(key: string, role: Role, reportingManagerId?: string) {
  const username = `sg-${tag}-${key}`;
  const u = await prisma.user.create({ data: { name: `SG ${key} ${tag}`, username, role, ...(reportingManagerId ? { reportingManagerId } : {}) }, select: { id: true } });
  ids[key] = u.id;
  tokens[key] = signToken({ sub: u.id, role, username } as never);
}
const raw = (who: string | null, path: string) => fetch(`${base}/manager${path}`, { headers: who ? { Authorization: `Bearer ${tokens[who]}` } : {} });
const get = async (who: string | null, path: string) => {
  const res = await raw(who, path);
  return { status: res.status, json: (await res.json()) as any };
};
const report = async (who: string, seg: string, extra = "") => {
  const r = await get(who, `/analytics/segment?segmentId=${segment[seg]}&${RANGE}&${extra}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.data;
};
const names = (d: { leads: { id: string }[] }) => d.leads.map((l) => Object.keys(lead).find((k) => lead[k] === l.id)!).sort();
async function workbook(who: string, seg: string, extra = "") {
  const res = await raw(who, `/analytics/segment/export.xlsx?segmentId=${segment[seg]}&${RANGE}&${extra}`);
  assert.equal(res.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
  const rows = (name: string) => {
    const out: string[][] = [];
    book.getWorksheet(name)!.eachRow((r, i) => void (i > 1 && out.push((r.values as unknown[]).slice(1).map((v) => String(v ?? "")))));
    return out;
  };
  return { res, rows, sheets: book.worksheets.map((w) => w.name) };
}

before(async () => {
  const r = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (r[0]?.current_database !== "crm_iso") throw new Error(`GUARD: only runs on crm_iso (got ${r[0]?.current_database})`);
  await makeUser("admin", Role.ADMIN);
  await makeUser("m1", Role.MANAGER);
  await makeUser("m2", Role.MANAGER);
  await makeUser("s1", Role.SALESPERSON, ids.m1);
  await makeUser("s2", Role.SALESPERSON, ids.m2);
  await makeUser("hr", Role.HR);
  for (const [key, name, isSystem] of [["vip", `VIP Test ${tag}`, true], ["custom", `=Diwali ${tag}`, false], ["empty", `Empty ${tag}`, false]] as const) {
    segment[key] = (await prisma.segment.create({ data: { name, nameKey: name.toLowerCase(), isSystem }, select: { id: true } })).id;
  }
  const world: [string, string, string, string | null, string | null, string[], Date, object?][] = [
    // key, status, lifecycle, manager, owner, segments, created
    ["fresh", "NEW", "LEAD", "m1", "s1", ["vip"], IN],
    ["called", "RINGING", "LEAD", "m1", "s1", ["vip", "custom"], BEFORE],
    ["won", "CONVERTED", "CUSTOMER", "m1", "s1", ["vip"], BEFORE],
    ["lost", "NOT_INTERESTED", "LEAD", "m2", "s2", ["vip"], BEFORE],
    ["dnd", "DND", "LEAD", "m2", "s2", ["custom"], IN],
    ["unassigned", "NEW", "LEAD", null, null, ["vip"], BEFORE],
    ["gone", "DEACTIVATED", "LEAD", "m1", "s1", ["vip"], IN],
    ["outsider", "CONVERTED", "LEAD", "m1", "s1", [], IN],
  ];
  let n = 0;
  for (const [key, status, stage, manager, owner, segs, createdAt] of world) {
    n += 1;
    const mobile = `66${tag.replace(/\D/g, "1").padEnd(6, "0").slice(0, 6)}${String(n).padStart(2, "0")}`;
    lead[key] = (
      await prisma.lead.create({
        data: { leadNumber: `SG-${tag}-${n}`, firstName: key === "fresh" ? "=HYPERLINK(1)" : `SG ${key}`, mobile, normalizedMobile: `+91${mobile}`, workingStatus: status as never, lifecycleStage: stage as never, assignedManagerId: manager ? ids[manager]! : null, ownerId: owner ? ids[owner]! : null, createdAt, segments: { create: segs.map((s) => ({ segmentId: segment[s]! })) } },
        select: { id: true },
      })
    ).id;
  }
  const call = (l: string, agent: string, status: string, at: Date, notes?: string) => prisma.call.create({ data: { leadId: lead[l]!, agentId: ids[agent]!, provider: "test", direction: "OUTBOUND", status: status as never, startedAt: at, createdAt: at, notes: notes ?? null } });
  await call("called", "s1", "COMPLETED", IN, "asked for price");
  await call("called", "s1", "NO_ANSWER", IN);
  await call("called", "s1", "COMPLETED", BEFORE);
  await call("won", "s1", "NO_ANSWER", IN);
  await call("lost", "s2", "FAILED", IN);
  await call("outsider", "s1", "COMPLETED", IN);
  const task = (l: string, type: string, status: string, scheduledAt: Date | null, completedAt: Date | null) => prisma.task.create({ data: { leadId: lead[l]!, assignedToId: ids.s1!, type: type as never, status: status as never, title: `${type} ${l}`, scheduledAt, completedAt } });
  await task("called", "FOLLOW_UP", "COMPLETED", IN, IN);
  await task("called", "CALLBACK", "COMPLETED", BEFORE, BEFORE); // completed before the period
  await task("won", "CALLBACK", "PENDING", new Date("2099-01-01"), null);
  await task("lost", "FOLLOW_UP", "PENDING", BEFORE, null); // overdue
  await task("called", "OTHER", "PENDING", IN, null); // not a follow-up
  await task("outsider", "FOLLOW_UP", "PENDING", IN, null);
  const act = (l: string, type: string, title: string, createdAt: Date, by = "s1") => prisma.activity.create({ data: { leadId: lead[l]!, actorId: ids[by]!, type: type as never, title, createdAt } });
  await act("called", "NOTE", "Note added", IN);
  await act("called", "STATUS_CHANGE", "Status changed to RINGING", IN);
  await act("called", "NOTE", "Old note", BEFORE);
  await act("won", "ASSIGNMENT", "Assigned", IN);
  await act("lost", "REASSIGNMENT", "Reassigned", IN, "s2");
  await act("outsider", "NOTE", "Outsider note", IN);
  for (const [l, method, amount] of [["won", "COD", 500], ["called", "UPI", 700], ["outsider", "COD", 900]] as const) {
    orderIds.push(
      (await prisma.order.create({ data: { orderNumber: `SG-${tag}-${l}`, leadId: lead[l]!, source: "SALESPERSON", status: "CONFIRMED", totalAmount: amount, confirmedAt: IN, confirmedByUserId: ids.s1!, payments: { create: { amount, method, status: method === "UPI" ? "SUCCESS" : "PENDING" } } }, select: { id: true } })).id,
    );
  }
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use("/manager", managerRoutes);
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  const leadIds = Object.values(lead);
  await prisma.$executeRaw`DELETE FROM payments WHERE order_id = ANY(${orderIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM activities WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM orders WHERE id = ANY(${orderIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM tasks WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM calls WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM lead_segments WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM leads WHERE id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM segments WHERE id = ANY(${Object.values(segment)}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM users WHERE username LIKE ${`sg-${tag}-%`} AND role = 'SALESPERSON'`;
  await prisma.$executeRaw`DELETE FROM users WHERE username LIKE ${`sg-${tag}-%`}`;
  await prisma.$disconnect();
});

describe("segment membership (built-in and custom segments)", () => {
  it("a built-in segment lists exactly its members: customers included, deactivated profiles and non-members left out", async () => {
    const d = await report("admin", "vip");
    assert.deepEqual(names(d), ["called", "fresh", "lost", "unassigned", "won"]);
    assert.equal(d.metrics.totalLeads, 5);
    assert.equal(d.pagination.total, 5);
    assert.equal(d.segment.isSystem, true);
  });
  it("a custom segment lists only its own members; a lead in two segments is in both and is never duplicated", async () => {
    const d = await report("admin", "custom");
    assert.deepEqual(names(d), ["called", "dnd"]);
    assert.equal(d.segment.isSystem, false);
  });
  it("an empty segment is a real zero, and an unknown segment is 404", async () => {
    const d = await report("admin", "empty");
    assert.deepEqual([d.metrics.totalLeads, d.metrics.calls, d.leads.length], [0, 0, 0]);
    assert.equal((await get("admin", `/analytics/segment?segmentId=${randomUUID()}&${RANGE}`)).status, 404);
    assert.equal((await get("admin", `/analytics/segment?${RANGE}`)).status, 400);
    assert.equal((await get("admin", `/analytics/segment?segmentId=nope&${RANGE}`)).status, 400);
  });
});

describe("metrics and per-lead activity", () => {
  it("lead states: total = contacted + pending; converted and lost by current status", async () => {
    const m = (await report("admin", "vip")).metrics;
    assert.deepEqual([m.totalLeads, m.contacted, m.pending, m.converted, m.lost, m.addedInPeriod], [5, 3, 2, 1, 1, 1]);
    const c = (await report("admin", "custom")).metrics;
    assert.deepEqual([c.totalLeads, c.contacted, c.pending, c.lost], [2, 2, 0, 1]);
  });
  it("calls, follow-ups and activities: only the segment's leads, activity cut to the period, open follow-ups counted now", async () => {
    const m = (await report("admin", "vip")).metrics;
    assert.deepEqual([m.calls, m.connectedCalls], [4, 1]);
    assert.deepEqual([m.followUpsCompleted, m.followUpsPending, m.followUpsOverdue], [1, 2, 1]);
    assert.deepEqual([m.activities, m.notes, m.statusChanges, m.assignments], [4, 1, 1, 2]);
  });
  it("each row carries its own counts and the assigned salesperson, and no sales figure at all", async () => {
    const d = await report("admin", "vip");
    const row = d.leads.find((l: any) => l.id === lead.called);
    assert.deepEqual([row.calls, row.connectedCalls, row.activities, row.notes, row.followUpsCompleted, row.followUpsPending], [2, 1, 2, 1, 1, 0]);
    assert.equal(row.salesperson, `SG s1 ${tag}`);
    assert.equal(row.status, "RINGING");
    assert.ok(row.phone);
    assert.ok(!Object.keys(row).some((k) => /revenue|order|amount/i.test(k)));
  });
  it("pagination covers every member once", async () => {
    const seen: string[] = [];
    for (const page of [1, 2, 3]) seen.push(...(await report("admin", "vip", `page=${page}&pageSize=2`)).leads.map((l: any) => l.id));
    assert.equal(new Set(seen).size, 5);
    assert.equal(seen.length, 5);
  });
});

describe("combined filters", () => {
  it("segment + salesperson", async () => {
    const d = await report("admin", "vip", `salespersonId=${ids.s1}`);
    assert.deepEqual(names(d), ["called", "fresh", "won"]);
    assert.deepEqual([d.metrics.totalLeads, d.metrics.calls, d.metrics.followUpsPending], [3, 3, 1]);
  });
  it("segment + call status lists only leads with such a call in the period, and counts only those calls", async () => {
    const connected = await report("admin", "vip", "callStatus=CONNECTED");
    assert.deepEqual(names(connected), ["called"]);
    assert.equal(connected.metrics.calls, 1);
    const missed = await report("admin", "vip", "callStatus=NOT_CONNECTED");
    assert.deepEqual(names(missed), ["called", "won"]);
    assert.equal(missed.metrics.calls, 2);
    assert.deepEqual(names(await report("admin", "vip", `callStatus=FAILED&salespersonId=${ids.s1}`)), []);
  });
  it("the Sales figures narrow to the segment with payment and order-status filters; All Segments is unchanged", async () => {
    const sales = async (extra: string) => (await get("admin", `/analytics?${RANGE}&salespersonId=${ids.s1}&${extra}`)).json.data.kpis;
    const all = await sales("");
    assert.deepEqual([all.orders, all.revenue], [3, 2100]);
    const vip = await sales(`segmentId=${segment.vip}`);
    assert.deepEqual([vip.orders, vip.revenue], [2, 1200]);
    assert.deepEqual([(await sales(`segmentId=${segment.vip}&paymentMode=COD`)).revenue, (await sales(`segmentId=${segment.custom}`)).revenue], [500, 700]);
    assert.equal((await sales(`segmentId=${segment.vip}&orderStatus=DELIVERED`)).orders, 0);
    assert.ok(all.callsMade > vip.callsMade, "call activity is narrowed too");
  });
  it("the orders CSV respects the segment", async () => {
    const csv = async (extra: string) => (await raw("admin", `/analytics/orders.csv?${RANGE}&salespersonId=${ids.s1}&${extra}`)).text();
    assert.ok((await csv("")).includes(`SG-${tag}-outsider`));
    const vip = await csv(`segmentId=${segment.vip}`);
    assert.ok(vip.includes(`SG-${tag}-won`) && !vip.includes(`SG-${tag}-outsider`));
  });
});

describe("permissions", () => {
  it("a manager sees only the segment leads assigned to them, in the report, the history and the export", async () => {
    assert.deepEqual(names(await report("m1", "vip")), ["called", "fresh", "won"]);
    assert.deepEqual(names(await report("m2", "vip")), ["lost"]);
    assert.equal((await get("m1", `/analytics/segment/leads/${lead.lost}/history?segmentId=${segment.vip}`)).status, 404);
    const { rows } = await workbook("m2", "vip");
    assert.equal(rows("Leads").length, 1);
    assert.ok(rows("Activity").every((r) => r[1] === "SG lost"));
  });
  it("a manager cannot pick a salesperson outside their team", async () => {
    assert.equal((await get("m1", `/analytics/segment?segmentId=${segment.vip}&${RANGE}&salespersonId=${ids.s2}`)).status, 404);
    assert.equal((await get("m1", `/analytics/segment/export.xlsx?segmentId=${segment.vip}&${RANGE}&salespersonId=${ids.s2}`)).status, 404);
  });
  it("salesperson, HR and signed-out callers are refused everywhere", async () => {
    for (const path of [`/analytics/segment?segmentId=${segment.vip}`, `/analytics/segment/export.xlsx?segmentId=${segment.vip}`, `/analytics/segment/leads/${lead.won}/history?segmentId=${segment.vip}`]) {
      assert.equal((await get("s1", path)).status, 403);
      assert.equal((await get("hr", path)).status, 403);
      assert.equal((await get(null, path)).status, 401);
    }
  });
});

describe("lead history", () => {
  it("returns the lead's whole history (calls, follow-ups, notes, status changes), including before the period", async () => {
    const r = await get("admin", `/analytics/segment/leads/${lead.called}/history?segmentId=${segment.vip}`);
    assert.equal(r.status, 200);
    const h = r.json.data;
    assert.deepEqual([h.calls.length, h.tasks.length, h.activities.length], [3, 3, 3]);
    assert.ok(h.calls.some((c: any) => c.notes === "asked for price"));
  });
  it("a lead that is not in the segment is 404, and a malformed id is 400", async () => {
    assert.equal((await get("admin", `/analytics/segment/leads/${lead.outsider}/history?segmentId=${segment.vip}`)).status, 404);
    assert.equal((await get("admin", `/analytics/segment/leads/abc/history?segmentId=${segment.vip}`)).status, 400);
  });
});

describe("Excel export", () => {
  it("contains only the segment's leads with their activity for the period", async () => {
    const { res, rows, sheets } = await workbook("admin", "vip");
    assert.match(res.headers.get("content-type")!, /spreadsheetml/);
    assert.match(res.headers.get("content-disposition")!, /segment-vip-test-.*2026-11-10_2026-11-12\.xlsx/);
    assert.deepEqual(sheets, ["Summary", "Leads", "Calls", "Follow-ups", "Activity"]);
    assert.equal(rows("Leads").length, 5);
    assert.equal(rows("Calls").length, 4);
    assert.equal(rows("Follow-ups").length, 3, "completed in the period + open now; no OTHER tasks, none completed earlier");
    assert.equal(rows("Activity").length, 4);
    const everything = JSON.stringify(["Leads", "Calls", "Follow-ups", "Activity"].map(rows));
    assert.ok(!everything.includes("SG outsider") && !everything.includes("SG dnd") && !everything.includes("Old note") && !everything.includes("SG gone"));
    assert.equal(rows("Summary").find((r) => r[0] === "Total leads")![1], "5");
  });
  it("respects salesperson and call-status filters", async () => {
    const { rows } = await workbook("admin", "vip", `salespersonId=${ids.s1}&callStatus=CONNECTED`);
    assert.deepEqual(rows("Leads").map((r) => r[1]), ["SG called"]);
    assert.deepEqual(rows("Calls").map((r) => r[5]), ["COMPLETED"]);
    assert.equal(rows("Summary").find((r) => r[0] === "Salesperson")![1], `SG s1 ${tag}`);
  });
  it("neutralises spreadsheet formulas in names and segment names", async () => {
    const vip = await workbook("admin", "vip");
    const name = vip.rows("Leads").find((r) => r[1]!.includes("HYPERLINK"))![1]!;
    assert.ok(!name.startsWith("="), name);
    const custom = await workbook("admin", "custom");
    assert.ok(!custom.rows("Summary").find((r) => r[0] === "Segment")![1]!.startsWith("="));
  });
});
