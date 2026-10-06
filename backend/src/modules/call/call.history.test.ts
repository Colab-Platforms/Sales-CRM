import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CallDirection, CallOutcomeCategory, CallStatus, Role } from "../../../generated/prisma/enums.js";
import { buildCallSummary, buildCallWhere, scopedCallWhere, searchWhere } from "./call.history.filters.js";
import { validateCallIdParams, validateCallSummaryQuery, validateListCallsQuery } from "./call.history.validators.js";
import { mapCallDetail, mapCallListItem } from "./call.history.service.js";
import { extractSafeProviderMetadata } from "./call.history.metadata.js";
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

  it("with a viewerId, widens the lead-scope clause to also match calls the viewer personally agented - e.g. an inbound IVR call on a still-unassigned Lead", () => {
    const salespersonScope = { ownerId: "salesperson-1" };
    const where = buildCallWhere(baseQuery, salespersonScope, "salesperson-1");
    assert.deepEqual(where, { AND: [{ OR: [{ lead: salespersonScope }, { agentId: "salesperson-1" }] }] });
  });

  it("without a viewerId, behaves exactly as before - lead scope only, no widening", () => {
    const salespersonScope = { ownerId: "salesperson-1" };
    assert.deepEqual(buildCallWhere(baseQuery, salespersonScope), { AND: [{ lead: salespersonScope }] });
    assert.deepEqual(buildCallWhere(baseQuery, salespersonScope, null), { AND: [{ lead: salespersonScope }] });
  });

  it("a viewerId never widens anything for ADMIN - lead scope is already empty, so there is nothing to OR against", () => {
    assert.deepEqual(buildCallWhere(baseQuery, {}, "admin-1"), {});
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

  it("with a viewerId, also matches a call the viewer personally agented even if its Lead is out of their scope", () => {
    assert.deepEqual(scopedCallWhere(UUID, { ownerId: "salesperson-1" }, "salesperson-1"), {
      AND: [{ id: UUID }, { OR: [{ lead: { ownerId: "salesperson-1" } }, { agentId: "salesperson-1" }] }],
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
    recording: null as { id: string; recordingUrl: string | null } | null,
    agentNumber: "9123456789" as string | null,
    customerNumber: "9876543210" as string | null,
    providerCallId: "CA123" as string | null,
    virtualNumber: null as { id: string; number: string; displayName: string | null } | null,
    provider: "callerdesk",
  };

  it("maps a call with no outcome/recording to null/false - never inventing either", () => {
    const item = mapCallListItem(baseRow);
    assert.deepEqual(
      Object.keys(item).sort(),
      ["agent", "agentNumber", "createdAt", "customerNumber", "direction", "durationSeconds", "endedAt", "hasRecording", "id", "lead", "outcome", "providerCallId", "startedAt", "status", "virtualNumber"].sort(),
    );
    assert.equal(item.outcome, null);
    assert.equal(item.hasRecording, false);
  });

  it("maps a real outcome and recording presence, never the raw recording URL", () => {
    // mapCallListItem's input type only ever selects `recording: { id: true }` (see LIST_SELECT) -
    // there is no recordingUrl to accidentally leak here even before the mapper runs.
    const item = mapCallListItem({ ...baseRow, outcome: { name: "Interested", category: CallOutcomeCategory.INTERESTED }, recording: { id: "rec-1" } });
    assert.deepEqual(item.outcome, { name: "Interested", category: CallOutcomeCategory.INTERESTED });
    assert.equal(item.hasRecording, true);
    assert.ok(!("recordingUrl" in item), "the raw recording URL must never be present on the mapped LIST item");
  });

  it("mapCallDetail extends the list shape with answeredAt/notes/callingIdentity", () => {
    const detail = mapCallDetail(
      { ...baseRow, answeredAt: new Date("2026-01-05T10:00:05.000Z"), notes: "Customer will call back", virtualNumber: { id: "vn-1", number: "01204567890", displayName: "Avatar Sales" } },
      Role.ADMIN,
      null,
    );
    assert.equal(detail.answeredAt?.toISOString(), "2026-01-05T10:00:05.000Z");
    assert.equal(detail.notes, "Customer will call back");
    assert.deepEqual(detail.callingIdentity, { number: "01204567890", displayName: "Avatar Sales" });
  });

  it("maps a null virtualNumber to a null callingIdentity, never a fabricated one", () => {
    const detail = mapCallDetail({ ...baseRow, answeredAt: null, notes: null, virtualNumber: null }, Role.ADMIN, null);
    assert.equal(detail.callingIdentity, null);
  });

  it("recordingUrl is only ever returned for ADMIN/MANAGER, never SALESPERSON, matching the legacy /api/calling redaction rule", () => {
    const row = { ...baseRow, answeredAt: null, notes: null, virtualNumber: null, recording: { id: "rec-1", recordingUrl: "https://callerdesk.example/rec.mp3" } };
    assert.equal(mapCallDetail(row, Role.ADMIN, null).recordingUrl, "https://callerdesk.example/rec.mp3");
    assert.equal(mapCallDetail(row, Role.MANAGER, null).recordingUrl, "https://callerdesk.example/rec.mp3");
    assert.equal(mapCallDetail(row, Role.SALESPERSON, null).recordingUrl, null);
  });

  it("passes providerMetadata through untouched - the service computes it, the mapper just carries it", () => {
    const metadata = { campaignId: "55203758", errorCode: null, callGroup: null, receiverName: null, agentPickedAt: null, customerLegStartedAt: null, customerPickedAt: null, callDurationSeconds: null };
    const detail = mapCallDetail({ ...baseRow, answeredAt: null, notes: null, virtualNumber: null }, Role.ADMIN, metadata);
    assert.deepEqual(detail.providerMetadata, metadata);
  });
});

describe("buildCallWhere - IVR reporting filters (agentId / virtualNumberId / hasRecording)", () => {
  it("adds agentId and virtualNumberId as plain equality clauses", () => {
    const where = buildCallWhere({ ...baseQuery, agentId: "agent-1", virtualNumberId: "vn-1" }, {});
    assert.deepEqual(where, { AND: [{ agentId: "agent-1" }, { virtualNumberId: "vn-1" }] });
  });

  it("hasRecording=true means the recording relation exists; false means it doesn't", () => {
    assert.deepEqual(buildCallWhere({ ...baseQuery, hasRecording: true }, {}), { AND: [{ recording: { isNot: null } }] });
    assert.deepEqual(buildCallWhere({ ...baseQuery, hasRecording: false }, {}), { AND: [{ recording: { is: null } }] });
  });

  it("combines with lead scope and the plain Call History filters unchanged", () => {
    const where = buildCallWhere({ ...baseQuery, direction: CallDirection.INBOUND, agentId: "agent-1" }, { ownerId: "s1" });
    assert.deepEqual(where, { AND: [{ lead: { ownerId: "s1" } }, { direction: CallDirection.INBOUND }, { agentId: "agent-1" }] });
  });
});

describe("buildCallSummary", () => {
  it("sums counts across statuses into a total, and carries the talk-time sum through", () => {
    const summary = buildCallSummary(
      [
        { status: CallStatus.COMPLETED, _count: { _all: 3 } },
        { status: CallStatus.NO_ANSWER, _count: { _all: 2 } },
      ],
      450,
    );
    assert.equal(summary.total, 5);
    assert.deepEqual(summary.byStatus, [
      { status: CallStatus.COMPLETED, count: 3 },
      { status: CallStatus.NO_ANSWER, count: 2 },
    ]);
    assert.equal(summary.totalTalkTimeSeconds, 450);
  });

  it("a null talk-time sum (no calls matched) becomes 0, not null - never NaN in the UI", () => {
    assert.equal(buildCallSummary([], null).totalTalkTimeSeconds, 0);
    assert.equal(buildCallSummary([], null).total, 0);
  });
});

describe("validateCallSummaryQuery", () => {
  it("accepts the same filters as the list query, minus page/limit", () => {
    const { error, value } = validateCallSummaryQuery({ direction: "INBOUND", agentId: "0b8f4c1e-6a52-4c53-9d0a-3f1b2c4d5e6f", hasRecording: "true" });
    assert.equal(error, null);
    assert.equal(value.direction, "INBOUND");
    assert.equal(value.hasRecording, true);
    assert.ok(!("page" in value));
    assert.ok(!("limit" in value));
  });

  it("rejects a non-uuid agentId/virtualNumberId", () => {
    assert.notEqual(validateCallSummaryQuery({ agentId: "not-a-uuid" }).error, null);
    assert.notEqual(validateCallSummaryQuery({ virtualNumberId: "not-a-uuid" }).error, null);
  });

  it("rejects a hasRecording value that isn't true/false", () => {
    assert.notEqual(validateCallSummaryQuery({ hasRecording: "maybe" }).error, null);
  });
});

describe("extractSafeProviderMetadata - IVR call-detail 'safe provider metadata'", () => {
  it("extracts only the allowlisted fields, case-insensitively, from a raw CallerDesk Call Report payload", () => {
    const payload = {
      CallSid: "CA123",
      campid: "55203758",
      Error_Code: "0",
      call_group: "Sales",
      Receiver_Name: "Agent A",
      LegA_Picked_time: "2026-01-05 10:00:02",
      LegB_Start_time: "2026-01-05 10:00:05",
      LegB_Picked_time: "2026-01-05 10:00:08",
      CallDuration: "45",
    };
    const metadata = extractSafeProviderMetadata(payload);
    assert.deepEqual(metadata, {
      campaignId: "55203758",
      errorCode: "0",
      callGroup: "Sales",
      receiverName: "Agent A",
      agentPickedAt: "2026-01-05 10:00:02",
      customerLegStartedAt: "2026-01-05 10:00:05",
      customerPickedAt: "2026-01-05 10:00:08",
      callDurationSeconds: 45,
    });
  });

  it("never returns an authcode/apikey field even if one were somehow present - explicit allowlist, not a payload dump", () => {
    const payload = { campid: "1", authcode: "SECRET-SHOULD-NEVER-APPEAR", api_key: "ALSO-SECRET" };
    const metadata = extractSafeProviderMetadata(payload);
    assert.ok(metadata);
    assert.ok(!JSON.stringify(metadata).includes("SECRET"));
  });

  it("returns null for a payload with none of the safe fields present", () => {
    assert.equal(extractSafeProviderMetadata({ CallSid: "CA123", Status: "Answer" }), null);
  });

  it("returns null for a non-object payload", () => {
    assert.equal(extractSafeProviderMetadata(null), null);
    assert.equal(extractSafeProviderMetadata("oops"), null);
    assert.equal(extractSafeProviderMetadata([1, 2]), null);
  });
});
