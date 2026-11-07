// Bulk salesperson assignment (Manual with several salespersons, Round Robin) and the lead Excel exports (selected leads, filtered leads, select-all-matching), against a REAL isolated
// Postgres. Run ONLY through the isolated launcher: it refuses to run unless the database is crm_iso. Data is committed (the service uses real transactions) and removed by each test.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { Role } from "../../../generated/prisma/enums.js";
import LeadService from "../lead/lead.service.js";
import AbandonmentService from "./abandonment.service.js";
import { AbandonmentRecordingsService } from "./abandonment.recordings.js";
import { PostgresBlobStore, RecordingExportService, defaultWorkerDeps, processExportJob } from "./recording-export.service.js";
import { seedRecordingWorld, type SeededWorld } from "./recording-export.seed.js";
import { validateBulkAssignSalesperson, validateListAbandonmentsQuery } from "./abandonment.validators.js";

before(async () => {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("select current_database()::text as db");
  if (db !== "crm_iso") throw new Error(`GUARD: these tests only run against crm_iso (got ${db})`);
});
after(() => prisma.$disconnect());

const abandonments = new AbandonmentService(prisma as never, new LeadService(), null);
const recordings = new AbandonmentRecordingsService(prisma);
const store = new PostgresBlobStore(prisma);
const queued: string[] = [];
const exportsService = new RecordingExportService(prisma, recordings, async (id) => void queued.push(id), store);
const as = (u: { id: string; username: string; role: string }) => ({ id: u.id, username: u.username, role: u.role as Role });

async function makeTeam(w: SeededWorld, names: string[], reportsTo: string | null = w.manager.id) {
  const out: { id: string; name: string }[] = [];
  for (const [i, name] of names.entries()) {
    const u = await prisma.user.create({ data: { name, username: `exp-extra-${w.tag}-${i}`, role: Role.SALESPERSON, reportingManagerId: reportsTo } });
    out.push({ id: u.id, name });
  }
  return out;
}
const abandonmentIds = async (w: SeededWorld, take?: number) =>
  (await prisma.abandonment.findMany({ where: { lead: { leadNumber: { startsWith: `EXP-${w.tag}-` } } }, select: { id: true, lead: { select: { leadNumber: true } } }, orderBy: [{ detectedAt: "desc" }, { id: "asc" }], take })).map((a) => a.id);
const ownerCounts = async (w: SeededWorld) => {
  const rows = await prisma.lead.groupBy({ by: ["ownerId"], where: { leadNumber: { startsWith: `EXP-${w.tag}-` } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.ownerId, r._count._all]));
};

describe("Bulk assign salesperson - Round Robin", () => {
  for (const [leads, people, expected] of [
    [100, 3, [34, 33, 33]],
    [9, 3, [3, 3, 3]],
    [10, 4, [3, 3, 2, 2]],
    [2, 5, [1, 1, 0, 0, 0]],
  ] as const) {
    it(`${leads} leads over ${people} salespersons -> ${expected.join(" / ")}, persisted with history`, { timeout: 120_000 }, async () => {
      const w = await seedRecordingWorld(prisma, { leads: leads + 20, callsPerLead: 1, days: 3 });
      try {
        const team = await makeTeam(w, Array.from({ length: people }, (_, i) => `Person ${i + 1}`));
        const ids = await abandonmentIds(w, leads); // the first `leads` of the 20-lead-larger world are selected; the other 20 must stay untouched
        const result = await abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids, method: "ROUND_ROBIN", salespersonIds: team.map((t) => t.id) });
        assert.equal(result.assignedCount, leads);
        assert.deepEqual(result.perSalesperson!.map((r) => r.assignedCount), expected.filter((n) => n > 0), "employee-wise counts returned to the page (people who got nothing are not listed)");
        const counts = await ownerCounts(w);
        assert.deepEqual(team.map((t) => counts.get(t.id) ?? 0), [...expected], "and persisted");
        assert.equal(counts.get(null), 20, "leads that were not selected are untouched");
        const history = await prisma.leadAssignment.findMany({ where: { lead: { leadNumber: { startsWith: `EXP-${w.tag}-` } }, isCurrent: true } });
        assert.equal(history.length, leads, "one current assignment-history row per assigned lead");
        assert.ok(history.every((h) => h.assignmentType === "ROUND_ROBIN" && h.assignedById === w.manager.id));
        // sequential dealing: the i-th selected lead goes to the i-th salesperson (round robin), starting with the first
        const owners = await prisma.lead.findMany({ where: { abandonments: { some: { id: { in: ids } } } }, select: { ownerId: true, abandonments: { select: { id: true } } } });
        const ownerOfAbandonment = new Map(owners.map((o) => [o.abandonments[0]!.id, o.ownerId]));
        assert.deepEqual(ids.slice(0, people).map((id) => ownerOfAbandonment.get(id)), team.map((t) => t.id).slice(0, Math.min(people, leads)));
      } finally {
        await w.cleanup();
      }
    });
  }

  it("re-running the same assignment changes nothing (no duplicate history); a different Round Robin reassigns properly", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 12, callsPerLead: 1, days: 3 });
    try {
      const team = await makeTeam(w, ["A", "B", "C"]);
      const ids = await abandonmentIds(w);
      const body = { abandonmentIds: ids, method: "ROUND_ROBIN" as const, salespersonIds: team.map((t) => t.id) };
      await abandonments.bulkAssignSalesperson(as(w.manager), body);
      const again = await abandonments.bulkAssignSalesperson(as(w.manager), body);
      assert.equal(again.assignedCount, 0);
      assert.equal(again.unchangedCount, 12);
      const rows = await prisma.leadAssignment.count({ where: { lead: { leadNumber: { startsWith: `EXP-${w.tag}-` } } } });
      assert.equal(rows, 12, "no duplicate history rows");
      const second = await abandonments.bulkAssignSalesperson(as(w.manager), { ...body, salespersonIds: [team[2]!.id, team[0]!.id] });
      assert.equal(second.assignedCount + (second.unchangedCount ?? 0), 12);
      assert.equal(await prisma.leadAssignment.count({ where: { lead: { leadNumber: { startsWith: `EXP-${w.tag}-` } }, isCurrent: true } }), 12, "exactly one current assignment per lead after reassigning");
    } finally {
      await w.cleanup();
    }
  });

  it("admin can use Round Robin across several telecallers too", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 10, callsPerLead: 1, days: 3 });
    try {
      const team = await makeTeam(w, ["A", "B"], null);
      const result = await abandonments.bulkAssignSalesperson(as(w.admin), { abandonmentIds: await abandonmentIds(w), method: "ROUND_ROBIN", salespersonIds: team.map((t) => t.id) });
      assert.deepEqual(result.perSalesperson!.map((r) => r.assignedCount), [5, 5]);
    } finally {
      await w.cleanup();
    }
  });
});

describe("Bulk assign salesperson - Manual with several salespersons", () => {
  it("each lead goes to the salesperson chosen for it; leads with no choice are left alone", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 12, callsPerLead: 1, days: 3 });
    try {
      const [a, b, c] = await makeTeam(w, ["A", "B", "C"]);
      const ids = await abandonmentIds(w);
      const choice = [a, a, b, c, b, c, a, b, c, a]; // 10 of the 12; the last two get no choice
      const assignments = choice.map((p, i) => ({ abandonmentId: ids[i]!, salespersonId: p!.id }));
      const result = await abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids, method: "MANUAL", assignments });
      assert.equal(result.assignedCount, 10);
      assert.equal(result.selectedCount, 12);
      const byAbandonment = new Map((await prisma.abandonment.findMany({ where: { id: { in: ids } }, select: { id: true, lead: { select: { ownerId: true } } } })).map((r) => [r.id, r.lead.ownerId]));
      for (const [i, p] of choice.entries()) assert.equal(byAbandonment.get(ids[i]!), p!.id, `lead ${i}`);
      assert.equal(byAbandonment.get(ids[10]!), null);
      assert.equal(byAbandonment.get(ids[11]!), null);
      assert.deepEqual(result.perSalesperson!.map((r) => [r.name, r.assignedCount]).sort(), [["A", 4], ["B", 3], ["C", 3]]);
      const history = await prisma.leadAssignment.findMany({ where: { lead: { leadNumber: { startsWith: `EXP-${w.tag}-` } }, isCurrent: true } });
      assert.equal(history.length, 10);
      assert.ok(history.every((h) => h.assignmentType === "MANUAL"));
    } finally {
      await w.cleanup();
    }
  });

  it("the legacy single-salesperson request still assigns every selected lead to that one", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 5, callsPerLead: 1, days: 3 });
    try {
      const [a] = await makeTeam(w, ["A"]);
      const result = await abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: await abandonmentIds(w), method: "MANUAL", salespersonId: a!.id });
      assert.equal(result.assignedCount, 5);
    } finally {
      await w.cleanup();
    }
  });
});

describe("Bulk assign salesperson - safeguards", () => {
  it("all or nothing: one invalid salesperson in the request means NO lead is assigned", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 8, callsPerLead: 1, days: 3 });
    try {
      const [a] = await makeTeam(w, ["A"]);
      const [stranger] = await makeTeam({ ...w, tag: w.tag + "x" } as SeededWorld, ["Not on this team"], w.admin.id); // reports to someone else
      const ids = await abandonmentIds(w);
      const assignments = ids.map((id, i) => ({ abandonmentId: id, salespersonId: i === 7 ? stranger!.id : a!.id }));
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids, method: "MANUAL", assignments }), { statusCode: 400 });
      assert.equal((await ownerCounts(w)).get(null), 8, "nothing was saved");
      assert.equal(await prisma.leadAssignment.count({ where: { lead: { leadNumber: { startsWith: `EXP-${w.tag}-` } } } }), 0);
      await prisma.user.deleteMany({ where: { id: stranger!.id } });
    } finally {
      await w.cleanup();
    }
  });

  it("a manager cannot assign leads that belong to another manager (rejected as a whole, nothing saved)", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 6, callsPerLead: 1, days: 3 });
    try {
      const [a] = await makeTeam(w, ["A"]);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET assigned_manager_id = ${w.admin.id}::uuid WHERE lead_number = ${`EXP-${w.tag}-1`}`);
      const ids = await abandonmentIds(w);
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids, method: "ROUND_ROBIN", salespersonIds: [a!.id] }), { statusCode: 404 });
      assert.equal((await ownerCounts(w)).get(null), 6);
    } finally {
      await w.cleanup();
    }
  });

  it("empty selection, no salesperson chosen, and roles that may not assign are all refused", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 4, callsPerLead: 1, days: 3 });
    try {
      const [a, b] = await makeTeam(w, ["A", "B"]);
      const ids = await abandonmentIds(w);
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: [], method: "ROUND_ROBIN", salespersonIds: [a!.id] }), { statusCode: 400 });
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids, method: "ROUND_ROBIN", salespersonIds: [] }), { statusCode: 400 });
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids, method: "MANUAL", assignments: [] }), { statusCode: 400 });
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.telecaller), { abandonmentIds: ids, method: "ROUND_ROBIN", salespersonIds: [a!.id] }), { statusCode: 403 });
      await assert.rejects(() => abandonments.bulkAssignSalesperson({ id: w.admin.id, username: "x", role: Role.RECRUITER }, { abandonmentIds: ids, method: "ROUND_ROBIN", salespersonIds: [a!.id] }), { statusCode: 403 });
      // a manual choice for a lead outside the selection, and one lead given to two people, are conflicts
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids.slice(0, 2), method: "MANUAL", assignments: [{ abandonmentId: ids[3]!, salespersonId: a!.id }] }), { statusCode: 400 });
      await assert.rejects(() => abandonments.bulkAssignSalesperson(as(w.manager), { abandonmentIds: ids.slice(0, 2), method: "MANUAL", assignments: [{ abandonmentId: ids[0]!, salespersonId: a!.id }, { abandonmentId: ids[0]!, salespersonId: b!.id }] }), { statusCode: 400 });
      assert.equal((await ownerCounts(w)).get(null), 4, "nothing was saved by any refused request");
    } finally {
      await w.cleanup();
    }
  });

  it("the request schema refuses a missing salesperson choice for either mode", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "ROUND_ROBIN", salespersonIds: [] }).error);
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "ROUND_ROBIN" }).error);
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "MANUAL" }).error);
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "MANUAL", assignments: [] }).error);
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [], method: "ROUND_ROBIN", salespersonIds: [id] }).error);
    assert.ifError(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "ROUND_ROBIN", salespersonIds: [id] }).error);
    assert.ifError(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "MANUAL", assignments: [{ abandonmentId: id, salespersonId: id }] }).error);
  });
});

describe("Lead Excel export - selected, filtered and select-all-matching", () => {
  async function runExcel(user: { id: string; role: string; username: string }, filters: Record<string, unknown> | undefined, range: { from: string; to: string }) {
    const created = await exportsService.create(as(user), { kind: "EXCEL", from: range.from, to: range.to, filters });
    const outcome = await processExportJob({ ...defaultWorkerDeps(async () => ({ data: Buffer.alloc(1), contentType: null })), enqueue: async () => undefined }, created.id);
    const status = await exportsService.get(as(user), created.id);
    const parts: Buffer[] = [];
    for await (const c of store.stream(created.id, status.sizeBytes)) parts.push(c);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.concat(parts) as never);
    const sheet = wb.getWorksheet("Abandoned leads")!;
    const leadIds: string[] = [];
    sheet.eachRow((row, n) => {
      if (n > 1) leadIds.push(String(row.getCell(1).value));
    });
    return { created, outcome, status, leadIds, sheet };
  }
  const leadNumbersOf = async (ids: string[]) => (await prisma.abandonment.findMany({ where: { id: { in: ids } }, select: { lead: { select: { leadNumber: true } } } })).map((a) => a.lead.leadNumber).sort();
  const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  it("exports exactly the ticked leads and nothing else, with the assigned salesperson and manager", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 30, callsPerLead: 2, days: 5 });
    try {
      const [ajay] = await makeTeam(w, ["Ajay"]);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET owner_id = ${ajay!.id}::uuid WHERE lead_number LIKE ${`EXP-${w.tag}-%`}`);
      const picked = (await abandonmentIds(w)).slice(3, 10); // 7 leads, not the first ones
      const run = await runExcel(w.manager, { ids: picked }, { from: today(), to: today() });
      assert.equal(run.outcome, "completed");
      assert.equal(run.status.selection, "IDS");
      assert.equal(run.status.selectedCount, 7);
      assert.equal(run.status.total, 7);
      assert.deepEqual([...run.leadIds].sort(), await leadNumbersOf(picked));
      const header = (run.sheet.getRow(1).values as string[]).slice(1);
      assert.ok(header.includes("Assigned salesperson") && header.includes("Assigned manager") && header.includes("Call attempts") && header.includes("Order value"));
      const row = run.sheet.getRow(2);
      assert.equal(row.getCell(12).value, "Ajay");
      assert.equal(row.getCell(13).value, w.manager.username ? `Export MANAGER ${w.tag}` : "");
    } finally {
      await w.cleanup();
    }
  });

  it("Ajay's leads: filter by Ajay, select them, and the Excel contains only those selected Ajay leads", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 40, callsPerLead: 1, days: 5 });
    try {
      const [ajay, bina] = await makeTeam(w, ["Ajay Kumar", "Bina Shah"]);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET owner_id = CASE WHEN substring(lead_number from '-([0-9]+)$')::int <= 15 THEN ${ajay!.id}::uuid ELSE ${bina!.id}::uuid END WHERE lead_number LIKE ${`EXP-${w.tag}-%`}`);
      // what the list shows with the Ajay filter, then "select all" (every id the filter matches)
      const query = validateListAbandonmentsQuery({ page: "1", pageSize: "20", dateRange: "all", assignee: "Ajay" });
      assert.ifError(query.error);
      const matching = await abandonments.listMatchingIds(as(w.manager), query.value!);
      assert.equal(matching.ids.length, 15);
      assert.equal(matching.labels.length, 15);
      const all = await runExcel(w.manager, { ids: matching.ids }, { from: today(), to: today() });
      assert.equal(all.leadIds.length, 15);
      const owners = await prisma.lead.findMany({ where: { leadNumber: { in: all.leadIds } }, select: { ownerId: true } });
      assert.ok(owners.every((o) => o.ownerId === ajay!.id), "only Ajay's leads");
      // a manual subset of Ajay's selection: only those
      const some = await runExcel(w.manager, { ids: matching.ids.slice(0, 4) }, { from: today(), to: today() });
      assert.equal(some.leadIds.length, 4);
      assert.deepEqual([...some.leadIds].sort(), await leadNumbersOf(matching.ids.slice(0, 4)));
    } finally {
      await w.cleanup();
    }
  });

  it("select-all-matching exports every match across pagination (2,600 leads, 1,300 of them Ajay's) - not just the visible page", { timeout: 200_000 }, async () => {
    const w = await seedRecordingWorld(prisma, { leads: 2600, callsPerLead: 1, days: 5 });
    try {
      const [ajay, bina] = await makeTeam(w, ["Ajay", "Bina"]);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET owner_id = CASE WHEN substring(lead_number from '-([0-9]+)$')::int <= 1300 THEN ${ajay!.id}::uuid ELSE ${bina!.id}::uuid END WHERE lead_number LIKE ${`EXP-${w.tag}-%`}`);
      const run = await runExcel(w.manager, { matching: true, assignee: "Ajay", dateRange: "all" }, { from: today(), to: today() });
      assert.equal(run.outcome, "completed");
      assert.equal(run.status.selection, "MATCHING");
      assert.equal(run.status.total, 1300);
      assert.equal(run.leadIds.length, 1300, "more than one database page (1,000 rows) and far more than one list page (20)");
      assert.equal(new Set(run.leadIds).size, 1300);
      const owners = await prisma.lead.groupBy({ by: ["ownerId"], where: { leadNumber: { in: run.leadIds.slice(0, 500) } }, _count: { _all: true } });
      assert.deepEqual(owners.map((o) => o.ownerId), [ajay!.id]);
    } finally {
      await w.cleanup();
    }
  });

  it("Excel for one salesperson and/or one lead status contains only those leads, and is marked as filtered", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 30, callsPerLead: 1, days: 5 });
    try {
      const [ajay, bina] = await makeTeam(w, ["Ajay", "Bina"]);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET owner_id = CASE WHEN substring(lead_number from '-([0-9]+)$')::int <= 10 THEN ${ajay!.id}::uuid ELSE ${bina!.id}::uuid END WHERE lead_number LIKE ${`EXP-${w.tag}-%`}`);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET working_status = 'RINGING' WHERE substring(lead_number from '-([0-9]+)$')::int <= 4 AND lead_number LIKE ${`EXP-${w.tag}-%`}`);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET working_status = 'INTERESTED' WHERE substring(lead_number from '-([0-9]+)$')::int BETWEEN 11 AND 13 AND lead_number LIKE ${`EXP-${w.tag}-%`}`);
      const range = { from: new Date(Date.now() + 330 * 60_000 - 4 * 86_400_000).toISOString().slice(0, 10), to: today() };
      const ownerOf = async (ids: string[]) => (await prisma.lead.findMany({ where: { leadNumber: { in: ids } }, select: { ownerId: true, workingStatus: true } }));
      const both = await runExcel(w.manager, { salespersonId: ajay!.id, workingStatus: "RINGING" }, range);
      assert.equal(both.leadIds.length, 4, "Ajay AND Ringing");
      assert.equal(both.status.filtered, true);
      assert.ok((await ownerOf(both.leadIds)).every((l) => l.ownerId === ajay!.id && l.workingStatus === "RINGING"));
      const person = await runExcel(w.manager, { salespersonId: bina!.id }, range);
      assert.equal(person.leadIds.length, 20, "every one of Bina's leads, whatever the status");
      const status = await runExcel(w.manager, { workingStatus: "INTERESTED" }, range);
      assert.equal(status.leadIds.length, 3, "Interested, whoever owns them");
      const everything = await runExcel(w.manager, undefined, range);
      assert.equal(everything.leadIds.length, 30);
      assert.equal(everything.status.filtered, false);
      await assert.rejects(() => exportsService.create(as(w.manager), { kind: "EXCEL", ...range, filters: { salespersonId: "not-a-uuid" } }), { statusCode: 400 });
      await assert.rejects(() => exportsService.create(as(w.manager), { kind: "EXCEL", ...range, filters: { workingStatus: "FLYING" } }), { statusCode: 400 });
    } finally {
      await w.cleanup();
    }
  });

  it("selection safeguards: a manager's export never includes leads outside their scope; bad, empty or oversized selections are refused; a telecaller cannot export", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 10, callsPerLead: 1, days: 5 });
    try {
      const ids = await abandonmentIds(w);
      await prisma.$executeRaw(Prisma.sql`UPDATE leads SET assigned_manager_id = ${w.admin.id}::uuid WHERE lead_number IN (${`EXP-${w.tag}-1`}, ${`EXP-${w.tag}-2`})`);
      const run = await runExcel(w.manager, { ids }, { from: today(), to: today() });
      assert.equal(run.leadIds.length, 8, "the two leads that belong to another manager are not exported");
      const range = { from: today(), to: today() };
      await assert.rejects(() => exportsService.create(as(w.manager), { kind: "EXCEL", ...range, filters: { ids: ["not-a-uuid"] } }), { statusCode: 400 });
      await assert.rejects(() => exportsService.create(as(w.manager), { kind: "EXCEL", ...range, filters: { ids: [] } }), { statusCode: 400 });
      await assert.rejects(() => exportsService.create(as(w.manager), { kind: "EXCEL", ...range, filters: { ids: Array.from({ length: 2001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) } }), { statusCode: 400 });
      await assert.rejects(() => exportsService.create(as(w.manager), { kind: "EXCEL", ...range, filters: { ids: ["00000000-0000-4000-8000-000000000001"] } }), { statusCode: 404 }, "none of the selected leads exist");
      await assert.rejects(() => exportsService.create(as(w.telecaller), { kind: "EXCEL", ...range, filters: { ids } }), { statusCode: 403 });
    } finally {
      await w.cleanup();
    }
  });

  it("lead Excel exports and recording ZIP exports are independent: neither blocks, queues behind, or limits the other", async () => {
    const w = await seedRecordingWorld(prisma, { leads: 50, callsPerLead: 2, days: 5 });
    try {
      const day = today();
      const range = { from: w.from, to: w.to };
      // two ZIP exports occupy the per-user ZIP limit...
      const zip1 = await exportsService.create(as(w.admin), { kind: "ZIP", ...range });
      await exportsService.create(as(w.admin), { kind: "ZIP", from: w.to, to: w.to });
      const zipLimited = await exportsService.create(as(w.admin), { kind: "ZIP", from: w.from, to: w.from }).then(() => false, (e: { statusCode?: number }) => e.statusCode === 429);
      assert.equal(zipLimited, true, "a third ZIP is refused ...");
      // ... yet a lead Excel (date range) and a selected-leads Excel are still accepted and run alongside them
      const ids = (await abandonmentIds(w)).slice(0, 5);
      const excelRange = await exportsService.create(as(w.admin), { kind: "EXCEL", ...range });
      const excelPicked = await exportsService.create(as(w.admin), { kind: "EXCEL", from: day, to: day, filters: { ids } });
      assert.notEqual(excelRange.id, excelPicked.id);
      const deps = { ...defaultWorkerDeps(async () => ({ data: Buffer.alloc(512, 1), contentType: "audio/mpeg" })), enqueue: async () => undefined };
      const results = await Promise.all([zip1.id, excelRange.id, excelPicked.id].map((id) => processExportJob(deps, id)));
      assert.deepEqual(results, ["completed", "completed", "completed"]);
      const history = await exportsService.list(as(w.admin));
      assert.deepEqual(history.filter((h) => h.id === zip1.id || h.id === excelRange.id || h.id === excelPicked.id).map((h) => h.kind).sort(), ["EXCEL", "EXCEL", "ZIP"]);
      assert.equal(history.find((h) => h.id === excelPicked.id)!.selectedCount, 5);
      assert.equal(history.find((h) => h.id === excelRange.id)!.selection, null);
    } finally {
      await w.cleanup();
    }
  });
});
