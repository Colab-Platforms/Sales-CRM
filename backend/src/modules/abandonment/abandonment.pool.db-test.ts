// 24/7 abandoned-lead pool on real rows (isolated database, one rolled-back transaction per test): round robin across the pool whatever the attendance, a persisted cursor, idempotency, concurrency,
// owned leads untouched, disabled / missing members, the dry run, and the existing access rules.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import LeadService from "../lead/lead.service.js";
import { getLeadScope } from "@/lib/leadScope.js";
import { dryRun } from "./abandonment.pool.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID().slice(0, 8);
const svc = new LeadService();

async function world(tx: Prisma.TransactionClient, n = 3) {
  const manager = await tx.user.create({ data: { name: "Mgr", username: `m-${uid()}`, role: Role.MANAGER } });
  const people = [];
  for (let i = 0; i < n; i++) people.push(await tx.user.create({ data: { name: `T${i}`, username: `t${i}-${uid()}`, role: Role.SALESPERSON, reportingManagerId: manager.id } }));
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id } });
  await tx.groupMember.createMany({ data: people.map((p) => ({ groupId: group.id, userId: p.id, joinedAt: new Date(), isActive: true })) });
  const state = await tx.abandonedPoolState.create({ data: { enabled: true, enabledAt: new Date("2020-01-01T00:00:00Z") } });
  await tx.abandonedPoolMember.createMany({ data: people.map((p, i) => ({ userId: p.id, position: i })) });
  const lead = async (over: Record<string, unknown> = {}) => {
    const l = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Cart", mobile: `98${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, ...over } as never });
    await tx.abandonment.create({ data: { leadId: l.id, type: "CHECKOUT", detectedAt: new Date() } });
    return l;
  };
  const assign = (l: Awaited<ReturnType<typeof lead>>) => svc.autoAssignAbandonedFromPool(tx, l);
  const owner = async (id: string) => (await tx.lead.findUniqueOrThrow({ where: { id } })).ownerId;
  return { manager, people, state, lead, assign, owner };
}

describe("24/7 abandoned pool", () => {
  it("assigns in round-robin order to every pool member, with no attendance / work-session condition, and the cursor is stored", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 3); // none of them has a WorkSession: all are 'absent', all still receive leads
      const owners: (string | null)[] = [];
      for (let i = 0; i < 7; i++) { const l = await w.lead(); await w.assign(l); owners.push(await w.owner(l.id)); }
      const ids = w.people.map((p) => p.id);
      assert.deepEqual(owners, [0, 1, 2, 0, 1, 2, 0].map((i) => ids[i]));
      assert.equal((await tx.abandonedPoolState.findUniqueOrThrow({ where: { id: w.state.id } })).lastAssignedUserId, ids[0]);
    });
  });

  it("continues across a restart: a fresh service instance reads the stored cursor", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 3);
      await w.assign(await w.lead());
      const restarted = new LeadService(); // no in-memory state survives
      const l2 = await w.lead();
      await restarted.autoAssignAbandonedFromPool(tx, l2);
      assert.equal(await w.owner(l2.id), w.people[1]!.id);
    });
  });

  it("repeated webhooks / retries of the same lead assign once and do not move the cursor again", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 3);
      const l = await w.lead();
      assert.equal((await w.assign(l)).assigned, true);
      assert.equal(await tx.leadAssignment.count({ where: { leadId: l.id, userId: { in: w.people.map((p) => p.id) } } }), 1); // one telecaller assignment (plus the manager-level row the existing flow writes)
      const again = await w.assign(l);
      assert.deepEqual([again.assigned, again.reason], [false, "already owned"]);
      const next = await w.lead();
      await w.assign(next);
      assert.equal(await w.owner(next.id), w.people[1]!.id, "the repeats did not consume turns");
    });
  });

  it("a lead that already has an owner keeps it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 3);
      const l = await w.lead({ ownerId: w.people[2]!.id });
      const r = await w.assign(l);
      assert.deepEqual([r.assigned, r.reason], [false, "already owned"]);
      assert.equal(await w.owner(l.id), w.people[2]!.id);
    });
  });

  it("disabled or missing members are skipped (logged), never assigned to and never created; nobody eligible leaves the lead unassigned", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 3);
      await tx.user.update({ where: { id: w.people[0]!.id }, data: { status: UserStatus.INACTIVE } });
      await tx.abandonedPoolMember.create({ data: { userId: randomUUID(), position: 9 } }); // a member whose user no longer exists
      const usersBefore = await tx.user.count();
      const owners = [];
      for (let i = 0; i < 4; i++) { const l = await w.lead(); await w.assign(l); owners.push(await w.owner(l.id)); }
      assert.deepEqual(owners, [w.people[1]!.id, w.people[2]!.id, w.people[1]!.id, w.people[2]!.id]);
      assert.equal(await tx.user.count(), usersBefore);
      await tx.user.update({ where: { id: w.people[1]!.id }, data: { status: UserStatus.INACTIVE } });
      await tx.user.update({ where: { id: w.people[2]!.id }, data: { status: UserStatus.INACTIVE } });
      const l = await w.lead();
      assert.deepEqual([(await w.assign(l)).assigned, await w.owner(l.id)], [false, null]);
    });
  });

  it("pool off (no state / disabled) changes nothing: the lead stays for the existing auto-assign", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 2);
      await tx.abandonedPoolState.update({ where: { id: w.state.id }, data: { enabled: false } });
      const l = await w.lead();
      assert.deepEqual([(await w.assign(l)).reason, await w.owner(l.id)], ["pool disabled", null]);
    });
  });

  it("the dry run counts the unassigned historical leads, excludes owned ones, and previews the same sequence the assignment would use", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 3);
      const base = await dryRun(tx as never);
      for (let i = 0; i < 5; i++) await w.lead();
      await w.lead({ ownerId: w.people[0]!.id }); // owned: not counted
      const d = await dryRun(tx as never);
      assert.equal(d.unassignedLeads - base.unassignedLeads, 5);
      assert.equal(d.members.length, 3);
      assert.equal(d.plan.reduce((s, p) => s + p.leads, 0), d.unassignedLeads);
      assert.ok(Math.max(...d.plan.map((p) => p.leads)) - Math.min(...d.plan.map((p) => p.leads)) <= 1, "an even spread");
    });
  });

  it("access rules are unchanged: the telecaller's scope contains only their own leads, the manager's still covers their team", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, 2);
      const a = await w.lead(); await w.assign(a); // -> people[0]
      const b = await w.lead(); await w.assign(b); // -> people[1]
      const scopeOf = (u: { id: string; role: Role }) => getLeadScope({ id: u.id, role: u.role, username: "x" } as never, tx as never);
      const mine = await tx.lead.findMany({ where: { id: { in: [a.id, b.id] }, ...(await scopeOf(w.people[0]!)) }, select: { id: true } });
      assert.deepEqual(mine.map((l) => l.id), [a.id]);
      const mgr = await tx.lead.findMany({ where: { id: { in: [a.id, b.id] }, ...(await scopeOf(w.manager)) }, select: { id: true } });
      assert.equal(mgr.length, 2);
    });
  });
});

// REAL concurrency: separate connections / transactions on committed rows (a single rolled-back transaction shares one connection and cannot show it). Everything created here is deleted afterwards.
describe("24/7 abandoned pool - concurrent assignment (committed rows)", () => {
  it("parallel transactions never assign one lead twice, and N leads spread evenly with no skipped or doubled turn", async () => {
    const tag = uid();
    const users: string[] = [];
    const leads: string[] = [];
    let stateId = "";
    // the shared table may already hold a real row on a shared database; this suite only ever runs on the isolated one (guarded launcher)
    const existing = await prisma.abandonedPoolState.count();
    assert.equal(existing, 0, "isolated database must not already have a pool configured");
    try {
      for (let i = 0; i < 3; i++) users.push((await prisma.user.create({ data: { name: `C${i}`, username: `c${i}-${tag}`, role: Role.SALESPERSON } })).id);
      stateId = (await prisma.abandonedPoolState.create({ data: { enabled: true, enabledAt: new Date("2020-01-01T00:00:00Z") } })).id;
      await prisma.abandonedPoolMember.createMany({ data: users.map((userId, i) => ({ userId, position: i })) });
      for (let i = 0; i < 6; i++) {
        const l = await prisma.lead.create({ data: { leadNumber: `L-${tag}-${i}`, firstName: "Cart" } });
        await prisma.abandonment.create({ data: { leadId: l.id, type: "CHECKOUT", detectedAt: new Date() } });
        leads.push(l.id);
      }
      // 6 different leads at once, plus every one of them delivered 3 times (webhook retries)
      const jobs = leads.flatMap((id) => [0, 1, 2].map(() => prisma.$transaction(async (tx) => svc.autoAssignAbandonedFromPool(tx, await tx.lead.findUniqueOrThrow({ where: { id } })), { timeout: 30_000, maxWait: 30_000 })));
      const results = await Promise.all(jobs);
      assert.equal(results.filter((r) => r.assigned).length, 6, "exactly one assignment per lead");
      const owned = await prisma.lead.findMany({ where: { id: { in: leads } }, select: { ownerId: true } });
      const per = new Map<string, number>();
      for (const o of owned) per.set(o.ownerId!, (per.get(o.ownerId!) ?? 0) + 1);
      assert.deepEqual([...per.values()].sort(), [2, 2, 2]);
      assert.equal(await prisma.leadAssignment.count({ where: { leadId: { in: leads } } }), 6);
    } finally {
      await prisma.leadAssignment.deleteMany({ where: { leadId: { in: leads } } });
      await prisma.activity.deleteMany({ where: { leadId: { in: leads } } });
      await prisma.abandonment.deleteMany({ where: { leadId: { in: leads } } });
      await prisma.lead.deleteMany({ where: { id: { in: leads } } });
      await prisma.abandonedPoolMember.deleteMany({ where: { userId: { in: users } } });
      if (stateId) await prisma.abandonedPoolState.deleteMany({ where: { id: stateId } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  });
});
