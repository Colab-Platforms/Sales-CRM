import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CallStatus } from "@root/generated/prisma/enums.js";
import { buildMobileLookupCandidates, normalizePhone } from "@/utils/phone.js";
import { normalizeCallerDeskPayload, parseCallerDeskTimestamp } from "./callerdesk.payload.js";
import { isTerminalCallStatus, mapCallerDeskStatus } from "./callerdesk.status.js";
import { inboundCallReport, inboundLiveCall, outboundCallReport, outboundLiveCall } from "./callerdesk.testkit.js";

function parse(payload: unknown) {
  const result = normalizeCallerDeskPayload(payload);
  if (!result.ok) assert.fail(`expected a valid payload, got: ${result.reason}`);
  return result.event;
}

describe("CallerDesk payload normalisation", () => {
  it("normalises a valid inbound Call Report", () => {
    const event = parse(inboundCallReport());

    assert.equal(event.provider, "CALLERDESK");
    assert.equal(event.eventType, "CALL_REPORT");
    assert.equal(event.externalCallId, "1672649960.960001");
    assert.equal(event.dedupeKey, "1672649960.960001");
    assert.equal(event.direction, "INBOUND");
    assert.equal(event.customerNumber, "9876543210");
    assert.equal(event.businessNumber, "01204567890");
    assert.equal(event.agentNumber, "9123456789");
    assert.equal(event.status, CallStatus.COMPLETED);
    assert.equal(event.durationSeconds, 18);
    assert.equal(event.talkDurationSeconds, 9);
    assert.equal(event.errorCode, "16");
    assert.equal(event.recordingUrl, "https://callrecords.callerdesk.io/incoming/01_2023test.mp3");
    // Naive timestamps are read as +05:30 (documented assumption).
    assert.equal(event.startedAt?.toISOString(), "2023-01-02T09:02:40.000Z");
    assert.equal(event.endedAt?.toISOString(), "2023-01-02T09:02:58.000Z");
    assert.deepEqual(event.rawPayload, inboundCallReport());
  });

  it("normalises a valid Live Call as a separate, non-final event type", () => {
    const event = parse(inboundLiveCall());

    assert.equal(event.eventType, "LIVE_CALL");
    assert.equal(event.status, CallStatus.CONNECTED); // ANSWER while live = connected, not completed
    assert.equal(event.endedAt, null);
    assert.equal(event.recordingUrl, null);
    assert.equal(event.dedupeKey, "1672649960.960001|ANSWER");
  });

  it("gives different Live events of one call different dedupe keys", () => {
    const a = parse(outboundLiveCall({ Status: "Leg A Answer" }));
    const b = parse(outboundLiveCall({ Status: "Leg B Answer" }));
    assert.notEqual(a.dedupeKey, b.dedupeKey);
    assert.equal(a.externalCallId, b.externalCallId);
  });

  it("maps outbound leg data only for OUTBOUND events", () => {
    const outbound = parse(outboundCallReport());
    assert.equal(outbound.direction, "OUTBOUND");
    assert.equal(outbound.agentPickedAt?.toISOString(), "2023-01-02T09:30:05.000Z");
    assert.equal(outbound.customerPickedAt?.toISOString(), "2023-01-02T09:30:15.000Z");
    assert.equal(outbound.campaignId, "11387004");
    // Customer/agent numbers are undocumented for outgoing calls, so they stay unknown.
    assert.equal(outbound.customerNumber, null);
    assert.equal(outbound.agentNumber, null);

    const inbound = parse(inboundCallReport({ LegB_Picked_time: "2023-01-02 14:32:50" }));
    assert.equal(inbound.customerPickedAt, null);
  });

  it("matches field names case-insensitively", () => {
    const event = parse({ callsid: "abc.1", DIRECTION: "ivr", sourcenumber: "9876543210", STATUS: "busy" });
    assert.equal(event.externalCallId, "abc.1");
    assert.equal(event.direction, "INBOUND");
    assert.equal(event.status, CallStatus.BUSY);
  });

  it("accepts numeric field values (JSON numbers) safely", () => {
    const event = parse(inboundCallReport({ CallDuration: 18, TalkDuration: 9, campid: 11387004 }));
    assert.equal(event.durationSeconds, 18);
    assert.equal(event.talkDurationSeconds, 9);
    assert.equal(event.campaignId, "11387004");
  });

  it("copes with missing optional fields", () => {
    const event = parse({ CallSid: "only-a-sid" });

    assert.equal(event.externalCallId, "only-a-sid");
    assert.equal(event.eventType, "LIVE_CALL");
    assert.equal(event.direction, null);
    assert.equal(event.status, null);
    assert.equal(event.rawStatus, null);
    assert.equal(event.customerNumber, null);
    assert.equal(event.durationSeconds, null);
    assert.equal(event.recordingUrl, null);
    assert.equal(event.startedAt, null);
    assert.equal(event.errorCode, null);
  });

  it("ignores malformed optional fields instead of failing", () => {
    const event = parse(
      inboundCallReport({ CallDuration: "abc", TalkDuration: "-4", StartTime: "not a date", EndTime: { nested: true }, coins: [1] }),
    );
    assert.equal(event.durationSeconds, null);
    assert.equal(event.talkDurationSeconds, null);
    assert.equal(event.startedAt, null);
    assert.equal(event.endedAt, null);
  });

  it("rejects a payload without CallSid", () => {
    const { CallSid: _omitted, ...withoutSid } = inboundCallReport();
    const result = normalizeCallerDeskPayload(withoutSid);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /callsid/i);
  });

  it("rejects an empty or oversized CallSid", () => {
    assert.equal(normalizeCallerDeskPayload({ CallSid: "   " }).ok, false);
    assert.equal(normalizeCallerDeskPayload({ CallSid: "x".repeat(201) }).ok, false);
  });

  it("rejects invalid payload shapes", () => {
    for (const bad of [null, undefined, "CallSid=1", 42, true, [], [{ CallSid: "1" }], {}, { CallSid: { nested: 1 } }, { CallSid: null }]) {
      assert.equal(normalizeCallerDeskPayload(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it("does not put submitted values into the rejection reason", () => {
    const result = normalizeCallerDeskPayload({ CallSid: { nested: "FAKE-LEAK-CANARY" } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.doesNotMatch(result.reason, /FAKE-LEAK-CANARY/);
  });

  it("only accepts http(s) recording URLs", () => {
    assert.equal(parse(inboundCallReport({ CallRecordingUrl: "javascript:alert(1)" })).recordingUrl, null);
    assert.equal(parse(inboundCallReport({ CallRecordingUrl: "file:///etc/passwd" })).recordingUrl, null);
    assert.equal(parse(inboundCallReport({ CallRecordingUrl: "not a url" })).recordingUrl, null);
    assert.equal(parse(inboundCallReport({ CallRecordingUrl: "" })).recordingUrl, null);
    assert.equal(parse(inboundCallReport({ CallRecordingUrl: "http://callrecords.callerdesk.io/a.mp3" })).recordingUrl, "http://callrecords.callerdesk.io/a.mp3");
    assert.equal(parse(inboundCallReport({ CallRecordingUrl: `https://x.io/${"a".repeat(2100)}` })).recordingUrl, null);
  });

  it("treats a payload with no report-only field as a Live Call, and any report-only field as a Report", () => {
    assert.equal(parse({ CallSid: "1", Status: "ANSWER" }).eventType, "LIVE_CALL");
    assert.equal(parse({ CallSid: "1", Status: "ANSWER", EndTime: "2023-01-02 14:32:58" }).eventType, "CALL_REPORT");
    assert.equal(parse({ CallSid: "1", TalkDuration: "0" }).eventType, "CALL_REPORT");
  });
});

describe("CallerDesk timestamps", () => {
  it("honours a configurable UTC offset for naive timestamps", () => {
    assert.equal(parseCallerDeskTimestamp("2023-01-02 14:32:44", "+05:30")?.toISOString(), "2023-01-02T09:02:44.000Z");
    assert.equal(parseCallerDeskTimestamp("2023-01-02 14:32:44", "+00:00")?.toISOString(), "2023-01-02T14:32:44.000Z");
  });

  it("keeps explicit zones and rejects garbage", () => {
    assert.equal(parseCallerDeskTimestamp("2023-01-02T14:32:44Z", "+05:30")?.toISOString(), "2023-01-02T14:32:44.000Z");
    assert.equal(parseCallerDeskTimestamp("yyyy-mm-dd hh:mm:ss", "+05:30"), null);
    assert.equal(parseCallerDeskTimestamp("2023-13-45 99:99:99", "+05:30"), null);
    assert.equal(parseCallerDeskTimestamp(undefined, "+05:30"), null);
  });
});

describe("CallerDesk status mapping", () => {
  const report = (raw: string) => mapCallerDeskStatus(raw, "CALL_REPORT");
  const live = (raw: string) => mapCallerDeskStatus(raw, "LIVE_CALL");

  it("maps documented incoming statuses", () => {
    assert.equal(report("ANSWER").status, CallStatus.COMPLETED);
    assert.equal(live("ANSWER").status, CallStatus.CONNECTED);
    assert.equal(report("Cancel").status, CallStatus.NO_ANSWER);
    assert.equal(report("No Answer").status, CallStatus.NO_ANSWER);
    assert.equal(report("Busy").status, CallStatus.BUSY);
    assert.equal(report("Congestion").status, CallStatus.FAILED);
    assert.equal(report("Unavailable").status, CallStatus.NOT_REACHABLE);
    assert.equal(report("Chanunavail").status, CallStatus.FAILED);
    assert.equal(report("Not Connected").status, CallStatus.NO_ANSWER);
    assert.equal(report("Agentengaged").status, CallStatus.BUSY);
    assert.equal(report("Agentonring").status, CallStatus.BUSY);
    assert.equal(report("Abandonedcall").status, CallStatus.NO_ANSWER);
    assert.equal(live("Transfer to Agent").status, CallStatus.RINGING_AGENT);
    assert.equal(live("Picked").status, CallStatus.AGENT_ANSWERED);
  });

  it("maps documented outgoing leg statuses and records the failed leg", () => {
    assert.equal(live("Leg A Answer").status, CallStatus.AGENT_ANSWERED);
    assert.equal(live("Leg B Answer").status, CallStatus.CONNECTED);
    assert.equal(report("Leg B Answer").status, CallStatus.COMPLETED);

    const agentNoAnswer = report("Leg A Cancel - Agent No Answer (0 Agent)");
    assert.deepEqual([agentNoAnswer.status, agentNoAnswer.failedLeg], [CallStatus.NO_ANSWER, "AGENT"]);
    const customerBusy = report("Leg B Cancel - Customer Busy (17 Customer)");
    assert.deepEqual([customerBusy.status, customerBusy.failedLeg], [CallStatus.BUSY, "CUSTOMER"]);
    assert.equal(report("Leg B Cancel - Customer Congestion (1 Customer)").status, CallStatus.FAILED);
    assert.equal(report("Leg A Cancel - Agent Unavailable (19 Agent)").status, CallStatus.NOT_REACHABLE);
  });

  it("ignores case, spacing, punctuation and a trailing cause code", () => {
    assert.equal(report("  answer ").status, CallStatus.COMPLETED);
    assert.equal(report("NO-ANSWER").status, CallStatus.NO_ANSWER);
    assert.equal(report("Busy (17)").status, CallStatus.BUSY);
  });

  it("reports unknown / empty statuses as unrecognised without throwing", () => {
    for (const unknown of ["SOMETHING_NEW", "42", "", "   ", "leg c cancel", "<script>"]) {
      const mapped = report(unknown);
      assert.deepEqual([mapped.status, mapped.recognised], [null, false], unknown);
    }
    assert.equal(mapCallerDeskStatus(null, "CALL_REPORT").recognised, false);
  });

  it("knows which statuses are terminal", () => {
    for (const s of [CallStatus.COMPLETED, CallStatus.NO_ANSWER, CallStatus.BUSY, CallStatus.NOT_REACHABLE, CallStatus.FAILED]) {
      assert.equal(isTerminalCallStatus(s), true, s);
    }
    for (const s of [CallStatus.INITIATED, CallStatus.RINGING_AGENT, CallStatus.AGENT_ANSWERED, CallStatus.RINGING_CUSTOMER, CallStatus.CONNECTED]) {
      assert.equal(isTerminalCallStatus(s), false, s);
    }
  });
});

describe("phone normalisation (reuses utils/phone.ts)", () => {
  it("keeps normalizePhone behaviour unchanged (last 10 digits)", () => {
    assert.equal(normalizePhone("+91 98765 43210"), "9876543210");
    assert.equal(normalizePhone("09876543210"), "9876543210");
    assert.equal(normalizePhone("9876543210"), "9876543210");
    assert.equal(normalizePhone(""), null);
    assert.equal(normalizePhone(null), null);
  });

  it("builds every plausible stored form for Indian mobiles", () => {
    const candidates = buildMobileLookupCandidates("9876543210");
    assert.deepEqual([...candidates].sort(), ["919876543210", "9876543210"].sort());

    const withPrefix = buildMobileLookupCandidates("+91 98765-43210");
    assert.ok(withPrefix.includes("919876543210"));
    assert.ok(withPrefix.includes("9876543210"));

    const withTrunkZero = buildMobileLookupCandidates("09876543210");
    assert.ok(withTrunkZero.includes("09876543210"));
    assert.ok(withTrunkZero.includes("9876543210"));
    assert.ok(withTrunkZero.includes("919876543210"));
  });

  it("does not assume every number is Indian", () => {
    const us = buildMobileLookupCandidates("+1 415 555 2671");
    assert.ok(us.includes("14155552671"));
    assert.ok(us.includes("4155552671"));
    assert.ok(!us.some((c) => c.startsWith("91")), "no +91 variant for a non-Indian-range number");
  });

  it("never returns candidates for short codes or empty input", () => {
    assert.deepEqual(buildMobileLookupCandidates("12345"), []);
    assert.deepEqual(buildMobileLookupCandidates("1800"), []);
    assert.deepEqual(buildMobileLookupCandidates(""), []);
    assert.deepEqual(buildMobileLookupCandidates(null), []);
    assert.deepEqual(buildMobileLookupCandidates(undefined), []);
  });
});
