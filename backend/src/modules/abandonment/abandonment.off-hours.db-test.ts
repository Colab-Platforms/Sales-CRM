// Off-hours auto-assign (rolled-back transactions): present people only while anyone is clocked in, every active salesperson when nobody is,
// and the morning redistribute of absent salespeople's untouched leads.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import LeadService from "../lead/lead.service.js";
import AbandonmentAutoAssignService from "./abandonment.auto-assign.service.js";

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

const mkTeam = async (tx: Prisma.TransactionClient, size: number, enabled = true) => {
  const manager = await tx.user.create({ data: { name: "Mgr", username: `m-${uid()}`, role: Role.MANAGER } });
  if (enabled) await tx.salespersonAutoAssignConfig.create({ data: { managerId: manager.id, enabled: true } });
  const team = [];
  for (let i = 0; i < size; i++) team.push(await tx.user.create({ data: { name: `T${i}`, username: `t-${uid()}`, role: Role.SALESPERSON, reportingManagerId: manager.id } }));
  return { manager, team };
};
const clockIn = (tx: Prisma.TransactionClient, userId: string) => tx.workSession.create({ data: { userId, startedAt: new Date(), lastSeenAt: new Date() } as never });
const mkLead = async (tx: Prisma.TransactionClient, over: Record<string, unknown> = {}) => {
  const l = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Cart", ...over } as never });
  await tx.abandonment.create({ data: { leadId: l.id, type: "CHECKOUT", detectedAt: new Date(), status: "ACTIVE" } });
  return l;
};
const ownerOf = async (tx: Prisma.TransactionClient, id: string) => (await tx.lead.findUniqueOrThrow({ where: { id } })).ownerId;

describe("off-hours auto-assign", () => {
  it("someone clocked in: only present salespeople receive new leads", async () => {
    await inRollback(async (tx) => {
      const { manager, team } = await mkTeam(tx, 3);
      await clockIn(tx, team[1]!.id);
      for (let i = 0; i < 3; i++) {
        const lead = await mkLead(tx, { assignedManagerId: manager.id });
        await svc.autoAssignAbandonedLead(tx, lead);
        assert.equal(await ownerOf(tx, lead.id), team[1]!.id);
      }
    });
  });

  it("nobody clocked in: leads go round-robin to every active salesperson, then wrap", async () => {
    await inRollback(async (tx) => {
      const { manager, team } = await mkTeam(tx, 3);
      const sorted = [...team].sort((a, b) => (a.id < b.id ? -1 : 1));
      const owners: (string | null)[] = [];
      for (let i = 0; i < 4; i++) {
        const lead = await mkLead(tx, { assignedManagerId: manager.id });
        await svc.autoAssignAbandonedLead(tx, lead);
        owners.push(await ownerOf(tx, lead.id));
      }
      assert.deepEqual(owners, [sorted[0]!.id, sorted[1]!.id, sorted[2]!.id, sorted[0]!.id]);
    });
  });

  it("nobody clocked in: inactive salespeople are skipped", async () => {
    await inRollback(async (tx) => {
      const { manager, team } = await mkTeam(tx, 2);
      await tx.user.update({ where: { id: team[0]!.id }, data: { status: "INACTIVE" as never } });
      const lead = await mkLead(tx, { assignedManagerId: manager.id });
      await svc.autoAssignAbandonedLead(tx, lead);
      assert.equal(await ownerOf(tx, lead.id), team[1]!.id);
    });
  });

  it("manager's auto-assign toggle off: lead stays unowned", async () => {
    await inRollback(async (tx) => {
      const { manager } = await mkTeam(tx, 2, false);
      const lead = await mkLead(tx, { assignedManagerId: manager.id });
      await svc.autoAssignAbandonedLead(tx, lead);
      assert.equal(await ownerOf(tx, lead.id), null);
    });
  });

  it("a lead that already has an owner is never reassigned", async () => {
    await inRollback(async (tx) => {
      const { manager, team } = await mkTeam(tx, 2);
      const lead = await mkLead(tx, { assignedManagerId: manager.id, ownerId: team[0]!.id });
      await svc.autoAssignAbandonedLead(tx, lead);
      assert.equal(await ownerOf(tx, lead.id), team[0]!.id);
    });
  });
});

describe("morning redistribute of absent salespeople's leads", () => {
  const run = (tx: Prisma.TransactionClient, managerId: string, confirm: boolean) => {
    const service = new AbandonmentAutoAssignService();
    (service as unknown as { db: unknown }).db = tx;
    (service as unknown as { leadService: unknown }).leadService = { bulkAssignSalespersonsByStaff: (actorId: string, body: { leadIds: string[]; salespersonId: string }) => svc.bulkAssignSalespersonsByStaff(actorId, body, tx as never) };
    return service.redistributeAbsent(managerId, confirm);
  };

  it("preview moves nothing; confirm moves only untouched (ASSIGNED) leads of absent people to present people", async () => {
    await inRollback(async (tx) => {
      const { manager, team } = await mkTeam(tx, 3);
      const [present, absentA, absentB] = team as [typeof team[0], typeof team[0], typeof team[0]];
      await clockIn(tx, present!.id);
      const untouched1 = await mkLead(tx, { assignedManagerId: manager.id, ownerId: absentA!.id, workingStatus: "ASSIGNED" });
      const untouched2 = await mkLead(tx, { assignedManagerId: manager.id, ownerId: absentB!.id, workingStatus: "ASSIGNED" });
      const worked = await mkLead(tx, { assignedManagerId: manager.id, ownerId: absentA!.id, workingStatus: "CALL_BACK" });

      const preview = await run(tx, manager.id, false);
      assert.deepEqual([preview.confirmed, preview.movable, preview.present.length, preview.absent.length], [false, 2, 1, 2]);
      assert.equal(await ownerOf(tx, untouched1.id), absentA!.id, "preview changed nothing");

      const done = await run(tx, manager.id, true);
      assert.equal(done.confirmed, true);
      assert.equal(await ownerOf(tx, untouched1.id), present!.id);
      assert.equal(await ownerOf(tx, untouched2.id), present!.id);
      assert.equal(await ownerOf(tx, worked.id), absentA!.id, "a worked lead never moves");
    });
  });

  it("nobody present: nothing moves", async () => {
    await inRollback(async (tx) => {
      const { manager, team } = await mkTeam(tx, 2);
      const lead = await mkLead(tx, { assignedManagerId: manager.id, ownerId: team[0]!.id, workingStatus: "ASSIGNED" });
      const r = await run(tx, manager.id, true);
      assert.deepEqual([r.confirmed, r.movable], [false, 0]);
      assert.equal(await ownerOf(tx, lead.id), team[0]!.id);
    });
  });
});
