// Today / Yesterday / All filters of the abandoned-leads queue against the real schema. Every test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonmentService from "./abandonment.service.js";
import { buildAbandonmentListWhere } from "./abandonment.filters.js";
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
// "Now" is 2026-10-13 10:30 IST. Today (IST) = [2026-10-12T18:30Z, 2026-10-13T18:30Z); yesterday = [2026-10-11T18:30Z, 2026-10-12T18:30Z).
const NOW = new Date("2026-10-13T05:00:00Z");
const T_START = "2026-10-12T18:30:00.000Z";
const T_END = "2026-10-13T18:30:00.000Z";
const Y_START = "2026-10-11T18:30:00.000Z";
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms);

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "TL", username: `m-${uid()}`, role: Role.MANAGER } });
  const otherManager = await tx.user.create({ data: { name: "Other TL", username: `o-${uid()}`, role: Role.MANAGER } });
  const caller = await tx.user.create({ data: { name: "Caller", username: `c-${uid()}`, role: Role.SALESPERSON } });
  const otherCaller = await tx.user.create({ data: { name: "Other Caller", username: `x-${uid()}`, role: Role.SALESPERSON } });
  let n = 0;
  const cart = async (detectedAt: Date, over: { firstName?: string; managerId?: string | null; ownerId?: string | null; updatedAt?: Date } = {}) => {
    n += 1;
    const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: over.firstName ?? `Cust${n}`, mobile: `90000${String(n).padStart(5, "0")}`, normalizedMobile: `+9190000${String(n).padStart(5, "0")}`, assignedManagerId: over.managerId === undefined ? manager.id : over.managerId, ownerId: over.ownerId ?? null }, select: { id: true } });
    const a = await tx.abandonment.create({ data: { leadId: lead.id, type: AbandonmentType.CHECKOUT, detectedAt }, select: { id: true } });
    if (over.updatedAt) await tx.$executeRaw`UPDATE abandonments SET updated_at = ${over.updatedAt} WHERE id = ${a.id}::uuid`;
    return a;
  };
  const assigned: { ids: string[]; to: string }[] = [];
  const stub = { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async (_m: string, body: { leadIds: string[]; salespersonId?: string }) => { assigned.push({ ids: body.leadIds, to: body.salespersonId ?? "" }); return { assignedCount: body.leadIds.length }; } };
  const svc = new AbandonmentService(tx as never, stub as never);
  const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
  /** The same WHERE the API builds, run with the fixed clock. */
  const ids = async (query: Record<string, string>, scope: Prisma.LeadWhereInput = {}, role: Role = Role.ADMIN, extra: { skip?: number; take?: number } = {}) => {
    const parsed = validateListAbandonmentsQuery(query);
    assert.ifError(parsed.error);
    const where = buildAbandonmentListWhere(parsed.value!, scope, role, NOW);
    const rows = await tx.abandonment.findMany({ where, select: { id: true }, orderBy: [{ detectedAt: "desc" }, { id: "asc" }], skip: extra.skip, take: extra.take });
    return { ids: rows.map((r) => r.id), total: await tx.abandonment.count({ where }) };
  };
  return { admin, manager, otherManager, caller, otherCaller, cart, svc, as, ids, assigned, tx };
}
const set = (xs: string[]) => [...xs].sort();

describe("abandoned-leads date filter (by detectedAt, IST, half-open)", () => {
  it("Today returns only today's IST day; Yesterday only yesterday's; All returns everything - with the exact boundary instants", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const beforeYesterday = await w.cart(plus(Y_START, -1)); // 1 ms before yesterday began
      const yStart = await w.cart(new Date(Y_START)); // first instant of yesterday
      const yLast = await w.cart(plus(T_START, -1)); // last ms of yesterday
      const tStart = await w.cart(new Date(T_START)); // first instant of today
      const tNoon = await w.cart(new Date("2026-10-13T05:00:00Z"));
      const tLast = await w.cart(plus(T_END, -1)); // last ms of today
      const tomorrow = await w.cart(new Date(T_END)); // first instant of tomorrow
      const all = [beforeYesterday, yStart, yLast, tStart, tNoon, tLast, tomorrow].map((x) => x.id);
      assert.deepEqual(set((await w.ids({ dateRange: "today" })).ids), set([tStart.id, tNoon.id, tLast.id]));
      assert.deepEqual(set((await w.ids({ dateRange: "yesterday" })).ids), set([yStart.id, yLast.id]));
      assert.deepEqual(set((await w.ids({ dateRange: "all" })).ids), set(all));
      assert.deepEqual(set((await w.ids({})).ids), set(all), "no parameter = unchanged behaviour for existing callers");
    });
  });

  it("filters by WHEN IT WAS ABANDONED, not by updatedAt: an old checkout touched today (assignment, repeat event) stays out of Today", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const oldButTouched = await w.cart(new Date("2026-10-12T05:00:00Z"), { updatedAt: new Date("2026-10-13T04:00:00Z") });
      const freshButStale = await w.cart(new Date("2026-10-13T04:00:00Z"), { updatedAt: new Date("2026-10-01T00:00:00Z") });
      assert.deepEqual((await w.ids({ dateRange: "today" })).ids, [freshButStale.id]);
      assert.deepEqual((await w.ids({ dateRange: "yesterday" })).ids, [oldButTouched.id]);
    });
  });

  it("pagination and the total count are computed on the SAME filtered query", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (let i = 0; i < 7; i++) await w.cart(new Date(plus(T_START, (i + 1) * 60_000)));
      for (let i = 0; i < 4; i++) await w.cart(new Date(plus(Y_START, (i + 1) * 60_000)));
      const p1 = await w.ids({ dateRange: "today" }, {}, Role.ADMIN, { skip: 0, take: 3 });
      const p3 = await w.ids({ dateRange: "today" }, {}, Role.ADMIN, { skip: 6, take: 3 });
      assert.equal(p1.total, 7);
      assert.equal(p1.ids.length, 3);
      assert.equal(p3.ids.length, 1, "page 3 of 7 rows at 3 per page holds the single remainder");
      assert.equal((await w.ids({ dateRange: "yesterday" })).total, 4);
      assert.equal((await w.ids({ dateRange: "all" })).total, 11);
    });
  });

  it("search and the date filter work together (AND)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart(new Date("2026-10-13T04:00:00Z"), { firstName: "Zeenat" });
      await w.cart(new Date("2026-10-13T04:01:00Z"), { firstName: "Other" });
      const old = await w.cart(new Date("2026-10-12T04:00:00Z"), { firstName: "Zeenat" });
      assert.deepEqual((await w.ids({ dateRange: "today", search: "zeenat" })).ids, [a.id]);
      assert.deepEqual((await w.ids({ dateRange: "yesterday", search: "zeenat" })).ids, [old.id]);
      assert.equal((await w.ids({ dateRange: "all", search: "zeenat" })).total, 2);
      assert.equal((await w.ids({ dateRange: "today", search: "nobody-here" })).total, 0);
    });
  });

  it("the date filter never widens access: each role sees only its own leads whatever dateRange is sent", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mine = await w.cart(new Date("2026-10-13T04:00:00Z"), { managerId: w.manager.id, ownerId: w.caller.id });
      const myTeamOther = await w.cart(new Date("2026-10-13T04:01:00Z"), { managerId: w.manager.id, ownerId: w.otherCaller.id });
      const foreign = await w.cart(new Date("2026-10-13T04:02:00Z"), { managerId: w.otherManager.id });
      const unassigned = await w.cart(new Date("2026-10-13T04:03:00Z"), { managerId: null });
      const callerScope = { ownerId: w.caller.id };
      const managerScope = { assignedManagerId: w.manager.id };
      for (const range of ["today", "yesterday", "all"] as const) {
        const c = (await w.ids({ dateRange: range }, callerScope, Role.SALESPERSON)).ids;
        const m = (await w.ids({ dateRange: range }, managerScope, Role.MANAGER)).ids;
        for (const id of [foreign.id, unassigned.id, myTeamOther.id]) assert.ok(!c.includes(id), `salesperson never sees ${range}`);
        for (const id of [foreign.id, unassigned.id]) assert.ok(!m.includes(id), `manager never sees ${range}`);
        if (range !== "yesterday") {
          assert.deepEqual(c, [mine.id]);
          assert.deepEqual(set(m), set([mine.id, myTeamOther.id]));
        }
      }
      assert.deepEqual(set((await w.ids({ dateRange: "today" })).ids), set([mine.id, myTeamOther.id, foreign.id, unassigned.id]), "admin: everything in range");
    });
  });

  it("through the real service: today's leads are listed with the right total and summary; an empty day is an empty page; 'select all' returns exactly the filtered ids", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const now = new Date();
      const t1 = await w.cart(now);
      const t2 = await w.cart(new Date(now.getTime() - 1000));
      const old = await w.cart(new Date(now.getTime() - 3 * 86_400_000)); // three days ago: neither today nor yesterday
      const q = (v: Record<string, string>) => { const r = validateListAbandonmentsQuery(v); assert.ifError(r.error); return r.value!; };
      const today = await w.svc.listAbandonments(w.as(w.admin, Role.ADMIN), q({ dateRange: "today" }));
      assert.deepEqual(set(today.items.map((i) => i.id)), set([t1.id, t2.id]));
      assert.equal(today.pagination.totalItems, 2);
      assert.equal(today.summary.total, 2, "the summary cards follow the same filter");
      const yesterday = await w.svc.listAbandonments(w.as(w.admin, Role.ADMIN), q({ dateRange: "yesterday" }));
      assert.equal(yesterday.items.length, 0, "an empty day is an empty page, not an error");
      assert.equal(yesterday.pagination.totalItems, 0);
      const all = await w.svc.listAbandonments(w.as(w.admin, Role.ADMIN), q({ dateRange: "all" }));
      assert.ok(all.items.some((i) => i.id === old.id));
      const sel = await w.svc.listMatchingIds(w.as(w.admin, Role.ADMIN), q({ dateRange: "today" }));
      assert.deepEqual(set(sel.ids), set([t1.id, t2.id]));
      assert.equal(sel.total, 2);
      assert.equal(sel.capped, false);
    });
  });

  it("assignment is untouched by the filter: a manager assigns the leads shown for Today to a telecaller; the filter does not change who is assigned, and unselected leads stay as they were", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const now = new Date();
      const a = await w.cart(now);
      const b = await w.cart(new Date(now.getTime() - 500));
      const yesterdayOne = await w.cart(new Date(now.getTime() - 3 * 86_400_000));
      const before = await tx.lead.findMany({ where: { id: { in: (await tx.abandonment.findMany({ where: { id: { in: [a.id, b.id, yesterdayOne.id] } }, select: { leadId: true } })).map((x) => x.leadId) } }, select: { id: true, ownerId: true, assignedManagerId: true } });
      const r = await w.svc.bulkAssignSalesperson(w.as(w.manager, Role.MANAGER), { abandonmentIds: [a.id, b.id], method: "MANUAL", salespersonId: w.caller.id } as never);
      assert.equal((r as any).assignedCount, 2);
      assert.equal(w.assigned.length, 1);
      const leadIds = (await tx.abandonment.findMany({ where: { id: { in: [a.id, b.id] } }, select: { leadId: true } })).map((x) => x.leadId);
      assert.deepEqual(set(w.assigned[0]!.ids), set(leadIds), "exactly the selected leads were sent for assignment - nothing else");
      // nothing was assigned or redistributed merely by listing / changing the filter
      const after = await tx.lead.findMany({ where: { id: { in: before.map((x) => x.id) } }, select: { id: true, ownerId: true, assignedManagerId: true } });
      assert.deepEqual(after, before);
    });
  });
});
