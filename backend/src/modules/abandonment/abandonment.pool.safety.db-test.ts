// Production-readiness regressions for the 24/7 pool (isolated database, rolled-back transactions): deploy-before-migration safety, no lock while off, eligibility of the backfill, and the existing flow unchanged.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import LeadService from "../lead/lead.service.js";
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

const mkLead = async (tx: Prisma.TransactionClient, over: Record<string, unknown> = {}, abandonment: "ACTIVE" | "RECOVERED" | null = "ACTIVE") => {
  const l = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Cart", ...over } as never });
  if (abandonment) await tx.abandonment.create({ data: { leadId: l.id, type: "CHECKOUT", detectedAt: new Date(), status: abandonment } });
  return l;
};

describe("pool: deployed before the migration / pool off or empty", () => {
  it("code deployed BEFORE the migration (table missing): the pool step is a clean no-op, the transaction stays usable, and the existing auto-assign still runs", async () => {
    await inRollback(async (tx) => {
      const manager = await tx.user.create({ data: { name: "Mgr", username: `m-${uid()}`, role: Role.MANAGER } });
      const tele = await tx.user.create({ data: { name: "T", username: `t-${uid()}`, role: Role.SALESPERSON, reportingManagerId: manager.id } });
      await tx.$executeRaw`ALTER TABLE abandoned_pool_state RENAME TO abandoned_pool_state_gone`; // simulates "migration not applied" (DDL is rolled back with the test)
      const lead = await mkLead(tx, { assignedManagerId: manager.id });
      const r = await svc.autoAssignAbandonedFromPool(tx, lead);
      assert.deepEqual([r.assigned, r.reason], [false, "pool disabled"]);
      assert.equal((await tx.user.count({ where: { id: tele.id } })), 1, "the transaction was not aborted");
      await svc.autoAssignAbandonedLead(tx, lead); // the whole entry point (pool + existing stages) does not throw
    });
  });

  it("pool configured but disabled, or enabled with no eligible member: the lead is untouched and the entry point falls through to the existing stages", async () => {
    await inRollback(async (tx) => {
      const state = await tx.abandonedPoolState.create({ data: { enabled: false } });
      const lead = await mkLead(tx);
      assert.equal((await svc.autoAssignAbandonedFromPool(tx, lead)).reason, "pool disabled");
      await tx.abandonedPoolState.update({ where: { id: state.id }, data: { enabled: true } });
      assert.equal((await svc.autoAssignAbandonedFromPool(tx, lead)).reason, "no eligible pool member");
      assert.equal((await tx.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId, null);
    });
  });

  it("a deactivated lead is never assigned by the pool", async () => {
    await inRollback(async (tx) => {
      const tele = await tx.user.create({ data: { name: "T", username: `t-${uid()}`, role: Role.SALESPERSON } });
      await tx.abandonedPoolState.create({ data: { enabled: true, enabledAt: new Date("2020-01-01") } });
      await tx.abandonedPoolMember.create({ data: { userId: tele.id, position: 0 } });
      const lead = await mkLead(tx, { workingStatus: "DEACTIVATED" });
      assert.deepEqual([(await svc.autoAssignAbandonedFromPool(tx, lead)).reason, (await tx.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId], ["lead deactivated", null]);
    });
  });
});

describe("pool: which leads the backfill / dry run covers", () => {
  it("only unowned NEW leads with an ACTIVE abandonment; owned, CONVERTED, DND, DEACTIVATED, recovered and lead-without-abandonment ones are excluded; the result is deterministic", async () => {
    await inRollback(async (tx) => {
      const tele = await tx.user.create({ data: { name: "T", username: `t-${uid()}`, role: Role.SALESPERSON } });
      await tx.abandonedPoolState.create({ data: { enabled: true, enabledAt: new Date("2020-01-01") } });
      await tx.abandonedPoolMember.create({ data: { userId: tele.id, position: 0 } });
      const base = (await dryRun(tx as never)).unassignedLeads;
      await mkLead(tx); await mkLead(tx); // eligible x2
      await mkLead(tx, { ownerId: tele.id });
      await mkLead(tx, { workingStatus: "CONVERTED" });
      await mkLead(tx, { workingStatus: "DND" });
      await mkLead(tx, { workingStatus: "DEACTIVATED" });
      await mkLead(tx, {}, "RECOVERED");
      await mkLead(tx, {}, null);
      const a = await dryRun(tx as never);
      const b = await dryRun(tx as never);
      assert.equal(a.unassignedLeads - base, 2);
      assert.deepEqual(a, b);
      assert.equal(a.plan[0]!.leads, a.unassignedLeads);
    });
  });
});
