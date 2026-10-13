// Concurrent assignment of the same leads. Unlike the rolled-back suites this commits real rows (two simultaneous transactions cannot see each other's uncommitted work), so it runs
// ONLY against the isolated test database and removes everything it created. The two "requests" use separate pooled connections, i.e. genuinely overlapping transactions.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import LeadService from "../lead/lead.service.js";

if (!/127\.0\.0\.1:5544\/crm_iso/.test(process.env.DATABASE_URL ?? "")) throw new Error("GUARD: the concurrency test commits rows and runs only against the isolated test database");

const tag = randomUUID().slice(0, 8);
let adminId = "", t1Id = "", t2Id = "";
const leadIds: string[] = [];
const svc = new LeadService();

before(async () => {
  const mk = (n: string, role: Role) => prisma.user.create({ data: { name: `Conc ${n}`, username: `cc${n}-${tag}`, role }, select: { id: true } });
  adminId = (await mk("adm", Role.ADMIN)).id;
  t1Id = (await mk("t1", Role.SALESPERSON)).id;
  t2Id = (await mk("t2", Role.SALESPERSON)).id;
  for (let i = 0; i < 8; i++) leadIds.push((await prisma.lead.create({ data: { leadNumber: `L-CC-${tag}-${i}`, firstName: `Conc${i}`, mobile: `6${tag.replace(/\D/g, "1").padEnd(5, "1").slice(0, 5)}${String(i).padStart(4, "0")}`, normalizedMobile: `+916${tag.replace(/\D/g, "1").padEnd(5, "1").slice(0, 5)}${String(i).padStart(4, "0")}` }, select: { id: true } })).id);
});

after(async () => {
  try {
    await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.leadAssignment.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, t1Id, t2Id] } } });
  } finally {
    await prisma.$disconnect();
  }
});

const reset = async () => {
  await prisma.leadAssignment.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.activity.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.updateMany({ where: { id: { in: leadIds } }, data: { ownerId: null, groupId: null, workingStatus: "NEW" } });
};

/** After any interleaving: every lead has EXACTLY one current assignment, and its owner is that assignment's user. */
async function assertCoherent(ids: string[]) {
  for (const id of ids) {
    const current = await prisma.leadAssignment.findMany({ where: { leadId: id, isCurrent: true } });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { ownerId: true } });
    assert.equal(current.length, 1, `lead ${id.slice(0, 8)} has exactly one current assignment`);
    assert.equal(lead.ownerId, current[0]!.userId, "the owner matches the current assignment");
    const open = await prisma.leadAssignment.count({ where: { leadId: id, isCurrent: false, unassignedAt: null } });
    assert.equal(open, 0, "every superseded assignment is closed");
  }
}

describe("concurrent staff assignment", () => {
  it("two admins assign the SAME leads to DIFFERENT telecallers at once, in opposite order: no deadlock, a coherent final state, a winner for every lead", async () => {
    for (let round = 0; round < 6; round++) {
      await reset();
      const ids = leadIds.slice(0, 5);
      const [a, b] = await Promise.all([
        svc.bulkAssignSalespersonsByStaff(adminId, { leadIds: ids, salespersonId: t1Id }),
        svc.bulkAssignSalespersonsByStaff(adminId, { leadIds: [...ids].reverse(), salespersonId: t2Id }),
      ]);
      assert.equal(a.assignedCount + a.unchangedCount, 5);
      assert.equal(b.assignedCount + b.unchangedCount, 5);
      await assertCoherent(ids);
      const owners = new Set((await prisma.lead.findMany({ where: { id: { in: ids } }, select: { ownerId: true } })).map((l) => l.ownerId));
      assert.ok(owners.size >= 1 && [...owners].every((o) => o === t1Id || o === t2Id));
      // the second transaction saw the first one's committed result: it reassigned, so every lead has two rows (one closed, one current)
      assert.equal(await prisma.leadAssignment.count({ where: { leadId: { in: ids } } }), 10, `round ${round}: one assignment + one reassignment per lead, no duplicates`);
    }
  });

  it("two requests assigning the same leads to the SAME telecaller at once: exactly one performs the assignment, the other reports 'unchanged' - one history row per lead", async () => {
    for (let round = 0; round < 6; round++) {
      await reset();
      const ids = leadIds.slice(2, 7);
      const results = await Promise.all([1, 2, 3].map(() => svc.bulkAssignSalespersonsByStaff(adminId, { leadIds: ids, salespersonId: t1Id })));
      assert.equal(results.reduce((s, r) => s + r.assignedCount, 0), 5, "five leads were assigned in total - by exactly one of the requests");
      assert.equal(results.reduce((s, r) => s + r.unchangedCount, 0), 10);
      assert.equal(await prisma.leadAssignment.count({ where: { leadId: { in: ids } } }), 5, "one history row per lead");
      await assertCoherent(ids);
    }
  });

  it("a batch with an unknown lead fails as a whole while another request is running: nothing from the failed batch is applied and the other request is unaffected", async () => {
    await reset();
    const good = leadIds.slice(0, 3);
    const [bad, ok] = await Promise.allSettled([
      svc.bulkAssignSalespersonsByStaff(adminId, { leadIds: [...good, randomUUID()], salespersonId: t2Id }),
      svc.bulkAssignSalespersonsByStaff(adminId, { leadIds: good, salespersonId: t1Id }),
    ]);
    assert.equal(bad.status, "rejected");
    assert.equal(ok.status, "fulfilled");
    assert.equal(await prisma.lead.count({ where: { id: { in: good }, ownerId: t1Id } }), 3, "only the successful request's assignment exists");
    assert.equal(await prisma.leadAssignment.count({ where: { leadId: { in: good }, userId: t2Id } }), 0);
    await assertCoherent(good);
  });
});
