import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CallDirection, CallOutcomeCategory, CallStatus } from "../../../generated/prisma/enums.js";
import { buildCallWhere, scopedCallWhere, searchWhere } from "./call.history.filters.js";
import { validateCallIdParams, validateListCallsQuery } from "./call.history.validators.js";
import { mapCallDetail, mapCallListItem } from "./call.history.service.js";
import type { ListCallsQuery } from "./call.history.types.js";

const UUID = "0b8f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f";
const baseQuery: ListCallsQuery = { page: 1, limit: 20 };

describe("searchWhere (calls)", () => {
  it("matches through the lead relation, never a field Call itself owns", () => {
    assert.deepEqual(searchWhere("Rahul"), {
      AND: [{ lead: { OR: [{ firstName: { contains: "Rahul", mode: "insensitive" } }, { lastName: { contains: "Rahul", mode: "insensitive" } }, { leadNumber: { contains: "Rahul", mode: "insensitive" } }, { mobile: { contains: "Rahul", mode: "insensitive" } }] } }],
    });
  });

  it("ANDs every whitespace-separated term and caps at 5", () => {
    const where = searchWhere("a b c d e f g");
    assert.equal((where.AND as unknown[]).length, 5);
  });

  it("drops empty tokens from repeated whitespace", () => {
    const where = searchWhere("  Rahul   Sharma  ");
    assert.equal((where.AND as unknown[]).length, 2);
  });
});

describe("buildCallWhere", () => {
  it("is empty for no filters and no lead scope (ADMIN)", () => {
    assert.deepEqual(buildCallWhere(baseQuery, {}), {});
  });

  it("applies the caller's lead scope as its own AND-ed clause - this is the actual access-control boundary", () => {
    const salespersonScope = { ownerId: "salesperson-1" };
    const where = buildCallWhere(baseQuery, salespersonScope);
    assert.deepEqual(where, { AND: [{ lead: { ownerId: "salesperson-1" } }] });
  });

  it("a manager's team scope narrows calls the same way it narrows orders/leads", () => {
    const managerScope = { OR: [{ groupId: { in: ["g1"] } }, { ownerId: { in: ["s1", "s2"] } }] };
    const where = buildCallWhere(baseQuery, managerScope);
    assert.deepEqual(where, { AND: [{ lead: managerScope }] });
  });

  it("combines status, direction, date range and search with the lead scope, never replacing it", () => {
    const where = buildCallWhere(
      { ...baseQuery, status: CallStatus.COMPLETED, direction: CallDirection.OUTBOUND, dateFrom: new Date("2026-01-01T00:00:00.000Z"), dateTo: new Date("2026-01-31T23:59:59.999Z"), search: "Sharma" },
      { ownerId: "salesperson-1" },
    );
    assert.deepEqual(where, {
      AND: [
        { lead: { ownerId: "salesperson-1" } },
        { AND: [{ lead: { OR: [{ firstName: { contains: "Sharma", mode: "insensitive" } }, { lastName: { contains: "Sharma", mode: "insensitive" } }, { leadNumber: { contains: "Sharma", mode: "insensitive" } }, { mobile: { contains: "Sharma", mode: "insensitive" } }] } }] },
        { status: CallStatus.COMPLETED },
        { direction: CallDirection.OUTBOUND },
        { createdAt: { gte: new Date("2026-01-01T00:00:00.000Z"), lte: new Date("2026-01-31T23:59:59.999Z") } },
      ],
    });
  });

  it("filters by createdAt, not startedAt - a call that never started (startedAt: null) must still be findable by date", () => {
    const where = buildCallWhere({ ...baseQuery, dateFrom: new Date("2026-01-01T00:00:00.000Z") }, {});
    const clause = (where.AND as { createdAt?: unknown }[])[0];
    assert.ok(clause?.createdAt, "the date filter must target createdAt");
  });
});

describe("scopedCallWhere", () => {
  it("is just the id when the caller has no scope restriction (ADMIN)", () => {
    assert.deepEqual(scopedCallWhere(UUID, {}), { id: UUID });
  });

  it("ANDs the id with the lead scope for a restricted caller - an out-of-scope id looks identical to a missing one", () => {
    assert.deepEqual(scopedCallWhere(UUID, { ownerId: "salesperson-1" }), {
      AND: [{ id: UUID }, { lead: { ownerId: "salesperson-1" } }],
    });
  });
});

describe("validateListCallsQuery", () => {
  it("defaults page to 1 and limit to 20", () => {
    const { error, value } = validateListCallsQuery({});
    assert.equal(error, null);
    assert.deepEqual(value, { page: 1, limit: 20 });
  });

  it("coerces numeric query strings and rejects an out-of-range limit", () => {
    assert.deepEqual(validateListCallsQuery({ page: "2", limit: "50" }).value, { page: 2, limit: 50 });
    assert.notEqual(validateListCallsQuery({ limit: "0" }).error, null);
    assert.notEqual(validateListCallsQuery({ limit: "101" }).error, null);
  });

  it("treats an empty-string filter as unset, matching orders.validators.ts's convention", () => {
    const { value } = validateListCallsQuery({ status: "", direction: "", search: "" });
    assert.equal(value.status, undefined);
    assert.equal(value.direction, undefined);
    assert.equal(value.search, undefined);
  });

  it("rejects a status/direction value the schema does not define", () => {
    assert.notEqual(validateListCallsQuery({ status: "ON_HOLD" }).error, null);
    assert.notEqual(validateListCallsQuery({ direction: "SIDEWAYS" }).error, null);
  });

  it("accepts every real CallStatus and CallDirection value", () => {
    for (const status of Object.values(CallStatus)) {
      assert.equal(validateListCallsQuery({ status }).error, null, status);
    }
    for (const direction of Object.values(CallDirection)) {
      assert.equal(validateListCallsQuery({ direction }).error, null, direction);
    }
  });

  it("parses dateFrom as start-of-day and dateTo as end-of-day UTC, so the end date is inclusive", () => {
    const { error, value } = validateListCallsQuery({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    assert.equal(error, null);
    assert.equal(value.dateFrom?.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(value.dateTo?.toISOString(), "2026-01-31T23:59:59.999Z");
  });

  it("rejects a malformed date", () => {
    assert.notEqual(validateListCallsQuery({ dateFrom: "01/01/2026" }).error, null);
    assert.notEqual(validateListCallsQuery({ dateFrom: "not-a-date" }).error, null);
  });
});

describe("validateCallIdParams", () => {
  it("accepts a real uuid and rejects anything else", () => {
    assert.equal(validateCallIdParams({ id: UUID }).error, null);
    assert.notEqual(validateCallIdParams({ id: "not-a-uuid" }).error, null);
    assert.notEqual(validateCallIdParams({}).error, null);
  });
});

describe("mapCallListItem / mapCallDetail - the exact frontend contract shape", () => {
  const baseRow = {
    id: UUID,
    direction: CallDirection.OUTBOUND,
    status: CallStatus.COMPLETED,
    startedAt: new Date("2026-01-05T10:00:00.000Z"),
    endedAt: new Date("2026-01-05T10:05:00.000Z"),
    durationSeconds: 180,
    createdAt: new Date("2026-01-05T09:59:00.000Z"),
    agent: { id: "agent-1", name: "E3 UAT Salesperson" },
    lead: { id: "lead-1", leadNumber: "LEAD-001", firstName: "Rahul", lastName: "Sharma", mobile: "9876543210" },
    outcome: null as { name: string; category: CallOutcomeCategory } | null,
    recording: null as { id: string } | null,
  };

  it("maps a call with no outcome/recording to null/false - never inventing either", () => {
    const item = mapCallListItem(baseRow);
    assert.deepEqual(Object.keys(item).sort(), ["agent", "createdAt", "direction", "durationSeconds", "endedAt", "hasRecording", "id", "lead", "outcome", "startedAt", "status"]);
    assert.equal(item.outcome, null);
    assert.equal(item.hasRecording, false);
  });

  it("maps a real outcome and recording presence, never the raw recording URL", () => {
    const item = mapCallListItem({ ...baseRow, outcome: { name: "Interested", category: CallOutcomeCategory.INTERESTED }, recording: { id: "rec-1" } });
    assert.deepEqual(item.outcome, { name: "Interested", category: CallOutcomeCategory.INTERESTED });
    assert.equal(item.hasRecording, true);
    assert.ok(!("recordingUrl" in item), "the raw recording URL must never be present on the mapped item");
  });

  it("mapCallDetail extends the list shape with answeredAt/notes/callingIdentity", () => {
    const detail = mapCallDetail({ ...baseRow, answeredAt: new Date("2026-01-05T10:00:05.000Z"), notes: "Customer will call back", virtualNumber: { number: "01204567890", displayName: "Avatar Sales" } });
    assert.equal(detail.answeredAt?.toISOString(), "2026-01-05T10:00:05.000Z");
    assert.equal(detail.notes, "Customer will call back");
    assert.deepEqual(detail.callingIdentity, { number: "01204567890", displayName: "Avatar Sales" });
  });

  it("maps a null virtualNumber to a null callingIdentity, never a fabricated one", () => {
    const detail = mapCallDetail({ ...baseRow, answeredAt: null, notes: null, virtualNumber: null });
    assert.equal(detail.callingIdentity, null);
  });
});
