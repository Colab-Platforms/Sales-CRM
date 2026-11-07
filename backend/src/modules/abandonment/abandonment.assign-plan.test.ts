import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlanConflictError, buildPlan, roundRobinCounts, roundRobinPlan, summarizePlan } from "./abandonment.assign-plan.js";
import { describeSelection, sanitizeExportFilters, MAX_SELECTED_LEADS } from "./recording-export.sources.js";
import { validateBulkAssignSalesperson } from "./abandonment.validators.js";
import { exportQueueName } from "./recording-export.service.js";

const leads = (n: number) => Array.from({ length: n }, (_, i) => `lead-${i + 1}`);
const people = ["ajay", "bina", "chetan"];

describe("Round Robin dealing", () => {
  it("100 leads over 3 salespersons is 34 / 33 / 33; equal and uneven splits; people beyond the leads get 0", () => {
    assert.deepEqual(summarizePlan(roundRobinPlan(leads(100), people), people).map((r) => r.count), [34, 33, 33]);
    assert.deepEqual(roundRobinCounts(9, 3), [3, 3, 3]);
    assert.deepEqual(roundRobinCounts(10, 4), [3, 3, 2, 2]);
    assert.deepEqual(summarizePlan(roundRobinPlan(leads(2), ["a", "b", "c", "d", "e"]), ["a", "b", "c", "d", "e"]).map((r) => r.count), [1, 1, 0, 0, 0]);
  });

  it("deals sequentially from the first salesperson, each lead exactly once, and matches roundRobinCounts for every size", () => {
    assert.deepEqual(roundRobinPlan(leads(5), people).map((p) => `${p.leadId}>${p.salespersonId}`), ["lead-1>ajay", "lead-2>bina", "lead-3>chetan", "lead-4>ajay", "lead-5>bina"]);
    for (let n = 0; n <= 80; n++) for (let k = 1; k <= 7; k++) {
      const ids = Array.from({ length: k }, (_, i) => `p${i}`);
      assert.deepEqual(summarizePlan(roundRobinPlan(leads(n), ids), ids).map((r) => r.count), roundRobinCounts(n, k));
    }
    assert.deepEqual(roundRobinPlan(leads(3), []), []);
  });
});

describe("building a plan from a request", () => {
  const leadIdOf = new Map(leads(6).map((l, i) => [`ab-${i + 1}`, l]));
  const ab = (...n: number[]) => n.map((i) => `ab-${i}`);

  it("round robin: one assignment per distinct lead (two checkouts of one lead count once), in selection order", () => {
    const sameLead = new Map([["ab-1", "L1"], ["ab-2", "L1"], ["ab-3", "L3"]]);
    const plan = buildPlan({ method: "ROUND_ROBIN", abandonmentIds: ab(1, 2, 3), leadIdOf: sameLead, salespersonIds: ["x", "y"] });
    assert.deepEqual(plan, [{ leadId: "L1", salespersonId: "x" }, { leadId: "L3", salespersonId: "y" }]);
  });

  it("manual: each lead goes to its own salesperson (several people), and leads with no choice are left out", () => {
    const plan = buildPlan({ method: "MANUAL", abandonmentIds: ab(1, 2, 3, 4), leadIdOf, assignments: [{ abandonmentId: "ab-1", salespersonId: "x" }, { abandonmentId: "ab-2", salespersonId: "y" }, { abandonmentId: "ab-3", salespersonId: "x" }] });
    assert.deepEqual(plan, [{ leadId: "lead-1", salespersonId: "x" }, { leadId: "lead-2", salespersonId: "y" }, { leadId: "lead-3", salespersonId: "x" }]);
  });

  it("manual: the legacy single salesperson means every selected lead", () => {
    assert.equal(buildPlan({ method: "MANUAL", abandonmentIds: ab(1, 2, 3), leadIdOf, salespersonId: "x" }).length, 3);
  });

  it("refuses a lead given to two different salespersons and a choice for a lead that was not selected", () => {
    assert.throws(() => buildPlan({ method: "MANUAL", abandonmentIds: ab(1), leadIdOf, assignments: [{ abandonmentId: "ab-1", salespersonId: "x" }, { abandonmentId: "ab-1", salespersonId: "y" }] }), PlanConflictError);
    assert.throws(() => buildPlan({ method: "MANUAL", abandonmentIds: ab(1), leadIdOf, assignments: [{ abandonmentId: "ab-2", salespersonId: "x" }] }), PlanConflictError);
  });
});

describe("assignment request validation", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  it("needs at least one salesperson in either mode, and at least one lead", () => {
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "ROUND_ROBIN", salespersonIds: [] }).error);
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "MANUAL", assignments: [] }).error);
    assert.ok(validateBulkAssignSalesperson({ abandonmentIds: [], method: "ROUND_ROBIN", salespersonIds: [id] }).error);
    assert.ifError(validateBulkAssignSalesperson({ abandonmentIds: [id], method: "ROUND_ROBIN", salespersonIds: [id, other] }).error);
    assert.ifError(validateBulkAssignSalesperson({ abandonmentIds: [id, other], method: "MANUAL", assignments: [{ abandonmentId: id, salespersonId: id }, { abandonmentId: other, salespersonId: other }] }).error);
  });
});

describe("export queue name", () => {
  it("defaults to recording-export; an own name keeps a machine's jobs to itself; junk falls back to the default", () => {
    assert.equal(exportQueueName({}), "recording-export");
    assert.equal(exportQueueName({ RECORDING_EXPORT_QUEUE: " recording-export-dev " }), "recording-export-dev");
    assert.equal(exportQueueName({ RECORDING_EXPORT_QUEUE: "bad name!" }), "recording-export");
  });
});

describe("lead export selection", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  it("keeps exactly the selected ids, de-duplicated and sorted, and describes them", () => {
    const f = sanitizeExportFilters({ ids: [uuid(3), uuid(1), uuid(3)], workingStatus: "INTERESTED", junk: "dropped" })!;
    assert.deepEqual(f.ids, [uuid(1), uuid(3)]);
    assert.equal(f.junk, undefined);
    assert.deepEqual(describeSelection(f), { selection: "IDS", selectedCount: 2, filtered: false });
    assert.deepEqual(describeSelection({ matching: true, assignee: "Ajay" }), { selection: "MATCHING", selectedCount: null, filtered: true });
    assert.deepEqual(describeSelection(null), { selection: null, selectedCount: null, filtered: false });
    assert.deepEqual(describeSelection({ salespersonId: "x", workingStatus: "NEW" }), { selection: null, selectedCount: null, filtered: true });
  });

  it("refuses an empty, malformed or oversized selection, and an invalid filter value", () => {
    assert.throws(() => sanitizeExportFilters({ ids: [] }), { statusCode: 400 });
    assert.throws(() => sanitizeExportFilters({ ids: ["nope"] }), { statusCode: 400 });
    assert.throws(() => sanitizeExportFilters({ ids: "not-an-array" }), { statusCode: 400 });
    assert.throws(() => sanitizeExportFilters({ ids: Array.from({ length: MAX_SELECTED_LEADS + 1 }, (_, i) => uuid(i)) }), { statusCode: 400 });
    assert.throws(() => sanitizeExportFilters({ workingStatus: "NOT_A_STATUS" }), { statusCode: 400 });
    assert.equal(sanitizeExportFilters({}), null);
    assert.equal(sanitizeExportFilters(undefined), null);
  });

  it("select-all-matching carries the list filters instead of ids", () => {
    const f = sanitizeExportFilters({ matching: true, assignee: "Ajay", dateRange: "all" })!;
    assert.equal(f.matching, true);
    assert.equal(f.ids, undefined);
    assert.equal(f.assignee, "Ajay");
  });
});
