// "Call attempts" on the Abandoned Leads list: the number of OUTBOUND calls placed to the lead (one Call row per placed call, whatever its outcome). Inbound calls and anything that is not a Call row
// (opening the lead, searching, filtering) are not attempts. The count is computed by the server with the list query (no per-lead query), is the same for every role that can see the lead, and never widens scope.
// Each test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentType, CallDirection, CallStatus, Role } from "../../../generated/prisma/enums.js";
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

async function world(tx: Prisma.TransactionClient) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const manager = await tx.user.create({ data: { name: "Team Lead", username: `m-${uid()}`, role: Role.MANAGER } });
  const vini = await tx.user.create({ data: { name: "Vinita Rao", username: `v-${uid()}`, role: Role.SALESPERSON } });
  const ravi = await tx.user.create({ data: { name: "Ravi Nair", username: `r-${uid()}`, role: Role.SALESPERSON } });
  const tag = uid().slice(0, 8);
  let n = 0;
  const cart = async (first: string, ownerId: string | null, managerId: string | null) => {
    n += 1;
    const lead = await tx.lead.create({ data: { leadNumber: `L-${tag}-${n}`, firstName: first, mobile: `90000${String(n).padStart(5, "0")}`, normalizedMobile: `+9190000${String(n).padStart(5, "0")}`, assignedManagerId: managerId, ownerId }, select: { id: true } });
    await tx.abandonment.create({ data: { leadId: lead.id, type: AbandonmentType.CHECKOUT, detectedAt: new Date(Date.now() - n * 1000), cartSnapshot: { currency: "INR", itemCount: 1, itemNames: ["X"] } as Prisma.InputJsonValue } });
    return lead.id;
  };
  const call = (leadId: string, agentId: string, direction: CallDirection = CallDirection.OUTBOUND, status: CallStatus = CallStatus.COMPLETED) =>
    tx.call.create({ data: { leadId, agentId, provider: "test", direction, status } });
  const svc = new AbandonmentService(tx as never, { bulkAssignManagers: async () => ({ assignedCount: 0 }), bulkAssignSalespersons: async () => ({ assignedCount: 0 }), bulkAssignSalespersonsByStaff: async () => ({ assignedCount: 0 }), bulkUpdateStatus: async () => ({ updatedCount: 0 }) } as never, null);
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  const mine = async (user: typeof admin, q: Record<string, string> = {}) => {
    const parsed = validateListAbandonmentsQuery({ dateRange: "all", pageSize: "100", ...q });
    assert.ifError(parsed.error);
    const r = await svc.listAbandonments(as(user), parsed.value!);
    return { items: r.items.filter((i) => i.lead.leadNumber.includes(tag)), total: r.pagination.totalItems };
  };
  const counts = async (user: typeof admin) => Object.fromEntries((await mine(user)).items.map((i) => [i.lead.firstName, i.lead.callAttempts]));
  return { admin, manager, vini, ravi, cart, call, svc, as, mine, counts, tag };
}

describe("Abandoned Leads - Call attempts", () => {
  it("counts the outbound calls placed to each lead (every outcome); inbound calls and leads nobody called are not attempts", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart("Alpha", w.vini.id, w.manager.id);
      const b = await w.cart("Beta", w.vini.id, w.manager.id);
      await w.cart("Gamma", w.vini.id, w.manager.id);
      for (const status of [CallStatus.COMPLETED, CallStatus.NO_ANSWER, CallStatus.BUSY]) await w.call(a, w.vini.id, CallDirection.OUTBOUND, status);
      await w.call(b, w.vini.id, CallDirection.OUTBOUND, CallStatus.NOT_REACHABLE);
      await w.call(b, w.vini.id, CallDirection.INBOUND, CallStatus.COMPLETED);
      assert.deepEqual(await w.counts(w.admin), { Alpha: 3, Beta: 1, Gamma: 0 });
    });
  });

  it("recording a new call attempt raises exactly that lead's count", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart("Alpha", w.vini.id, w.manager.id);
      const b = await w.cart("Beta", w.vini.id, w.manager.id);
      await w.call(a, w.vini.id);
      assert.deepEqual(await w.counts(w.vini), { Alpha: 1, Beta: 0 });
      await w.call(a, w.vini.id, CallDirection.OUTBOUND, CallStatus.NO_ANSWER);
      assert.deepEqual(await w.counts(w.vini), { Alpha: 2, Beta: 0 }, "the other lead is unaffected");
      await w.call(b, w.vini.id);
      assert.deepEqual(await w.counts(w.vini), { Alpha: 2, Beta: 1 });
    });
  });

  it("Admin, the assigned Manager and the assigned Telecaller see the same count for the same lead; another telecaller sees neither the lead nor its count", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart("Alpha", w.vini.id, w.manager.id);
      await w.cart("Beta", w.ravi.id, w.manager.id);
      for (let i = 0; i < 4; i++) await w.call(a, w.vini.id);
      assert.equal((await w.counts(w.admin)).Alpha, 4);
      assert.equal((await w.counts(w.manager)).Alpha, 4);
      assert.equal((await w.counts(w.vini)).Alpha, 4);
      assert.deepEqual(Object.keys(await w.counts(w.vini)), ["Alpha"], "a telecaller sees only their own leads");
      assert.deepEqual(Object.keys(await w.counts(w.ravi)), ["Beta"], "the other telecaller cannot see Alpha, so cannot see its count");
      assert.equal((await w.counts(w.ravi)).Beta, 0);
    });
  });

  it("counts stay right across pages (the same lead has the same count whatever page or page size it appears on)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await w.cart(`Lead${i}`, w.vini.id, w.manager.id));
      for (let i = 0; i < 5; i++) for (let k = 0; k <= i; k++) await w.call(ids[i]!, w.vini.id);
      const seen: Record<string, number> = {};
      for (const page of [1, 2, 3]) {
        const parsed = validateListAbandonmentsQuery({ dateRange: "all", pageSize: "2", page: String(page) });
        const r = await w.svc.listAbandonments(w.as(w.vini), parsed.value!);
        for (const i of r.items) seen[i.lead.firstName] = i.lead.callAttempts;
      }
      assert.deepEqual(seen, { Lead0: 1, Lead1: 2, Lead2: 3, Lead3: 4, Lead4: 5 });
    });
  });

  it("every row carries a numeric count (zero when nobody called), computed in the list query itself", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (let i = 0; i < 6; i++) await w.cart(`L${i}`, w.vini.id, w.manager.id);
      const before = await w.mine(w.admin);
      assert.ok(before.items.every((i) => i.lead.callAttempts === 0));
      assert.equal(typeof before.items[0]!.lead.callAttempts, "number");
    });
  });
  it("failed and ringing attempts still count; the total is split into successful / failed / ringing, and inbound calls are in none of them", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.cart("Alpha", w.vini.id, w.manager.id);
      const b = await w.cart("Beta", w.vini.id, w.manager.id);
      const out = CallDirection.OUTBOUND;
      for (const status of [CallStatus.COMPLETED, CallStatus.CONNECTED]) await w.call(a, w.vini.id, out, status);
      for (const status of [CallStatus.NO_ANSWER, CallStatus.BUSY, CallStatus.NOT_REACHABLE, CallStatus.FAILED]) await w.call(a, w.vini.id, out, status);
      for (const status of [CallStatus.INITIATED, CallStatus.RINGING_AGENT, CallStatus.RINGING_CUSTOMER]) await w.call(a, w.vini.id, out, status);
      await w.call(a, w.vini.id, CallDirection.INBOUND, CallStatus.COMPLETED);
      await w.call(b, w.vini.id, out, CallStatus.NO_ANSWER);
      const rows = (await w.mine(w.admin)).items;
      const alpha = rows.find((i) => i.lead.firstName === "Alpha")!.lead;
      const beta = rows.find((i) => i.lead.firstName === "Beta")!.lead;
      assert.equal(alpha.callAttempts, 9);
      assert.deepEqual(alpha.callBreakdown, { successful: 2, failed: 4, ringing: 3 });
      assert.equal(alpha.callBreakdown!.successful + alpha.callBreakdown!.failed + alpha.callBreakdown!.ringing, alpha.callAttempts);
      assert.deepEqual(beta.callBreakdown, { successful: 0, failed: 1, ringing: 0 });
      // the telecaller sees the same split for their own lead
      const mine = (await w.mine(w.vini)).items.find((i) => i.lead.firstName === "Alpha")!.lead;
      assert.deepEqual(mine.callBreakdown, alpha.callBreakdown);
    });
  });
});
