// Leads-table COLUMN FILTERS over HTTP through the REAL lead router, on real tables (isolated crm_iso only; committed throwaway data, removed afterwards).
// 120 leads with known attributes; every expected count is computed from the same data in JS, so the tests compare the server's answer with an independent calculation.
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
const TOKEN = `CF${tag}`;
const N = 120;
let server: Server;
let base = "";
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};
type Row = { id: string; first: string; last: string; mobile: string; email: string | null; src: string; status: string; priority: string; manager: string | null; owner: string | null; day: string };
let data: Row[] = [];

async function makeUser(key: string, role: Role) {
  const username = `cf-${tag}-${key}`;
  const u = await prisma.user.create({ data: { name: `CF ${key}`, username, role }, select: { id: true } });
  ids[key] = u.id;
  tokens[key] = signToken({ sub: u.id, role, username } as never);
}
const get = async (who: string, qs: string) => {
  const res = await fetch(`${base}/lead/leads?${qs}`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
  return { status: res.status, json: (await res.json()) as any };
};
const post = async (who: string, path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${tokens[who]}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
/** Server total for the filter (always inside this suite's leads: search=TOKEN is one more AND condition). */
const total = async (qs: string, who = "admin") => (await get(who, `limit=1&search=${TOKEN}&${qs}`)).json.data.pagination.total as number;
const count = (f: (r: Row) => boolean) => data.filter(f).length;

before(async () => {
  const r = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (r[0]?.current_database !== "crm_iso") throw new Error(`GUARD: only runs on crm_iso (got ${r[0]?.current_database})`);
  await makeUser("admin", Role.ADMIN);
  await makeUser("m1", Role.MANAGER);
  await makeUser("m2", Role.MANAGER);
  await makeUser("s1", Role.SALESPERSON);
  await makeUser("s2", Role.SALESPERSON);
  for (const k of ["src1", "src2"]) ids[k] = (await prisma.source.create({ data: { name: `CF ${k} ${tag}`, code: `CF_${k}_${tag}`.toUpperCase() }, select: { id: true } })).id;
  const statuses = ["NEW", "RINGING", "INTERESTED", "CONVERTED"];
  const priorities = ["LOW", "MEDIUM", "HIGH"];
  data = Array.from({ length: N }, (_, i) => ({
    id: randomUUID(),
    first: `${TOKEN}A${i}`,
    last: i % 2 ? "Sharma" : "Verma",
    mobile: `77${String(i).padStart(8, "0")}`,
    email: i % 3 === 0 ? `lead${i}@${tag}.test` : null,
    src: i % 2 ? ids.src1! : ids.src2!,
    status: statuses[i % 4]!,
    priority: priorities[i % 3]!,
    manager: i < 40 ? ids.m1! : i < 80 ? ids.m2! : null,
    owner: i % 5 === 0 ? ids.s1! : i % 5 === 1 ? ids.s2! : null,
    day: `2026-11-${String(1 + (i % 10)).padStart(2, "0")}`,
  }));
  await prisma.lead.createMany({
    data: data.map((d, i) => ({ id: d.id, leadNumber: `CF-${tag}-${i}`, firstName: d.first, lastName: d.last, mobile: d.mobile, normalizedMobile: `+91${d.mobile}`, email: d.email, normalizedEmail: d.email, sourceId: d.src, workingStatus: d.status as never, priority: d.priority as never, assignedManagerId: d.manager, ownerId: d.owner, createdAt: new Date(`${d.day}T12:00:00+05:30`) })),
  });
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
  const leadIds = data.map((d) => d.id);
  await prisma.$executeRaw`DELETE FROM activities WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM lead_assignments WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM leads WHERE id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM sources WHERE code LIKE ${`CF_%_${tag.toUpperCase()}`}`;
  await prisma.$executeRaw`DELETE FROM users WHERE username LIKE ${`cf-${tag}-%`}`;
  await prisma.$disconnect();
});

describe("each column filter on its own (server-side, against all 120 leads)", () => {
  it("Lead: every word must appear in the first or last name, any case", async () => {
    assert.equal(await total(""), N);
    assert.equal(await total("name=sharma"), count((r) => r.last === "Sharma"));
    assert.equal(await total("name=VERMA"), count((r) => r.last === "Verma"));
    assert.equal(await total("name=verma+a1"), count((r) => r.last === "Verma" && /a1/i.test(r.first)), "two words: both must match");
    assert.equal(await total("name=nobodyatall"), 0);
  });
  it("Contact: part of the phone number or the e-mail", async () => {
    assert.equal(await total("contact=77000001"), count((r) => r.mobile.includes("77000001")));
    assert.equal(await total(`contact=@${tag}.test`), count((r) => r.email !== null));
    assert.equal(await total("contact=lead3%40"), count((r) => r.email?.startsWith("lead3@") ?? false));
    assert.equal(await total("contact=zzzz"), 0);
  });
  it("Source, Status and Priority dropdowns", async () => {
    for (const s of ["src1", "src2"]) assert.equal(await total(`sourceId=${ids[s]}`), count((r) => r.src === ids[s]));
    for (const st of ["NEW", "RINGING", "INTERESTED", "CONVERTED"]) assert.equal(await total(`workingStatus=${st}`), count((r) => r.status === st), st);
    for (const p of ["LOW", "MEDIUM", "HIGH"]) assert.equal(await total(`priority=${p}`), count((r) => r.priority === p), p);
  });
  it("Manager and Salesperson, including Unassigned", async () => {
    assert.equal(await total(`managerId=${ids.m1}`), 40);
    assert.equal(await total(`managerId=${ids.m2}`), 40);
    assert.equal(await total("managerId=NONE"), count((r) => r.manager === null));
    assert.equal(await total(`salespersonId=${ids.s1}`), count((r) => r.owner === ids.s1));
    assert.equal(await total(`salespersonId=${ids.s2}`), count((r) => r.owner === ids.s2));
    assert.equal(await total("salespersonId=NONE"), count((r) => r.owner === null));
  });
  it("Created: start date, end date, both (inclusive India days) and a single day", async () => {
    assert.equal(await total("createdFrom=2026-11-04"), count((r) => r.day >= "2026-11-04"));
    assert.equal(await total("createdTo=2026-11-03"), count((r) => r.day <= "2026-11-03"));
    assert.equal(await total("createdFrom=2026-11-03&createdTo=2026-11-05"), count((r) => r.day >= "2026-11-03" && r.day <= "2026-11-05"));
    assert.equal(await total("createdFrom=2026-11-07&createdTo=2026-11-07"), count((r) => r.day === "2026-11-07"), "one day, both ends inclusive");
    assert.equal(await total("createdFrom=2030-01-01"), 0);
  });
  it("bad values are refused (400), not ignored", async () => {
    for (const qs of ["createdFrom=24-11-2026", "createdFrom=2026-13-45", "managerId=not-an-id", "salespersonId=bogus", "priority=URGENT"]) assert.equal((await get("admin", `limit=1&${qs}`)).status, 400, qs);
  });
});

describe("filters work together, across pages and page sizes", () => {
  it("Source + Status + Manager (+ Priority + dates) all apply at once", async () => {
    const a = count((r) => r.src === ids.src1 && r.status === "RINGING" && r.manager === ids.m1);
    assert.equal(await total(`sourceId=${ids.src1}&workingStatus=RINGING&managerId=${ids.m1}`), a);
    const b = count((r) => r.src === ids.src1 && r.status === "RINGING" && r.manager === null && r.owner === null && r.priority === "MEDIUM" && r.day >= "2026-11-02" && r.day <= "2026-11-09");
    assert.equal(await total(`sourceId=${ids.src1}&workingStatus=RINGING&managerId=NONE&salespersonId=NONE&priority=MEDIUM&createdFrom=2026-11-02&createdTo=2026-11-09`), b);
    const c = count((r) => r.last === "Sharma" && r.email !== null && r.owner === ids.s1);
    assert.equal(await total(`name=sharma&contact=@${tag}.test&salespersonId=${ids.s1}`), c);
    assert.ok(a > 0 && b >= 0 && c >= 0);
  });
  it("a filter that matches more than a page is paged correctly at 20, 50 and 100: no overlap, nothing missing, correct totals", async () => {
    const want = data.filter((r) => r.src === ids.src2).map((r) => r.id).sort(); // 60 leads
    for (const limit of [20, 50, 100]) {
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(want.length / limit); page++) {
        const r = await get("admin", `limit=${limit}&page=${page}&search=${TOKEN}&sourceId=${ids.src2}`);
        assert.equal(r.json.data.pagination.total, want.length, `limit ${limit} total`);
        assert.equal(r.json.data.pagination.totalPages, Math.ceil(want.length / limit));
        seen.push(...r.json.data.data.map((l: any) => l.id));
      }
      assert.equal(new Set(seen).size, want.length, `limit ${limit}: no duplicates`);
      assert.deepEqual([...seen].sort(), want, `limit ${limit}: every matching lead and only those`);
    }
  });
  it("a Manager sees only their own leads whatever they filter by, and can filter their salespeople incl. Unassigned", async () => {
    assert.equal(await total("", "m1"), 40);
    assert.equal(await total("managerId=" + ids.m2, "m1"), 40, "the manager filter is the Admin's; a manager stays inside their own scope");
    assert.equal(await total("salespersonId=NONE", "m1"), count((r) => r.manager === ids.m1 && r.owner === null));
  });
});

describe("bulk actions use exactly the filtered selection, never every record", () => {
  it("Assign Salesperson by filter changes only the matching leads", async () => {
    const f = { sourceId: ids.src1, managerId: "NONE", priority: "HIGH" };
    const matching = data.filter((r) => r.src === ids.src1 && r.manager === null && r.priority === "HIGH");
    assert.ok(matching.length > 0);
    const before = new Map((await prisma.lead.findMany({ where: { id: { in: data.map((d) => d.id) } }, select: { id: true, ownerId: true, assignedManagerId: true } })).map((l) => [l.id, l]));
    const r = await post("admin", "/lead/leads/bulk/assign-salesperson", { filter: { ...f, search: TOKEN }, method: "MANUAL", salespersonId: ids.s2 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.assignedCount + r.json.data.unchangedCount, matching.length, "exactly the matching leads were targeted");
    const after = await prisma.lead.findMany({ where: { id: { in: data.map((d) => d.id) } }, select: { id: true, ownerId: true, assignedManagerId: true } });
    const matchIds = new Set(matching.map((m) => m.id));
    for (const l of after) {
      if (matchIds.has(l.id)) assert.equal(l.ownerId, ids.s2, "a matching lead got the salesperson");
      else assert.equal(l.ownerId, before.get(l.id)!.ownerId, "every other lead is untouched");
      assert.equal(l.assignedManagerId, before.get(l.id)!.assignedManagerId, "no manager changed");
    }
  });
  it("Assign Manager by filter, and the delete preview, both count exactly the filtered leads", async () => {
    const filter = { workingStatus: "INTERESTED", createdFrom: "2026-11-01", createdTo: "2026-11-03", search: TOKEN };
    const expected = count((r) => r.status === "INTERESTED" && r.day >= "2026-11-01" && r.day <= "2026-11-03");
    const pv = await post("admin", "/lead/leads/bulk/delete/preview", { filter });
    assert.deepEqual(pv.json.data, { matched: expected, deletable: expected, skippedWithOrders: 0 });
    const m = await post("admin", "/lead/leads/bulk/assign-manager", { filter, method: "MANUAL", managerId: ids.m1 });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal(m.json.data.assignedCount, expected);
    assert.equal(await prisma.lead.count({ where: { id: { in: data.map((d) => d.id) }, assignedManagerId: ids.m1 } }), 40 + count((r) => r.status === "INTERESTED" && r.day >= "2026-11-01" && r.day <= "2026-11-03" && r.manager !== ids.m1));
  });
  it("Delete all matching removes only the filtered leads; an empty filter is still refused", async () => {
    const filter = { priority: "HIGH", createdFrom: "2026-11-08", createdTo: "2026-11-10", search: TOKEN };
    const expected = count((r) => r.priority === "HIGH" && r.day >= "2026-11-08" && r.day <= "2026-11-10");
    assert.ok(expected > 0);
    const remainingBefore = await prisma.lead.count({ where: { id: { in: data.map((d) => d.id) } } });
    const r = await post("admin", "/lead/leads/bulk/delete", { filter, expectedCount: expected, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.deleted, expected);
    assert.equal(await prisma.lead.count({ where: { id: { in: data.map((d) => d.id) } } }), remainingBefore - expected, "everything else is still there");
    assert.equal((await post("admin", "/lead/leads/bulk/delete", { filter: {}, expectedCount: 1, confirm: true })).status, 400);
  });
});
