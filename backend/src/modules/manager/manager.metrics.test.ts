import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CallStatus } from "../../../generated/prisma/enums.js";
import { classify, closingCall, leadStages, matchesCallStatus, matchesLeadStatus, ownerProgress } from "./manager.metrics.js";

const T = (iso: string) => new Date(`2026-10-15T${iso}:00.000Z`);
const call = (agentId: string, leadId: string, status: CallStatus, at: string, started = true) => ({
  agentId,
  leadId,
  status,
  startedAt: started ? T(at) : null,
  createdAt: T(at),
});
const order = (confirmedByUserId: string, leadId: string, at: string) => ({ confirmedByUserId, leadId, confirmedAt: T(at) });

describe("call outcome rules", () => {
  it("classifies connected / failed / not connected", () => {
    assert.equal(classify(CallStatus.COMPLETED), "connected");
    assert.equal(classify(CallStatus.CONNECTED), "connected");
    assert.equal(classify(CallStatus.AGENT_ANSWERED), "connected");
    assert.equal(classify(CallStatus.FAILED), "failed");
    assert.equal(classify(CallStatus.NO_ANSWER), "notConnected");
    assert.equal(classify(CallStatus.RINGING_AGENT), "notConnected");
  });

  it("an order with no closing call is only counted under All calls", () => {
    assert.equal(matchesCallStatus(null, "ALL"), true);
    assert.equal(matchesCallStatus(null, "CONNECTED"), false);
    assert.equal(matchesCallStatus(null, "FAILED"), false);
  });
});

describe("closing call: which call an order came from", () => {
  it("is the confirming telecaller's latest call to that lead before confirmation", () => {
    const calls = [
      call("rustam", "lead1", CallStatus.NO_ANSWER, "07:00"),
      call("rustam", "lead1", CallStatus.COMPLETED, "07:17"),
      call("rustam", "lead1", CallStatus.FAILED, "08:00"), // after the order: ignored
    ];
    const c = closingCall(calls, order("rustam", "lead1", "07:26"));
    assert.equal(c?.status, CallStatus.COMPLETED);
  });

  it("ignores another telecaller's calls and other leads", () => {
    const calls = [call("priti", "lead1", CallStatus.COMPLETED, "07:00"), call("rustam", "lead2", CallStatus.COMPLETED, "07:00")];
    assert.equal(closingCall(calls, order("rustam", "lead1", "07:26")), null);
  });

  it("uses createdAt for a call that never started", () => {
    const c = closingCall([call("rustam", "lead1", CallStatus.FAILED, "07:10", false)], order("rustam", "lead1", "07:26"));
    assert.equal(c?.status, CallStatus.FAILED);
  });
});

describe("report rows stay consistent under a call filter", () => {
  // Mirrors the reported bug: Rustam has 38 connected + 48 no-answer calls, no failed ones, and two orders
  // that each followed a completed call. Under "Failed calls" he used to show 0 calls but 2 orders.
  const calls = [
    call("rustam", "leadA", CallStatus.COMPLETED, "07:17"),
    call("rustam", "leadB", CallStatus.COMPLETED, "10:00"),
    call("rustam", "leadC", CallStatus.NO_ANSWER, "11:00"),
  ];
  const orders = [order("rustam", "leadA", "07:26"), order("rustam", "leadB", "10:15")];
  const ordersFor = (filter: "ALL" | "CONNECTED" | "NOT_CONNECTED" | "FAILED") =>
    orders.filter((o) => {
      const c = closingCall(calls, o);
      return matchesCallStatus(c ? classify(c.status) : null, filter);
    }).length;
  const callsFor = (filter: "ALL" | "CONNECTED" | "NOT_CONNECTED" | "FAILED") =>
    calls.filter((c) => matchesCallStatus(classify(c.status), filter)).length;

  for (const f of ["ALL", "CONNECTED", "NOT_CONNECTED", "FAILED"] as const) {
    it(`${f}: never shows orders for a call outcome the telecaller has zero calls in`, () => {
      if (callsFor(f) === 0) assert.equal(ordersFor(f), 0);
    });
  }

  it("counts: All 2, Connected 2, Not connected 0, Failed 0", () => {
    assert.deepEqual([ordersFor("ALL"), ordersFor("CONNECTED"), ordersFor("NOT_CONNECTED"), ordersFor("FAILED")], [2, 2, 0, 0]);
  });

  it("a telecaller with zero calls and zero orders stays at zero under every filter", () => {
    for (const f of ["ALL", "CONNECTED", "NOT_CONNECTED", "FAILED"] as const) {
      assert.equal(calls.filter((c) => c.agentId === "john" && matchesCallStatus(classify(c.status), f)).length, 0);
      assert.equal(orders.filter((o) => o.confirmedByUserId === "john").length, 0);
    }
  });
});

describe("lead stages count only the current owner's own work after the assignment", () => {
  const since = T("06:53"); // assigned to Aayush by the system this morning
  const base = {
    ownerId: "aayush",
    since,
    lastContactedAt: null as Date | null,
    calls: [] as { agentId: string; startedAt: Date | null; createdAt: Date }[],
    activities: [] as { actorId: string | null; type: string; title: string | null; createdAt: Date }[],
    interestedPeriods: [] as { qualifiedById: string; startedAt: Date }[],
    orders: [] as { confirmedByUserId: string | null; confirmedAt: Date | null }[],
  };

  it("a returning customer auto-assigned to an absent telecaller is NOT contacted (the reported bug)", () => {
    // Lead status is CONVERTED from Shopify orders in 2024/2025; system activity only; owner did nothing today.
    const stage = ownerProgress({
      ...base,
      activities: [
        { actorId: null, type: "ORDER_CREATED", title: "Shopify order #9554 placed", createdAt: new Date("2024-11-20T17:32:00Z") },
        { actorId: null, type: "ASSIGNMENT", title: "Assigned to salesperson Aayush Tiwari", createdAt: since },
      ],
    });
    assert.deepEqual(leadStages(stage), { contacted: false, interested: false, converted: false });
    assert.equal(matchesLeadStatus(stage, "NOT_CONTACTED"), true);
  });

  it("someone else's call or a call before the assignment does not count for the owner", () => {
    const stage = ownerProgress({
      ...base,
      calls: [
        { agentId: "priti", startedAt: T("08:00"), createdAt: T("08:00") },
        { agentId: "aayush", startedAt: T("05:00"), createdAt: T("05:00") }, // before the assignment
      ],
    });
    assert.equal(leadStages(stage).contacted, false);
  });

  it("the owner's own call after the assignment makes it contacted", () => {
    const stage = ownerProgress({ ...base, calls: [{ agentId: "aayush", startedAt: T("09:00"), createdAt: T("09:00") }] });
    assert.deepEqual(leadStages(stage), { contacted: true, interested: false, converted: false });
  });

  it("the owner marking it interested / converted counts, and the stages nest", () => {
    const interested = ownerProgress({
      ...base,
      activities: [{ actorId: "aayush", type: "STATUS_CHANGE", title: "Call outcome: Interested", createdAt: T("09:05") }],
    });
    assert.deepEqual(leadStages(interested), { contacted: true, interested: true, converted: false });
    const converted = ownerProgress({
      ...base,
      activities: [{ actorId: "aayush", type: "STATUS_CHANGE", title: "Status changed to CONVERTED", createdAt: T("09:30") }],
    });
    assert.deepEqual(leadStages(converted), { contacted: true, interested: true, converted: true });
  });

  it("'Not interested' is contact, not interest", () => {
    const stage = ownerProgress({
      ...base,
      activities: [{ actorId: "aayush", type: "STATUS_CHANGE", title: "Status changed to NOT_INTERESTED", createdAt: T("09:05") }],
    });
    assert.deepEqual(leadStages(stage), { contacted: true, interested: false, converted: false });
  });

  it("an order the owner confirmed after the assignment converts it; one confirmed by someone else does not", () => {
    assert.equal(leadStages(ownerProgress({ ...base, orders: [{ confirmedByUserId: "aayush", confirmedAt: T("10:00") }] })).converted, true);
    assert.equal(leadStages(ownerProgress({ ...base, orders: [{ confirmedByUserId: "admin", confirmedAt: T("10:00") }] })).converted, false);
  });
});
