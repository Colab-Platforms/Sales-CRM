// The Abandoned Leads column filters (lead, contact, value, detected, last action, assigned to) against the real schema: each is applied by the SERVER to the whole result set
// (totals and pages agree), they combine, and they never widen a viewer's scope. Each test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, RecoveryActionType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonmentService from "./abandonment.service.js";
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
const DAY = 24 * 60 * 60 * 1000;

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Team Lead", username: `m-${uid()}`, role: Role.MANAGER } });
  const other = await tx.user.create({ data: { name: "Other Lead", username: `o-${uid()}`, role: Role.MANAGER } });
  const vini = await tx.user.create({ data: { name: "Vinita Rao", username: `v-${uid()}`, role: Role.SALESPERSON } });
  const tag = uid().slice(0, 8);
  let n = 0;
  const cart = async (o: { first: string; last?: string; mobile: string; email?: string; value?: string | null; managerId?: string | null; ownerId?: string | null; detectedAt?: Date }) => {
    n += 1;
    const lead = await tx.lead.create({ data: { leadNumber: `L-${tag}-${n}`, firstName: o.first, lastName: o.last ?? null, mobile: o.mobile, email: o.email ?? null, normalizedMobile: `+91${o.mobile}`, assignedManagerId: o.managerId ?? null, ownerId: o.ownerId ?? null }, select: { id: true } });
    const cartSnapshot = o.value === undefined ? { currency: "INR", itemCount: 1, itemNames: ["X"] } : { cartValue: o.value, currency: "INR", itemCount: 1, itemNames: ["X"] };
    const a = await tx.abandonment.create({ data: { leadId: lead.id, type: AbandonmentType.CHECKOUT, detectedAt: o.detectedAt ?? new Date(), cartSnapshot: cartSnapshot as Prisma.InputJsonValue }, select: { id: true, leadId: true } });
    return a;
  };
  const act = (a: { id: string; leadId: string }, type: RecoveryActionType, createdAt: Date) => tx.recoveryAction.create({ data: { abandonmentId: a.id, leadId: a.leadId, type, createdAt } });
  const svc = new AbandonmentService(tx as never, { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async () => ({ assignedCount: 0 }), bulkAssignSalespersonsByStaff: async () => ({ assignedCount: 0 }), bulkUpdateStatus: async () => ({ updatedCount: 0 }) } as never, null);
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  const list = (user: typeof admin, q: Record<string, string> = {}) => {
    const parsed = validateListAbandonmentsQuery({ dateRange: "all", ...q });
    assert.ifError(parsed.error);
    return svc.listAbandonments(as(user), parsed.value!);
  };
  // Only this test's own rows: every lead of this world carries the tag in its lead number.
  const mine = async (user: typeof admin, q: Record<string, string> = {}) => {
    const r = await list(user, { pageSize: "100", ...q });
    return r.items.filter((i) => i.lead.leadNumber.includes(tag));
  };
  return { admin, manager, other, vini, cart, act, svc, as, list, mine, tag };
}

describe("Abandoned Leads column filters (server side)", () => {
  it("Value: min, max and both are inclusive; a cart with no or a malformed value never matches (and never breaks the query)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.cart({ first: "Low", mobile: "9000000001", value: "99.50" });
      await w.cart({ first: "Mid", mobile: "9000000002", value: "499.00" });
      await w.cart({ first: "High", mobile: "9000000003", value: "1500" });
      await w.cart({ first: "Junk", mobile: "9000000004", value: "12abc" });
      await w.cart({ first: "None", mobile: "9000000005" });
      const names = async (q: Record<string, string>) => (await w.mine(w.admin, q)).map((i) => i.lead.firstName).sort();
      assert.deepEqual(await names({ valueMin: "100" }), ["High", "Mid"]);
      assert.deepEqual(await names({ valueMax: "499" }), ["Low", "Mid"]);
      assert.deepEqual(await names({ valueMin: "99.5", valueMax: "499" }), ["Low", "Mid"]);
      assert.deepEqual(await names({ valueMin: "5000" }), []);
      assert.equal((await w.mine(w.admin)).length, 5, "no value filter: every cart, including the ones without a value");
      assert.ok(validateListAbandonmentsQuery({ valueMin: "10", valueMax: "5" }).error, "min above max is refused");
    });
  });

  it("Last action uses the LATEST recovery action, and 'NONE' means nobody has acted", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart({ first: "CalledThenCallback", mobile: "9000000011" });
      const b = await w.cart({ first: "OnlyCall", mobile: "9000000012" });
      await w.cart({ first: "Untouched", mobile: "9000000013" });
      await w.act(a, RecoveryActionType.CALL, new Date(Date.now() - 2 * DAY));
      await w.act(a, RecoveryActionType.CALLBACK, new Date(Date.now() - DAY));
      await w.act(b, RecoveryActionType.CALL, new Date());
      const names = async (q: Record<string, string>) => (await w.mine(w.admin, q)).map((i) => i.lead.firstName).sort();
      assert.deepEqual(await names({ lastAction: "CALL" }), ["OnlyCall"], "the older CALL of the first lead does not count");
      assert.deepEqual(await names({ lastAction: "CALLBACK" }), ["CalledThenCallback"]);
      assert.deepEqual(await names({ lastAction: "NONE" }), ["Untouched"]);
      assert.deepEqual(await names({ lastAction: "CONTINUE_ORDER" }), []);
    });
  });

  it("Lead, Contact and Assigned to: case-insensitive 'contains' on name / lead number, phone / email, and the telecaller or manager name", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.cart({ first: "Radhika", last: "Sharma", mobile: "9111100001", email: "radhika@example.com", managerId: w.manager.id, ownerId: w.vini.id });
      await w.cart({ first: "Amit", last: "Verma", mobile: "9222200002", email: "amit@example.org", managerId: w.manager.id });
      const names = async (q: Record<string, string>) => (await w.mine(w.admin, q)).map((i) => i.lead.firstName).sort();
      assert.deepEqual(await names({ lead: "radhika sha" }), ["Radhika"], "every word must match, in any of first name, last name or lead number");
      assert.deepEqual(await names({ lead: w.tag }), ["Amit", "Radhika"], "lead number");
      assert.deepEqual(await names({ contact: "9222" }), ["Amit"]);
      assert.deepEqual(await names({ contact: "EXAMPLE.COM" }), ["Radhika"]);
      assert.deepEqual(await names({ assignee: "vinita" }), ["Radhika"], "the telecaller");
      assert.deepEqual(await names({ assignee: "team lead" }), ["Amit", "Radhika"], "the manager");
      assert.deepEqual(await names({ assignee: "nobody" }), []);
    });
  });

  it("Detected: a from / to range bounds detectedAt (the Today tab is not applied on top when dateRange is 'all')", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.cart({ first: "Old", mobile: "9000000021", detectedAt: new Date(Date.now() - 10 * DAY) });
      await w.cart({ first: "Recent", mobile: "9000000022", detectedAt: new Date(Date.now() - 2 * DAY) });
      const iso = (ms: number) => new Date(ms).toISOString();
      const names = async (q: Record<string, string>) => (await w.mine(w.admin, q)).map((i) => i.lead.firstName).sort();
      assert.deepEqual(await names({ dateFrom: iso(Date.now() - 4 * DAY) }), ["Recent"]);
      assert.deepEqual(await names({ dateTo: iso(Date.now() - 5 * DAY) }), ["Old"]);
      assert.deepEqual(await names({ dateFrom: iso(Date.now() - 12 * DAY), dateTo: iso(Date.now() - 1 * DAY) }), ["Old", "Recent"]);
    });
  });

  it("filters combine, and the total / pages count the WHOLE match - not just the page on screen", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (let i = 0; i < 5; i++) await w.cart({ first: `Big${i}`, mobile: `95000000${i}0`, value: "900", managerId: w.manager.id });
      await w.cart({ first: "SmallOne", mobile: "9500000099", value: "50", managerId: w.manager.id });
      const page1 = await w.list(w.admin, { valueMin: "500", assignee: "team lead", pageSize: "2", page: "1" });
      const page3 = await w.list(w.admin, { valueMin: "500", assignee: "team lead", pageSize: "2", page: "3" });
      assert.deepEqual([page1.pagination.totalItems, page1.pagination.totalPages, page1.items.length, page3.items.length], [5, 3, 2, 1]);
      assert.equal(page1.summary.total, 5, "the summary counts the same filtered set");
      const none = await w.list(w.admin, { valueMin: "500", assignee: "team lead", lead: "SmallOne" });
      assert.equal(none.pagination.totalItems, 0, "all filters must hold at once");
      // "Select all N" uses the same filters
      const parsed = validateListAbandonmentsQuery({ dateRange: "all", valueMin: "500", assignee: "team lead" });
      assert.ifError(parsed.error);
      assert.equal((await w.svc.listMatchingIds(w.as(w.admin), parsed.value!)).total, 5);
    });
  });

  it("scope is unchanged: a manager's filters only ever see their own queue", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.cart({ first: "Mine", mobile: "9000000031", value: "700", managerId: w.manager.id });
      await w.cart({ first: "NotMine", mobile: "9000000032", value: "700", managerId: w.other.id });
      assert.deepEqual((await w.mine(w.manager, { valueMin: "100" })).map((i) => i.lead.firstName), ["Mine"]);
      assert.deepEqual((await w.mine(w.admin, { valueMin: "100" })).map((i) => i.lead.firstName).sort(), ["Mine", "NotMine"]);
    });
  });
});
