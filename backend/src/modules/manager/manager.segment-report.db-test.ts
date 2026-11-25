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
import leadRoutes from "../lead/lead.routes.js";
import { LeadWorkingStatus } from "../../../generated/prisma/enums.js";

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
  for (const [key, name, isSystem] of [["vip", `VIP Test ${tag}`, true], ["custom", `=Diwali ${tag}`, false], ["gifts", `Gifts ${tag}`, false], ["matrix", `Matrix ${tag}`, false], ["empty", `Empty ${tag}`, false]] as const) {
    segment[key] = (await prisma.segment.create({ data: { name, nameKey: name.toLowerCase(), isSystem }, select: { id: true } })).id;
  }
  const world: [string, string, string, string | null, string | null, string[], Date, object?][] = [
    // key, status, lifecycle, manager, owner, segments, created
    ["fresh", "NEW", "LEAD", "m1", "s1", ["vip"], IN],
    ["called", "RINGING", "LEAD", "m1", "s1", ["vip", "custom"], BEFORE],
    ["won", "CONVERTED", "CUSTOMER", "m1", "s1", ["vip", "gifts"], BEFORE],
    ["cart", "CONVERTED", "LEAD", "m1", "s1", ["vip", "gifts"], IN],
    ["cartCustomer", "RINGING", "CUSTOMER", "m2", "s2", ["vip"], BEFORE],
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
  const abandon = (leadId: string) => prisma.abandonment.create({ data: { leadId, type: "CHECKOUT", detectedAt: IN } });
  await abandon(lead.cart!);
  await abandon(lead.cartCustomer!);
  for (const stage of ["LEAD", "CUSTOMER"] as const) {
    for (const cart of [false, true]) {
      for (const status of Object.values(LeadWorkingStatus)) {
        n += 1;
        const key = `matrix-${stage}-${cart}-${status}`;
        const manager = n % 3 === 0 ? ids.m2! : ids.m1!;
        lead[key] = (await prisma.lead.create({ data: { leadNumber: `SG-${tag}-${n}`, firstName: key, workingStatus: status, lifecycleStage: stage, assignedManagerId: manager, ownerId: n % 2 ? ids.s1! : ids.s2!, createdAt: BEFORE, segments: { create: [{ segmentId: segment.matrix! }] } }, select: { id: true } })).id;
        if (cart) await abandon(lead[key]!);
      }
    }
  }
  const call = (l: string, agent: string, status: string, at: Date, notes?: string) => prisma.call.create({ data: { leadId: lead[l]!, agentId: ids[agent]!, provider: "test", direction: "OUTBOUND", status: status as never, startedAt: at, createdAt: at, notes: notes ?? null } });
  await call("called", "s1", "COMPLETED", IN, "asked for price");
  await call("called", "s1", "NO_ANSWER", IN);
  await call("called", "s1", "COMPLETED", BEFORE);
  await call("won", "s1", "NO_ANSWER", IN);
  await call("lost", "s2", "FAILED", IN);
  await call("outsider", "s1", "COMPLETED", IN);
  await call("cart", "s1", "COMPLETED", IN);
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
  await act("cart", "NOTE", "Cart note", IN);
  for (const [l, method, amount] of [["won", "COD", 500], ["called", "UPI", 700], ["outsider", "COD", 900]] as const) {
    orderIds.push(
      (await prisma.order.create({ data: { orderNumber: `SG-${tag}-${l}`, leadId: lead[l]!, source: "SALESPERSON", status: "CONFIRMED", totalAmount: amount, confirmedAt: IN, confirmedByUserId: ids.s1!, payments: { create: { amount, method, status: method === "UPI" ? "SUCCESS" : "PENDING" } } }, select: { id: true } })).id,
    );
  }
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use("/manager", managerRoutes);
  app.use("/lead", leadRoutes);
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
  await prisma.$executeRaw`DELETE FROM abandonments WHERE lead_id = ANY(${leadIds}::uuid[])`;
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
  it("a built-in segment lists what the Leads section lists: converted customers and abandoned-cart records are left out of the list and the total", async () => {
    const d = await report("admin", "vip");
    assert.deepEqual(names(d), ["called", "fresh", "gone", "lost", "unassigned"]);
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
    assert.deepEqual([m.totalLeads, m.contacted, m.pending, m.converted, m.lost, m.addedInPeriod], [5, 3, 2, 0, 1, 2]);
    const c = (await report("admin", "custom")).metrics;
    assert.deepEqual([c.totalLeads, c.contacted, c.pending, c.lost], [2, 2, 0, 1]);
  });
  it("calls, follow-ups and activities: only the segment's leads, activity cut to the period, open follow-ups counted now", async () => {
    const m = (await report("admin", "vip")).metrics;
    assert.deepEqual([m.calls, m.connectedCalls], [3, 1]);
    assert.deepEqual([m.followUpsCompleted, m.followUpsPending, m.followUpsOverdue], [1, 1, 1]);
    assert.deepEqual([m.activities, m.notes, m.statusChanges, m.assignments], [3, 1, 1, 1]);
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
    assert.deepEqual(names(d), ["called", "fresh", "gone"]);
    assert.deepEqual([d.metrics.totalLeads, d.metrics.calls, d.metrics.followUpsPending], [3, 2, 0]);
    assert.deepEqual([d.excluded.total, d.excluded.calls], [2, 2]);
  });
  it("segment + call status lists only leads with such a call in the period, and counts only those calls", async () => {
    const connected = await report("admin", "vip", "callStatus=CONNECTED");
    assert.deepEqual(names(connected), ["called"]);
    assert.equal(connected.metrics.calls, 1);
    const missed = await report("admin", "vip", "callStatus=NOT_CONNECTED");
    assert.deepEqual(names(missed), ["called"]);
    assert.equal(missed.metrics.calls, 1);
    assert.deepEqual(names(await report("admin", "vip", "callStatus=NOT_CONNECTED&view=excluded")), ["won"]);
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
    assert.deepEqual(names(await report("m1", "vip")), ["called", "fresh", "gone"]);
    assert.deepEqual(names(await report("m1", "vip", "view=excluded")), ["cart", "won"]);
    assert.deepEqual(names(await report("m2", "vip", "view=excluded")), ["cartCustomer"]);
    assert.equal((await get("m2", `/analytics/segment/leads/${lead.won}/history?segmentId=${segment.vip}`)).status, 404);
    assert.deepEqual(names(await report("m2", "vip")), ["lost"]);
    assert.equal((await get("m1", `/analytics/segment/leads/${lead.lost}/history?segmentId=${segment.vip}`)).status, 404);
    const { rows } = await workbook("m2", "vip");
    assert.equal(rows("Leads").length, 1);
    assert.deepEqual(rows("Excluded records").map((r) => r[2]), ["SG cartCustomer"]);
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
    assert.deepEqual(sheets, ["Summary", "Leads", "Calls", "Follow-ups", "Activity", "Excluded records", "Excluded Calls", "Excluded Follow-ups", "Excluded Activity"]);
    assert.equal(rows("Leads").length, 5);
    assert.equal(rows("Calls").length, 3);
    assert.equal(rows("Follow-ups").length, 2, "completed in the period + open now; no OTHER tasks, none completed earlier");
    assert.equal(rows("Activity").length, 3);
    // nothing is lost: the excluded records and their activity are in their own sheets
    assert.deepEqual(rows("Excluded records").map((r) => `${r[2]}:${r[0]}`).sort(), ["SG cart:Abandoned cart", "SG cartCustomer:Converted to customer", "SG won:Converted to customer"]);
    assert.deepEqual([rows("Excluded Calls").length, rows("Excluded Follow-ups").length, rows("Excluded Activity").length], [2, 1, 2]);
    const summary = (item: string) => rows("Summary").find((r) => r[0] === item)![1];
    assert.deepEqual([summary("Excluded records (not in the totals above)"), summary("Excluded: converted to customer"), summary("Excluded: abandoned cart (not a customer)")], ["3", "2", "1"]);
    const everything = JSON.stringify(["Leads", "Calls", "Follow-ups", "Activity"].map(rows));
    assert.ok(!everything.includes("SG outsider") && !everything.includes("SG dnd") && !everything.includes("Old note") && !everything.includes("SG won") && !everything.includes("SG cart"));
    assert.equal(rows("Summary").find((r) => r[0] === "Total leads (as in the Leads section)")![1], "5");
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

describe("the same segment shows the same leads in the Leads section and in Reports", () => {
  /** Every lead the real Leads endpoint returns for the filter, all pages. */
  const leadsSection = async (who: string, qs: string) => {
    const out: string[] = [];
    let total = -1;
    for (let page = 1; ; page++) {
      const res = await fetch(`${base}/lead/leads?${qs}&page=${page}&limit=20`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
      const json = (await res.json()) as any;
      assert.equal(res.status, 200, JSON.stringify(json));
      total = json.data.pagination.total;
      out.push(...json.data.data.map((l: any) => l.id));
      if (out.length >= total || json.data.data.length === 0) return { total, ids: out };
    }
  };
  const reportsSection = async (who: string, seg: string, extra: string) => {
    const out: string[] = [];
    for (let page = 1; ; page++) {
      const d = await report(who, seg, `page=${page}&pageSize=20&${extra}`);
      out.push(...d.leads.map((l: any) => l.id));
      if (page >= d.pagination.totalPages) return { total: d.metrics.totalLeads, ids: out, excluded: d.excluded };
    }
  };

  for (const seg of ["vip", "custom", "gifts", "matrix", "empty"]) {
    it(`${seg}: same total and the same records in the same order, for an Admin, each manager and each salesperson filter`, async () => {
      for (const who of ["admin", "m1", "m2"]) {
        for (const person of ["", `salespersonId=${ids.s1}`, `salespersonId=${ids.s2}`]) {
          // a manager may only pick their own salesperson in Reports
          if ((who === "m1" && person.includes(ids.s2!)) || (who === "m2" && person.includes(ids.s1!))) continue;
          const a = await leadsSection(who, `segmentId=${segment[seg]}&${person}`);
          const b = await reportsSection(who, seg, person);
          assert.equal(b.total, a.total, `${who} ${person}`);
          assert.deepEqual(b.ids, a.ids, `${who} ${person}`);
        }
      }
    });
  }

  it("every stage x abandoned-cart x status combination is either listed or excluded, never both and never lost", async () => {
    const statuses = Object.values(LeadWorkingStatus).length;
    const listed = await reportsSection("admin", "matrix", "");
    const left = await reportsSection("admin", "matrix", "view=excluded");
    assert.equal(listed.total, statuses, "only LEAD stage without a cart, every status (deactivated too, as the Leads section does)");
    assert.equal(left.ids.length, statuses * 3);
    assert.equal(new Set([...listed.ids, ...left.ids]).size, statuses * 4);
    const x = listed.excluded;
    assert.deepEqual([x.total, x.customers, x.customersFromAbandonedCart, x.abandonedCart], [statuses * 3, statuses * 2, statuses, statuses]);
    assert.equal(x.byStatus.reduce((n: number, v: any) => n + v.count, 0), x.total);
  });

  it("excluded records are reported separately, with their reason and status, and never inflate a total or metric", async () => {
    const d = await report("admin", "vip");
    assert.deepEqual([d.metrics.totalLeads, d.excluded.total, d.excluded.customers, d.excluded.customersFromAbandonedCart, d.excluded.abandonedCart, d.excluded.calls, d.excluded.activities], [5, 3, 2, 1, 1, 2, 2]);
    assert.deepEqual(d.excluded.byStatus, [{ status: "CONVERTED", count: 2 }, { status: "RINGING", count: 1 }]);
    const x = await report("admin", "vip", "view=excluded");
    assert.deepEqual(names(x), ["cart", "cartCustomer", "won"]);
    assert.deepEqual([x.view, x.pagination.total, x.metrics.totalLeads], ["excluded", 3, 5]);
    const only = await report("admin", "gifts");
    assert.deepEqual([only.metrics.totalLeads, only.leads.length, only.excluded.total], [0, 0, 2]);
  });

  it("an excluded record keeps its activity history", async () => {
    const r = await get("admin", `/analytics/segment/leads/${lead.won}/history?segmentId=${segment.vip}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.data.calls.length, r.json.data.tasks.length, r.json.data.activities.length], [1, 1, 1]);
  });
});

describe("card drill-down: the records behind every metric card", () => {
  const METRICS = ["totalLeads", "contacted", "pending", "converted", "lost", "calls", "followUpsCompleted", "followUpsPending", "activities"] as const;
  const details = async (who: string, seg: string, metric: string, extra = "") => {
    const r = await get(who, `/analytics/segment/details?segmentId=${segment[seg]}&metric=${metric}&${RANGE}&${extra}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.data;
  };
  /** Every record behind a card, walking the pages. */
  const all = async (who: string, seg: string, metric: string, extra = "", pageSize = 2) => {
    const rows: any[] = [];
    for (let page = 1; ; page++) {
      const d = await details(who, seg, metric, `page=${page}&pageSize=${pageSize}&${extra}`);
      assert.ok(d.rows.length <= pageSize);
      rows.push(...d.rows);
      if (page >= d.pagination.totalPages) return { rows, total: d.pagination.total as number, kind: d.kind as string };
    }
  };
  const keyOf = (id: string) => Object.keys(lead).find((k) => lead[k] === id)!;
  const leadsOf = (rows: any[]) => rows.map((r) => keyOf(r.leadId ?? r.id)).sort();

  it("RECONCILES: for every card, segment, viewer and filter, the paged records are exactly as many as the card says, with none repeated", async () => {
    let checked = 0;
    for (const seg of ["vip", "custom", "matrix", "empty"]) {
      for (const [who, extra] of [["admin", ""], ["admin", `salespersonId=${ids.s1}`], ["admin", "callStatus=CONNECTED"], ["admin", "callStatus=NOT_CONNECTED"], ["m1", ""], ["m2", ""]] as const) {
        const card = (await report(who, seg, extra)).metrics;
        for (const metric of METRICS) {
          const d = await all(who, seg, metric, extra, seg === "matrix" ? 5 : 2);
          const label = `${seg} ${who} ${extra} ${metric}`;
          assert.equal(d.total, card[metric], label);
          assert.equal(d.rows.length, card[metric], label);
          assert.equal(new Set(d.rows.map((r) => r.id)).size, d.rows.length, label);
          checked++;
        }
      }
    }
    assert.equal(checked, 4 * 6 * METRICS.length);
  });

  it("lead cards list the leads of their definition", async () => {
    const who = async (metric: string) => leadsOf((await all("admin", "vip", metric)).rows);
    assert.deepEqual(await who("totalLeads"), ["called", "fresh", "gone", "lost", "unassigned"]);
    assert.deepEqual(await who("contacted"), ["called", "gone", "lost"]);
    assert.deepEqual(await who("pending"), ["fresh", "unassigned"]);
    assert.deepEqual(await who("lost"), ["lost"]);
    assert.deepEqual(await who("converted"), [], "the converted VIP records are excluded from the main report");
    for (const r of (await all("admin", "matrix", "pending", "", 50)).rows) assert.ok(["NEW", "ASSIGNED"].includes(r.status));
    assert.deepEqual((await all("admin", "matrix", "converted")).rows.map((r) => r.status), ["CONVERTED"]);
    assert.deepEqual((await all("admin", "matrix", "lost")).rows.map((r) => r.status).sort(), ["DND", "NOT_INTERESTED"]);
    const row = (await all("admin", "vip", "totalLeads")).rows.find((r) => r.id === lead.called);
    assert.deepEqual([row.salesperson, row.status, row.calls, row.notes, row.activities], [`SG s1 ${tag}`, "RINGING", 2, 1, 2]);
    assert.ok(row.phone);
  });

  it("Calls: one row per call of the period, with caller, time, status, duration and lead; none from outside the period or from excluded records", async () => {
    const d = await all("admin", "vip", "calls");
    assert.equal(d.kind, "calls");
    assert.deepEqual(d.rows.map((c) => `${keyOf(c.leadId)}:${c.status}`).sort(), ["called:COMPLETED", "called:NO_ANSWER", "lost:FAILED"]);
    const c = d.rows.find((x) => x.status === "COMPLETED");
    assert.deepEqual([c.agent, c.leadName, c.notes, c.direction], [`SG s1 ${tag}`, "SG called", "asked for price", "OUTBOUND"]);
    assert.ok(c.phone && c.at && "durationSeconds" in c && "outcome" in c);
  });

  it("Follow-ups: completed in the period and open now are listed separately, with assignee, time, status and notes; other task types never appear", async () => {
    const done = await all("admin", "vip", "followUpsCompleted");
    assert.deepEqual(done.rows.map((t) => [keyOf(t.leadId), t.type, t.status, t.overdue]), [["called", "FOLLOW_UP", "COMPLETED", false]]);
    const open = await all("admin", "vip", "followUpsPending");
    assert.deepEqual(open.rows.map((t) => [keyOf(t.leadId), t.status, t.overdue]), [["lost", "PENDING", true]]);
    assert.equal(open.rows[0].assignedTo, `SG s1 ${tag}`);
    assert.ok(open.rows[0].scheduledAt && "notes" in open.rows[0]);
  });

  it("Recorded activities: one row per activity of the period, with type, text, performer and time", async () => {
    const d = await all("admin", "vip", "activities");
    assert.deepEqual(d.rows.map((a) => `${keyOf(a.leadId)}:${a.type}`).sort(), ["called:NOTE", "called:STATUS_CHANGE", "lost:REASSIGNMENT"]);
    assert.ok(d.rows.every((a) => a.title && a.by && a.at));
    assert.ok(!JSON.stringify(d.rows).includes("Old note") && !JSON.stringify(d.rows).includes("Cart note"));
  });

  it("respects the date range: another period shows that period's calls and activities", async () => {
    const r = await get("admin", `/analytics/segment/details?segmentId=${segment.vip}&metric=calls&from=2026-10-01&to=2026-10-01`);
    assert.deepEqual([r.json.data.pagination.total, r.json.data.rows.map((c: any) => c.status)], [1, ["COMPLETED"]]);
    const a = await get("admin", `/analytics/segment/details?segmentId=${segment.vip}&metric=activities&from=2026-10-01&to=2026-10-01`);
    assert.deepEqual(a.json.data.rows.map((x: any) => x.title), ["Old note"]);
  });

  it("respects salesperson and call-status filters", async () => {
    assert.deepEqual(leadsOf((await all("admin", "vip", "totalLeads", `salespersonId=${ids.s2}`)).rows), ["lost"]);
    assert.deepEqual((await all("admin", "vip", "calls", `salespersonId=${ids.s2}`)).rows.map((c) => c.status), ["FAILED"]);
    assert.deepEqual((await all("admin", "vip", "calls", "callStatus=CONNECTED")).rows.map((c) => c.status), ["COMPLETED"]);
  });

  it("pagination: stable pages, a capped page size, and a page past the end is empty but keeps the true total", async () => {
    const a = await details("admin", "matrix", "totalLeads", "page=1&pageSize=5");
    const again = await details("admin", "matrix", "totalLeads", "page=1&pageSize=5");
    assert.deepEqual(a.rows.map((r: any) => r.id), again.rows.map((r: any) => r.id));
    assert.equal((await details("admin", "matrix", "totalLeads", "pageSize=100000")).pagination.pageSize, 100);
    const past = await details("admin", "vip", "calls", "page=9&pageSize=2");
    assert.deepEqual([past.rows.length, past.pagination.total, past.pagination.totalPages], [0, 3, 2]);
  });

  it("permissions: a manager sees only their own leads' records; others are refused on both addresses", async () => {
    assert.deepEqual((await all("m1", "vip", "calls")).rows.map((c) => keyOf(c.leadId)), ["called", "called"]);
    assert.deepEqual((await all("m2", "vip", "calls")).rows.map((c) => keyOf(c.leadId)), ["lost"]);
    for (const path of ["/analytics/segment/details?metric=calls", "/analytics/segment/details/export.xlsx?metric=calls"]) {
      const url = `${path}&segmentId=${segment.vip}&${RANGE}`;
      assert.equal((await raw("s1", url)).status, 403);
      assert.equal((await raw("hr", url)).status, 403);
      assert.equal((await raw(null, url)).status, 401);
      assert.equal((await raw("m1", `${url}&salespersonId=${ids.s2}`)).status, 404);
    }
  });

  it("rejects an unknown or missing metric, a missing segment and an unknown segment", async () => {
    for (const path of ["/analytics/segment/details", "/analytics/segment/details/export.xlsx"]) {
      assert.equal((await raw("admin", `${path}?segmentId=${segment.vip}&metric=revenue`)).status, 400);
      assert.equal((await raw("admin", `${path}?segmentId=${segment.vip}`)).status, 400);
      assert.equal((await raw("admin", `${path}?metric=calls`)).status, 400);
      assert.equal((await raw("admin", `${path}?metric=calls&segmentId=${randomUUID()}`)).status, 404);
    }
  });

  it("export: every card downloads exactly its records, for the same filters and permissions, with formulas neutralised", async () => {
    const download = async (who: string, metric: string, extra = "") => {
      const res = await raw(who, `/analytics/segment/details/export.xlsx?segmentId=${segment.vip}&metric=${metric}&${RANGE}&${extra}`);
      assert.equal(res.status, 200, `${who} ${metric}`);
      assert.match(res.headers.get("content-disposition")!, /segment-vip-test-.*\.xlsx/);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
      const rows: string[][] = [];
      book.worksheets[0]!.eachRow((r) => void rows.push((r.values as unknown[]).slice(1).map((v) => String(v ?? ""))));
      return { header: rows[0]!, rows: rows.slice(1) };
    };
    for (const [who, extra] of [["admin", ""], ["m2", ""], ["admin", `salespersonId=${ids.s1}`], ["admin", "callStatus=CONNECTED"]] as const) {
      const card = (await report(who, "vip", extra)).metrics;
      for (const metric of METRICS) assert.equal((await download(who, metric, extra)).rows.length, card[metric], `${who} ${extra} ${metric}`);
    }
    assert.ok((await download("admin", "calls")).header.includes("Telecaller / salesperson"));
    const names = (await download("admin", "totalLeads")).rows.map((r) => r[1]!);
    assert.ok(names.some((n) => n.includes("HYPERLINK")) && names.every((n) => !n.startsWith("=")));
  });
});
