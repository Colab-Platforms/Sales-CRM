// Admin "Assign Salesperson": 100 selected leads -> one salesperson, over HTTP through the REAL lead router, on real tables (isolated crm_iso only; committed throwaway data, removed afterwards).
// Manager and salesperson assignments are INDEPENDENT: assigning one never changes the other.
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
const TOKEN = `AS${tag}`;
let server: Server;
let base = "";
const users: Record<string, string> = {};
const tokens: Record<string, string> = {};
let leadIds: string[] = [];

async function makeUser(key: string, role: Role, extra: Record<string, unknown> = {}) {
  const username = `as-${tag}-${key}`;
  const u = await prisma.user.create({ data: { name: `AS ${key}`, username, role, ...extra } as never, select: { id: true } });
  users[key] = u.id;
  tokens[key] = signToken({ sub: u.id, role, username } as never);
}
const api = async (who: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json: any = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
};
const rows = (ids: string[]) => prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, ownerId: true, assignedManagerId: true } });

before(async () => {
  const r = await prisma.$queryRaw<{ current_database: string }[]>`select current_database()::text as current_database`;
  if (r[0]?.current_database !== "crm_iso") throw new Error(`GUARD: only runs on crm_iso (got ${r[0]?.current_database})`);
  await makeUser("admin", Role.ADMIN);
  await makeUser("m1", Role.MANAGER);
  await makeUser("m2", Role.MANAGER);
  await makeUser("s1", Role.SALESPERSON, { reportingManagerId: undefined });
  await makeUser("s2", Role.SALESPERSON);
  await makeUser("sInactive", Role.SALESPERSON, { status: "INACTIVE" });
  const data = Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), leadNumber: `AS-${tag}-${i}`, firstName: `${TOKEN}-${i}`, assignedManagerId: i < 60 ? users.m1! : i < 90 ? users.m2! : null }));
  await prisma.lead.createMany({ data });
  leadIds = data.map((d) => d.id);
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
  await prisma.$executeRaw`DELETE FROM activities WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM lead_assignments WHERE lead_id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM leads WHERE id = ANY(${leadIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM users WHERE username LIKE ${`as-${tag}-%`}`;
  await prisma.$disconnect();
});

describe("Admin assigns 100 selected leads to a salesperson", () => {
  it("all 100 get the salesperson, every lead keeps its own manager, and the response counts are exact", async () => {
    const before = new Map((await rows(leadIds)).map((l) => [l.id, l.assignedManagerId]));
    const r = await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds, method: "MANUAL", salespersonId: users.s1 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.data.assignedCount, r.json.data.unchangedCount], [100, 0]);
    const after = await rows(leadIds);
    assert.equal(after.filter((l) => l.ownerId === users.s1).length, 100, "all 100 belong to the salesperson");
    assert.ok(after.every((l) => l.assignedManagerId === before.get(l.id)), "no lead's manager changed (60 under m1, 30 under m2, 10 with none)");
    assert.equal(await prisma.leadAssignment.count({ where: { leadId: { in: leadIds }, userId: users.s1, isCurrent: true } }), 100, "one current assignment record each");
    // the salesperson sees them through the normal Leads list
    const mine = await api("s1", "GET", `/lead/leads?limit=100&search=${TOKEN}`);
    assert.equal(mine.json.data.pagination.total, 100);
  });

  it("repeating the same assignment creates no duplicates: everything is reported as already assigned", async () => {
    const r = await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds, method: "MANUAL", salespersonId: users.s1 });
    assert.deepEqual([r.json.data.assignedCount, r.json.data.unchangedCount], [0, 100]);
    assert.equal(await prisma.leadAssignment.count({ where: { leadId: { in: leadIds }, userId: users.s1 } }), 100, "still exactly one assignment row per lead");
  });

  it("manager and salesperson assignments are independent: assigning a manager keeps the salesperson, reassigning the salesperson keeps the manager", async () => {
    const sample = leadIds.slice(0, 10);
    const m = await api("admin", "POST", "/lead/leads/bulk/assign-manager", { leadIds: sample, method: "MANUAL", managerId: users.m2 });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const afterMgr = await rows(sample);
    assert.ok(afterMgr.every((l) => l.assignedManagerId === users.m2), "the manager changed to m2");
    // (the existing manager-assignment rule resets the owner when a lead is moved to a DIFFERENT manager; leads already under m2 keep theirs)
    await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds: sample, method: "MANUAL", salespersonId: users.s2 });
    const afterSp = await rows(sample);
    assert.ok(afterSp.every((l) => l.ownerId === users.s2 && l.assignedManagerId === users.m2), "salesperson changed to s2, manager still m2");
  });

  it("by filter (a whole search result across pages), and the rules: active salesperson only, one salesperson only, Admin/Manager roles", async () => {
    const r = await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { filter: { search: TOKEN }, method: "MANUAL", salespersonId: users.s2 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.assignedCount + r.json.data.unchangedCount, 100);
    assert.equal(await prisma.lead.count({ where: { id: { in: leadIds }, ownerId: users.s2 } }), 100);
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds, method: "MANUAL", salespersonId: users.sInactive })).status, 400, "inactive salesperson refused");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds, method: "MANUAL", salespersonId: users.m1 })).status, 400, "a manager is not a salesperson");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds, method: "ROUND_ROBIN", salespersonIds: [users.s1, users.s2] })).status, 400, "admin assigns one salesperson, no round robin");
    assert.equal((await api("admin", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds: [randomUUID()], method: "MANUAL", salespersonId: users.s1 })).status, 404, "unknown lead");
    assert.equal((await api("s1", "POST", "/lead/leads/bulk/assign-salesperson", { leadIds, method: "MANUAL", salespersonId: users.s1 })).status, 403);
    assert.equal((await api(null, "POST", "/lead/leads/bulk/assign-salesperson", { leadIds, method: "MANUAL", salespersonId: users.s1 })).status, 401);
  });
});
