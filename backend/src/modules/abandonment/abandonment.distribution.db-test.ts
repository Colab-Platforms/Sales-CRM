// Role-based abandoned-lead management against the real schema: permissions, the distribution dashboard (and that it reconciles with the list it drills into), telecaller
// isolation, and staff assignment. Every test runs in ONE transaction that is always rolled back (concurrency is in abandonment.assign-concurrency.db-test.ts).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonmentService from "./abandonment.service.js";
import LeadService from "../lead/lead.service.js";
import { abandonmentDateRangeBounds } from "./abandonment.filters.js";
import { getDistribution, getTelecallerSummary } from "./abandonment.distribution.js";
import { validateListAbandonmentsQuery } from "./abandonment.validators.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const RANGES = ["today", "yesterday", "all"] as const;

async function world(tx: Prisma.TransactionClient) {
  const mkUser = (name: string, role: Role, extra: Partial<Prisma.UserUncheckedCreateInput> = {}) => tx.user.create({ data: { name, username: `${name.toLowerCase().replace(/\s/g, "").slice(0, 8)}-${uid().slice(0, 8)}`, role, ...extra }, select: { id: true, username: true, name: true, role: true } });
  const admin = await mkUser("Admin", Role.ADMIN);
  const hr = await mkUser("Hira HR", Role.HR);
  const mgrA = await mkUser("Manager A", Role.MANAGER);
  const mgrB = await mkUser("Manager B", Role.MANAGER);
  const t1 = await mkUser("Asha Telecaller", Role.SALESPERSON, { reportingManagerId: mgrA.id });
  const t2 = await mkUser("Bela Telecaller", Role.SALESPERSON, { reportingManagerId: mgrA.id });
  const tZero = await mkUser("Zed Zero", Role.SALESPERSON, { reportingManagerId: mgrA.id });
  const t3 = await mkUser("Chitra Telecaller", Role.SALESPERSON, { reportingManagerId: mgrB.id });
  const inactive = await mkUser("Idle Inactive", Role.SALESPERSON, { reportingManagerId: mgrA.id, status: UserStatus.INACTIVE });
  const today = abandonmentDateRangeBounds("today")!;
  const yesterday = abandonmentDateRangeBounds("yesterday")!;
  const at = {
    today: (i = 1) => new Date(today.gte.getTime() + i * 1000),
    yesterday: (i = 1) => new Date(yesterday.gte.getTime() + i * 1000),
    older: (i = 1) => new Date(today.gte.getTime() - 5 * 86_400_000 + i * 1000),
  };
  let n = 0;
  const cart = async (when: Date, o: { manager?: { id: string } | null; owner?: { id: string } | null; name?: string; assignedAt?: Date } = {}) => {
    n += 1;
    const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: o.name ?? `Cust${n}`, mobile: `7${String(n).padStart(9, "0")}`, normalizedMobile: `+917${String(n).padStart(9, "0")}`, assignedManagerId: o.manager === undefined ? mgrA.id : (o.manager?.id ?? null), ownerId: o.owner?.id ?? null }, select: { id: true } });
    const a = await tx.abandonment.create({ data: { leadId: lead.id, type: AbandonmentType.CHECKOUT, detectedAt: when }, select: { id: true, leadId: true } });
    if (o.owner) await tx.leadAssignment.create({ data: { leadId: lead.id, userId: o.owner.id, assignmentType: "MANUAL", assignedAt: o.assignedAt ?? new Date(), isCurrent: true } });
    return a;
  };
  const svc = new AbandonmentService(tx as never, new LeadService());
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  const q = (v: Record<string, string>) => { const r = validateListAbandonmentsQuery(v); assert.ifError(r.error); return r.value!; };
  const listTotal = async (u: { id: string; username: string; role: Role }, v: Record<string, string>) => (await svc.listAbandonments(as(u), q({ pageSize: "100", ...v }))).pagination.totalItems;
  return { admin, hr, mgrA, mgrB, t1, t2, tZero, t3, inactive, at, cart, svc, as, q, listTotal, tx };
}
const row = (d: Awaited<ReturnType<typeof getDistribution>>, id: string) => d.telecallers.find((t) => t.userId === id);

/** The standard picture: manager A has Asha(2 today, 1 yesterday), Bela(1 today), 3 unassigned (1 today, 2 yesterday); manager B has Chitra(1 today) + 1 unassigned. */
async function standard(w: Awaited<ReturnType<typeof world>>) {
  await w.cart(w.at.today(1), { owner: w.t1 });
  await w.cart(w.at.today(2), { owner: w.t1 });
  await w.cart(w.at.yesterday(1), { owner: w.t1 });
  await w.cart(w.at.today(3), { owner: w.t2 });
  await w.cart(w.at.older(1), { owner: w.t2 });
  await w.cart(w.at.today(4)); // unassigned, manager A
  await w.cart(w.at.yesterday(2));
  await w.cart(w.at.yesterday(3));
  await w.cart(w.at.today(5), { manager: w.mgrB, owner: w.t3 });
  await w.cart(w.at.today(6), { manager: w.mgrB });
}

describe("distribution dashboard: definitions and reconciliation", () => {
  it("admin: totals reconcile with the telecaller rows and the unassigned backlog, for every period - and every number equals the list total behind it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await standard(w);
      const baseline = await Promise.all(RANGES.map((r) => w.listTotal(w.admin, { dateRange: r })));
      for (const range of RANGES) {
        const d = await getDistribution(tx as never, w.as(w.admin), range);
        const sumRows = d.telecallers.reduce((s, t) => s + t.inPeriod, 0);
        assert.equal(d.summary.total, d.summary.assigned + d.summary.unassigned, `${range}: total = assigned + unassigned`);
        assert.equal(d.summary.assigned, sumRows, `${range}: assigned = sum of telecaller rows`);
        assert.equal(d.summary.total, await w.listTotal(w.admin, { dateRange: range }), `${range}: dashboard total = list total`);
        assert.equal(d.summary.unassigned, await w.listTotal(w.admin, { dateRange: range, assignment: "UNASSIGNED_TELECALLER" }), `${range}: unassigned = list total`);
        for (const t of d.telecallers) {
          assert.equal(t.inPeriod, await w.listTotal(w.admin, { dateRange: range, salespersonId: t.userId }), `${range}: ${t.name} count = list total`);
          assert.equal(t.totalAssigned, await w.listTotal(w.admin, { dateRange: "all", salespersonId: t.userId }), `${t.name}: total assigned = list total (all)`);
          assert.equal(t.todayAbandoned, await w.listTotal(w.admin, { dateRange: "today", salespersonId: t.userId }));
          assert.equal(t.yesterdayAbandoned, await w.listTotal(w.admin, { dateRange: "yesterday", salespersonId: t.userId }));
        }
      }
      assert.ok(baseline[0]! > 0);
      const today = await getDistribution(tx as never, w.as(w.admin), "today");
      assert.deepEqual([today.summary.total, today.summary.assigned, today.summary.unassigned], [6, 4, 2]);
      assert.equal(today.summary.todayTotal, 6);
      assert.equal(today.summary.yesterdayTotal, 3);
      assert.equal(today.summary.telecallersWithLeads, 3);
      assert.equal(today.summary.unassignedAllTime, 4, "the standing backlog is all periods");
      const yday = await getDistribution(tx as never, w.as(w.admin), "yesterday");
      assert.deepEqual([yday.summary.total, yday.summary.assigned, yday.summary.unassigned], [3, 1, 2]);
      const all = await getDistribution(tx as never, w.as(w.admin), "all");
      assert.deepEqual([all.summary.total, all.summary.assigned, all.summary.unassigned], [10, 6, 4]);
    });
  });

  it("the table lists telecallers with ZERO leads (active ones), orders by workload, and shows leads held by an inactive telecaller so totals still add up", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await standard(w);
      await w.cart(w.at.today(7), { owner: w.inactive });
      const d = await getDistribution(tx as never, w.as(w.admin), "today");
      assert.deepEqual(row(d, w.tZero.id), { userId: w.tZero.id, name: "Zed Zero", totalAssigned: 0, inPeriod: 0, todayAbandoned: 0, yesterdayAbandoned: 0, assignedToday: 0, assignedInPeriod: 0 });
      assert.ok(row(d, w.inactive.id), "an inactive telecaller who still holds leads is listed");
      assert.equal(d.summary.assigned, d.telecallers.reduce((s, t) => s + t.inPeriod, 0));
      const totals = d.telecallers.map((t) => t.totalAssigned);
      assert.deepEqual(totals, [...totals].sort((a, b) => b - a), "busiest first");
    });
  });

  it("'abandoned in a period' and 'assigned in a period' are different numbers: assignment time moves one, not the other", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const today = abandonmentDateRangeBounds("today")!;
      // abandoned yesterday, but assigned to Asha TODAY
      await w.cart(w.at.yesterday(1), { owner: w.t1, assignedAt: new Date(today.gte.getTime() + 60_000) });
      // abandoned today, but assigned long ago
      await w.cart(w.at.today(1), { owner: w.t1, assignedAt: new Date(today.gte.getTime() - 3 * 86_400_000) });
      const d = await getDistribution(tx as never, w.as(w.admin), "today");
      const r = row(d, w.t1.id)!;
      assert.equal(r.todayAbandoned, 1, "abandoned today: 1");
      assert.equal(r.yesterdayAbandoned, 1, "abandoned yesterday: 1");
      assert.equal(r.assignedToday, 1, "assigned today (by assignment time): 1");
      assert.equal(r.totalAssigned, 2, "currently assigned: 2");
      const me = await getTelecallerSummary(tx as never, w.as(w.t1));
      assert.deepEqual([me.totalAssigned, me.today, me.yesterday, me.all, me.newlyAssignedToday], [2, 1, 1, 2, 1]);
    });
  });

  it("an assignment that was REPLACED (not current) never counts as 'assigned today' for the previous telecaller", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart(w.at.today(1), { owner: w.t1 });
      await tx.leadAssignment.updateMany({ where: { leadId: a.leadId }, data: { isCurrent: false, unassignedAt: new Date() } });
      await tx.lead.update({ where: { id: a.leadId }, data: { ownerId: w.t2.id } });
      await tx.leadAssignment.create({ data: { leadId: a.leadId, userId: w.t2.id, assignmentType: "REASSIGNMENT", assignedAt: new Date(), isCurrent: true } });
      const d = await getDistribution(tx as never, w.as(w.admin), "today");
      assert.equal(row(d, w.t1.id)!.assignedToday, 0);
      assert.equal(row(d, w.t1.id)!.totalAssigned, 0);
      assert.equal(row(d, w.t2.id)!.assignedToday, 1);
    });
  });
});

describe("role-based access", () => {
  it("manager: sees only their own leads and their own team in the breakdown; the totals still reconcile; another manager's data never appears", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await standard(w);
      const d = await getDistribution(tx as never, w.as(w.mgrA), "all");
      assert.deepEqual(d.summary.total, 8, "manager A: 3 + 1 + 1 (Bela) ... only A's leads");
      assert.equal(d.summary.total, await w.listTotal(w.mgrA, { dateRange: "all" }));
      const ids = d.telecallers.map((t) => t.userId);
      assert.ok(ids.includes(w.t1.id) && ids.includes(w.t2.id) && ids.includes(w.tZero.id));
      assert.ok(!ids.includes(w.t3.id), "another manager's telecaller is not shown");
      assert.equal(d.summary.assigned, d.telecallers.reduce((s, t) => s + t.inPeriod, 0));
      const b = await getDistribution(tx as never, w.as(w.mgrB), "all");
      assert.equal(b.summary.total, 2);
      assert.deepEqual(b.telecallers.map((t) => t.userId), [w.t3.id]);
    });
  });

  it("HR: sees the same distribution and list as admin (for distribution only) but can NOT open a lead, its prefill, or work it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await standard(w);
      const hr = w.as(w.hr);
      const dh = await getDistribution(tx as never, hr, "all");
      const da = await getDistribution(tx as never, w.as(w.admin), "all");
      assert.deepEqual(dh.summary, da.summary);
      assert.equal(await w.listTotal(w.hr, { dateRange: "all" }), await w.listTotal(w.admin, { dateRange: "all" }));
      const some = (await w.svc.listAbandonments(hr, w.q({ pageSize: "1" }))).items[0]!;
      for (const call of [() => w.svc.getAbandonment(hr, some.id), () => w.svc.getOrderPrefill(hr, some.id), () => w.svc.getAbandonmentByLead(hr, some.lead.id), () => w.svc.createRecoveryAction(hr, some.id, { type: "CALL" } as never), () => w.svc.updateStatus(hr, some.id, { status: "EXPIRED" } as never)]) {
        await assert.rejects(call, (e: any) => e.statusCode === 403);
      }
    });
  });

  it("telecaller: lists only their own leads, whatever the date range or search; naming another telecaller or manager is refused; no team distribution, no telecaller list, no assignment", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await standard(w);
      const me = w.as(w.t1);
      for (const r of RANGES) {
        const res = await w.svc.listAbandonments(me, w.q({ pageSize: "100", dateRange: r }));
        assert.ok(res.items.every((i) => i.lead.owner?.id === w.t1.id), `${r}: only own leads`);
      }
      assert.equal(await w.listTotal(w.t1, { dateRange: "all" }), 3);
      assert.equal(await w.listTotal(w.t1, { dateRange: "today" }), 2);
      assert.equal(await w.listTotal(w.t1, { dateRange: "yesterday" }), 1);
      await assert.rejects(() => w.svc.listAbandonments(me, w.q({ salespersonId: w.t2.id })), (e: any) => e.statusCode === 403);
      await assert.rejects(() => w.svc.listAbandonments(me, w.q({ managerId: w.mgrA.id })), (e: any) => e.statusCode === 403);
      await assert.rejects(() => w.svc.listMatchingIds(me, w.q({ salespersonId: w.t2.id })), (e: any) => e.statusCode === 403);
      assert.equal((await w.svc.listAbandonments(me, w.q({ salespersonId: w.t1.id }))).pagination.totalItems, 3, "naming yourself is fine");
      assert.equal((await w.svc.listAbandonments(me, w.q({ assignment: "UNASSIGNED_TELECALLER" }))).pagination.totalItems, 0, "unassigned leads are never part of a telecaller's workload");
      await assert.rejects(() => getDistribution(tx as never, me, "today"), (e: any) => e.statusCode === 403);
      await assert.rejects(() => w.svc.listAssignableTelecallers(me), (e: any) => e.statusCode === 403);
      await assert.rejects(() => w.svc.bulkAssignSalesperson(me, { abandonmentIds: [uid()], method: "MANUAL", salespersonId: w.t1.id } as never), (e: any) => e.statusCode === 403);
      const s = await getTelecallerSummary(tx as never, me);
      assert.deepEqual([s.totalAssigned, s.today, s.yesterday, s.all], [3, 2, 1, 3]);
      await assert.rejects(() => getTelecallerSummary(tx as never, w.as(w.admin)), (e: any) => e.statusCode === 403);
    });
  });

  it("a telecaller's own summary equals the list total behind each card", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await standard(w);
      for (const t of [w.t1, w.t2, w.t3, w.tZero]) {
        const s = await getTelecallerSummary(tx as never, w.as(t));
        assert.equal(s.today, await w.listTotal(t, { dateRange: "today" }), t.name);
        assert.equal(s.yesterday, await w.listTotal(t, { dateRange: "yesterday" }), t.name);
        assert.equal(s.all, await w.listTotal(t, { dateRange: "all" }), t.name);
      }
    });
  });
});

describe("staff assignment (admin / HR) and its permissions", () => {
  it("admin assigns a single unassigned lead to a telecaller: owner, one current history row, activity, manager follows the telecaller's team; counts refresh", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const lead = await w.cart(w.at.today(1), { manager: null });
      const before = await getDistribution(tx as never, w.as(w.admin), "today");
      assert.equal(before.summary.unassigned, 1);
      const r = await w.svc.bulkAssignSalesperson(w.as(w.admin), { abandonmentIds: [lead.id], method: "MANUAL", salespersonId: w.t1.id } as never);
      assert.deepEqual(r, { assignedCount: 1, unchangedCount: 0 });
      const l = await tx.lead.findUniqueOrThrow({ where: { id: lead.leadId }, select: { ownerId: true, assignedManagerId: true, workingStatus: true } });
      assert.equal(l.ownerId, w.t1.id);
      assert.equal(l.assignedManagerId, w.mgrA.id, "an unmanaged lead follows the telecaller's team manager");
      const hist = await tx.leadAssignment.findMany({ where: { leadId: lead.leadId } });
      assert.equal(hist.filter((h) => h.isCurrent).length, 1);
      assert.equal(hist[0]!.userId, w.t1.id);
      assert.equal(hist[0]!.assignedById, w.admin.id);
      assert.ok(await tx.activity.findFirst({ where: { leadId: lead.leadId, type: "ASSIGNMENT" } }));
      const after = await getDistribution(tx as never, w.as(w.admin), "today");
      assert.deepEqual([after.summary.assigned, after.summary.unassigned], [1, 0]);
      assert.equal(row(after, w.t1.id)!.totalAssigned, 1);
    });
  });

  it("HR can assign too; bulk assigns every selected lead; duplicates in the request are collapsed", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart(w.at.today(1)), b = await w.cart(w.at.today(2)), c = await w.cart(w.at.yesterday(1));
      const r = await w.svc.bulkAssignSalesperson(w.as(w.hr), { abandonmentIds: [a.id, b.id, c.id, a.id], method: "MANUAL", salespersonId: w.t2.id } as never);
      assert.deepEqual(r, { assignedCount: 3, unchangedCount: 0 });
      assert.equal(await tx.lead.count({ where: { ownerId: w.t2.id, id: { in: [a.leadId, b.leadId, c.leadId] } } }), 3);
      assert.equal(await tx.leadAssignment.count({ where: { userId: w.t2.id, isCurrent: true, leadId: { in: [a.leadId, b.leadId, c.leadId] } } }), 3);
    });
  });

  it("reassignment closes the old assignment and opens exactly one new current one; assigning to the SAME telecaller again changes nothing and adds no history", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart(w.at.today(1), { owner: w.t1 });
      const re = await w.svc.bulkAssignSalesperson(w.as(w.admin), { abandonmentIds: [a.id], method: "MANUAL", salespersonId: w.t2.id } as never);
      assert.deepEqual(re, { assignedCount: 1, unchangedCount: 0 });
      const hist = await tx.leadAssignment.findMany({ where: { leadId: a.leadId }, orderBy: { assignedAt: "asc" } });
      assert.equal(hist.filter((h) => h.isCurrent).length, 1);
      assert.equal(hist.find((h) => h.isCurrent)!.userId, w.t2.id);
      assert.equal(hist.find((h) => h.isCurrent)!.assignmentType, "REASSIGNMENT");
      assert.ok(hist.filter((h) => !h.isCurrent).every((h) => h.unassignedAt !== null));
      const rows = await tx.leadAssignment.count({ where: { leadId: a.leadId } });
      const same = await w.svc.bulkAssignSalesperson(w.as(w.admin), { abandonmentIds: [a.id], method: "MANUAL", salespersonId: w.t2.id } as never);
      assert.deepEqual(same, { assignedCount: 0, unchangedCount: 1 });
      assert.equal(await tx.leadAssignment.count({ where: { leadId: a.leadId } }), rows, "no duplicate history row");
    });
  });

  it("is ATOMIC: one unknown abandoned lead in the batch rejects the whole request and nothing is assigned", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart(w.at.today(1)), b = await w.cart(w.at.today(2));
      await assert.rejects(() => w.svc.bulkAssignSalesperson(w.as(w.admin), { abandonmentIds: [a.id, b.id, uid()], method: "MANUAL", salespersonId: w.t1.id } as never), (e: any) => e.statusCode === 404);
      assert.equal(await tx.lead.count({ where: { id: { in: [a.leadId, b.leadId] }, ownerId: { not: null } } }), 0);
      assert.equal(await tx.leadAssignment.count({ where: { leadId: { in: [a.leadId, b.leadId] } } }), 0);
    });
  });

  it("refuses an invalid target (a manager, an inactive telecaller, a made-up id), round-robin from admin/HR, and any telecaller caller", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart(w.at.today(1));
      const go = (user: ReturnType<typeof w.as>, body: Record<string, unknown>) => w.svc.bulkAssignSalesperson(user, { abandonmentIds: [a.id], method: "MANUAL", ...body } as never);
      await assert.rejects(() => go(w.as(w.admin), { salespersonId: w.mgrA.id }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => go(w.as(w.admin), { salespersonId: w.inactive.id }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => go(w.as(w.admin), { salespersonId: uid() }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => go(w.as(w.hr), { method: "ROUND_ROBIN", salespersonIds: [w.t1.id] }), (e: any) => e.statusCode === 400);
      await assert.rejects(() => go(w.as(w.t1), { salespersonId: w.t1.id }), (e: any) => e.statusCode === 403);
      assert.equal((await tx.lead.findUniqueOrThrow({ where: { id: a.leadId }, select: { ownerId: true } })).ownerId, null);
    });
  });

  it("who can be assigned: admin / HR see every active telecaller, a manager only their team; inactive ones never", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const names = async (u: { id: string; username: string; role: Role }) => (await w.svc.listAssignableTelecallers(w.as(u))).map((t) => t.id);
      const all = await names(w.admin);
      assert.ok([w.t1, w.t2, w.tZero, w.t3].every((t) => all.includes(t.id)) && !all.includes(w.inactive.id));
      assert.deepEqual(await names(w.hr), all);
      const team = await names(w.mgrA);
      assert.ok([w.t1, w.t2, w.tZero].every((t) => team.includes(t.id)) && !team.includes(w.t3.id) && !team.includes(w.inactive.id));
    });
  });
});
