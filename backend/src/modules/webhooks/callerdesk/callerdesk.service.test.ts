import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { CallDirection, CallStatus, WebhookStatus } from "@root/generated/prisma/enums.js";
import { createCallerDeskWebhookService, type CallerDeskWebhookResult } from "./callerdesk.service.js";
import {
  createInMemoryCallEventStore,
  inboundCallReport,
  inboundLiveCall,
  outboundCallReport,
  outboundLiveCall,
} from "./callerdesk.testkit.js";

const NOW = new Date("2023-01-02T10:00:00.000Z");
const SID = "1672649960.960001";
const OUTBOUND_SID = "1672650000.960002";

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);
});

afterEach(() => {
  mock.restoreAll();
});

function setup() {
  const kit = createInMemoryCallEventStore();
  const service = createCallerDeskWebhookService(kit.store, { now: () => NOW });
  return { kit, service };
}

function processed(result: CallerDeskWebhookResult) {
  assert.equal(result.outcome, "PROCESSED", `expected PROCESSED, got ${JSON.stringify(result)}`);
  return result as Extract<CallerDeskWebhookResult, { outcome: "PROCESSED" }>;
}

/** A lead saved WITH a country code (as utils/normalize.ts would store "+91 98765 43210"), an owner, and a different answering agent. */
function seedInboundWorld(kit: ReturnType<typeof createInMemoryCallEventStore>) {
  const ownerId = kit.addUser({ phone: "9000000001" });
  const agentId = kit.addUser({ phone: "+91 91234 56789" });
  const leadId = kit.addLead({ normalizedMobile: "919876543210", ownerId });
  const virtualNumberId = kit.addVirtualNumber("01204567890");
  return { ownerId, agentId, leadId, virtualNumberId };
}

describe("CallerDesk webhook service - Call Report", () => {
  it("valid Call Report: correlates by phone, creates the Call, recording and one activity", async () => {
    const { kit, service } = setup();
    const world = seedInboundWorld(kit);

    const result = processed(await service.processWebhook(inboundCallReport()));

    assert.equal(result.correlation, "PHONE_NUMBER");
    assert.equal(result.callCreated, true);
    assert.equal(result.recording, "created");
    assert.equal(result.activityCreated, true);

    assert.equal(kit.state.calls.length, 1);
    const call = kit.state.calls[0]!;
    assert.equal(call.provider, "callerdesk");
    assert.equal(call.providerCallId, SID);
    assert.equal(call.direction, CallDirection.INBOUND);
    assert.equal(call.status, CallStatus.COMPLETED);
    assert.equal(call.leadId, world.leadId);
    assert.equal(call.agentId, world.agentId, "the answering agent (DialWhomNumber) wins over the lead owner");
    assert.equal(call.durationSeconds, 9, "duration_seconds stores talk time");
    assert.equal(call.endedAt?.toISOString(), "2023-01-02T09:02:58.000Z");

    assert.equal(kit.state.recordings.length, 1);
    assert.deepEqual(kit.state.recordings[0], {
      callId: call.id,
      recordingUrl: "https://callrecords.callerdesk.io/incoming/01_2023test.mp3",
      storageProvider: "callerdesk",
      durationSeconds: 9,
      status: "PROVIDER_HOSTED",
    });

    assert.equal(kit.state.activities.length, 1);
    assert.equal(kit.state.activities[0]!.title, "Inbound call - Completed");
    assert.equal(kit.state.activities[0]!.leadId, world.leadId);

    const lead = kit.state.leads[0]!;
    assert.equal(lead.lastActivityAt?.toISOString(), "2023-01-02T09:02:58.000Z");
    assert.equal(lead.lastContactedAt?.toISOString(), "2023-01-02T09:02:58.000Z");

    assert.equal(kit.state.webhookEvents.length, 1);
    const event = kit.state.webhookEvents[0]!;
    assert.equal(event.provider, "callerdesk");
    assert.equal(event.eventType, "call_report");
    assert.equal(event.externalEventId, SID);
    assert.equal(event.status, WebhookStatus.PROCESSED);
    assert.deepEqual(event.payload, inboundCallReport(), "raw payload preserved");
    assert.deepEqual(kit.lockKeys, [`callerdesk:${SID}`], "processing is serialised per CallSid");
  });

  it("links the business number to a known VirtualNumber and tolerates an unknown one", async () => {
    const { kit, service } = setup();
    const world = seedInboundWorld(kit);
    processed(await service.processWebhook(inboundCallReport()));

    assert.equal(kit.createdCallInputs.length, 1);
    const created = kit.createdCallInputs[0]!;
    assert.equal(created.virtualNumberId, world.virtualNumberId);
    assert.equal(created.customerNumber, "9876543210");
    assert.equal(created.agentNumber, "9123456789");

    const { kit: kit2, service: service2 } = setup();
    kit2.addLead({ normalizedMobile: "9876543210", ownerId: kit2.addUser({ phone: "9000000001" }) });
    processed(await service2.processWebhook(inboundCallReport({ CallSid: "other" })));
    assert.equal(kit2.state.calls.length, 1);
    assert.equal(kit2.createdCallInputs[0]!.virtualNumberId, null, "unknown virtual number -> null, call still recorded");
  });

  it("duplicate delivery: returns success and creates nothing twice", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);

    const first = processed(await service.processWebhook(inboundCallReport()));
    const second = await service.processWebhook(inboundCallReport());
    const third = await service.processWebhook(inboundCallReport());

    assert.equal(second.outcome, "DUPLICATE");
    assert.equal(third.outcome, "DUPLICATE");
    assert.equal(second.outcome === "DUPLICATE" && second.webhookEventId, first.webhookEventId);

    assert.equal(kit.state.calls.length, 1, "no duplicate Call");
    assert.equal(kit.state.recordings.length, 1, "no duplicate recording");
    assert.equal(kit.state.activities.length, 1, "no duplicate timeline activity");
    assert.equal(kit.state.webhookEvents.length, 1, "no duplicate webhook event");
  });

  it("a delivery interrupted before PROCESSED is re-attempted idempotently", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    processed(await service.processWebhook(inboundCallReport()));

    // Simulate a crash after the writes but before the event was marked processed.
    kit.state.webhookEvents[0]!.status = WebhookStatus.RECEIVED;
    const retry = processed(await service.processWebhook(inboundCallReport()));

    assert.equal(retry.callCreated, false);
    assert.equal(retry.correlation, "PROVIDER_CALL_ID");
    assert.equal(retry.recording, "unchanged");
    assert.equal(retry.activityCreated, false);
    assert.equal(kit.state.calls.length, 1);
    assert.equal(kit.state.recordings.length, 1);
    assert.equal(kit.state.activities.length, 1);
    assert.equal(kit.state.webhookEvents.length, 1);
    assert.equal(kit.state.webhookEvents[0]!.status, WebhookStatus.PROCESSED);
  });

  it("missing CallSid is rejected and nothing is persisted", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    const { CallSid: _omitted, ...withoutSid } = inboundCallReport();

    const result = await service.processWebhook(withoutSid);

    assert.equal(result.outcome, "INVALID");
    assert.equal(kit.state.webhookEvents.length, 0);
    assert.equal(kit.state.calls.length, 0);
  });

  it("invalid payload shapes are rejected without touching the store", async () => {
    const { kit, service } = setup();
    for (const bad of [null, "text", 5, [], {}]) {
      assert.equal((await service.processWebhook(bad)).outcome, "INVALID");
    }
    assert.equal(kit.state.webhookEvents.length, 0);
    assert.equal(kit.lockKeys.length, 0);
  });

  it("unknown status: never crashes, is logged, and maps to FAILED for a new call", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);

    const result = processed(await service.processWebhook(inboundCallReport({ Status: "MYSTERY_STATE" })));

    assert.equal(result.callCreated, true);
    assert.equal(kit.state.calls[0]!.status, CallStatus.FAILED);
    assert.ok(logs.some((l) => l.includes("unrecognised status") && l.includes("MYSTERY_STATE")), "unknown status is logged");
    assert.equal(kit.state.webhookEvents[0]!.payload.Status, "MYSTERY_STATE", "raw status kept in the payload");
  });

  it("unknown status never overwrites a known terminal status", async () => {
    const { kit, service } = setup();
    const world = seedInboundWorld(kit);
    kit.addCall({ leadId: world.leadId, agentId: world.agentId, status: CallStatus.COMPLETED, providerCallId: SID, direction: "INBOUND" });

    processed(await service.processWebhook(inboundCallReport({ Status: "MYSTERY_STATE" })));

    assert.equal(kit.state.calls.length, 1);
    assert.equal(kit.state.calls[0]!.status, CallStatus.COMPLETED);
  });

  it("copes with missing optional fields (no agent number, duration, recording, timestamps)", async () => {
    const { kit, service } = setup();
    const world = seedInboundWorld(kit);

    const result = processed(
      await service.processWebhook({ CallSid: "minimal-1", Direction: "IVR", SourceNumber: "9876543210", EndTime: "2023-01-02 14:40:00", Status: "NOANSWER" }),
    );

    assert.equal(result.callCreated, true);
    const call = kit.state.calls[0]!;
    assert.equal(call.status, CallStatus.NO_ANSWER);
    assert.equal(call.agentId, world.ownerId, "no answering agent -> the lead's owner");
    assert.equal(call.durationSeconds, null);
    assert.equal(call.startedAt, null);
    assert.equal(kit.state.recordings.length, 0);
    assert.equal(kit.state.leads[0]!.lastContactedAt, null, "an unanswered call is not 'contact'");
  });

  it("ignores an unsafe recording URL instead of storing it", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);

    const result = processed(await service.processWebhook(inboundCallReport({ CallRecordingUrl: "javascript:alert(1)" })));

    assert.equal(result.recording, "none");
    assert.equal(kit.state.recordings.length, 0);
  });

  it("does not create a recording for a report without one", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    const { CallRecordingUrl: _omitted, ...noRecording } = inboundCallReport();

    processed(await service.processWebhook(noRecording));

    assert.equal(kit.state.recordings.length, 0);
  });
});

describe("CallerDesk webhook service - correlation", () => {
  it("unmatched lead: stored safely as RECEIVED, no Call, no Activity", async () => {
    const { kit, service } = setup();

    const result = await service.processWebhook(inboundCallReport());

    assert.equal(result.outcome, "UNMATCHED");
    assert.equal(result.outcome === "UNMATCHED" && result.reason, "NO_LEAD_MATCH");
    assert.equal(kit.state.calls.length, 0);
    assert.equal(kit.state.activities.length, 0);
    assert.equal(kit.state.webhookEvents.length, 1);
    assert.equal(kit.state.webhookEvents[0]!.status, WebhookStatus.RECEIVED);
    assert.deepEqual(kit.state.webhookEvents[0]!.payload, inboundCallReport());
  });

  it("an unmatched event is reconciled by a later retry once the lead exists", async () => {
    const { kit, service } = setup();
    await service.processWebhook(inboundCallReport());
    assert.equal(kit.state.calls.length, 0);

    seedInboundWorld(kit);
    const retry = processed(await service.processWebhook(inboundCallReport()));

    assert.equal(retry.callCreated, true);
    assert.equal(kit.state.calls.length, 1);
    assert.equal(kit.state.webhookEvents.length, 1, "the stored event is reused, not duplicated");
    assert.equal(kit.state.webhookEvents[0]!.status, WebhookStatus.PROCESSED);
  });

  it("successful correlation matches leads stored with or without a country code", async () => {
    for (const stored of ["9876543210", "919876543210"]) {
      const { kit, service } = setup();
      kit.addLead({ normalizedMobile: stored, ownerId: kit.addUser({ phone: "9000000001" }) });
      processed(await service.processWebhook(inboundCallReport({ SourceNumber: "+91 98765 43210" })));
      assert.equal(kit.state.calls.length, 1, `lead stored as ${stored}`);
    }
  });

  it("ambiguous lead match is never guessed", async () => {
    const { kit, service } = setup();
    const ownerId = kit.addUser({ phone: "9000000001" });
    kit.addLead({ normalizedMobile: "9876543210", ownerId });
    kit.addLead({ normalizedMobile: "919876543210", ownerId });

    const result = await service.processWebhook(inboundCallReport());

    assert.equal(result.outcome === "UNMATCHED" && result.reason, "AMBIGUOUS_LEAD_MATCH");
    assert.equal(kit.state.calls.length, 0);
  });

  it("no resolvable agent leaves the event unmatched (calls.agent_id is required)", async () => {
    const { kit, service } = setup();
    kit.addLead({ normalizedMobile: "9876543210", ownerId: null });

    const result = await service.processWebhook(inboundCallReport({ DialWhomNumber: "9555555555" }));

    assert.equal(result.outcome === "UNMATCHED" && result.reason, "NO_AGENT_RESOLVED");
    assert.equal(kit.state.calls.length, 0);
  });

  it("does not guess the agent when two users share the answering number", async () => {
    const { kit, service } = setup();
    kit.addUser({ phone: "9123456789" });
    kit.addUser({ phone: "+91 91234 56789" });
    const ownerId = kit.addUser({ phone: "9000000001" });
    kit.addLead({ normalizedMobile: "9876543210", ownerId });

    processed(await service.processWebhook(inboundCallReport()));

    assert.equal(kit.state.calls[0]!.agentId, ownerId);
  });

  it("caller number missing or too short is unmatched", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    const { SourceNumber: _omitted, ...noCaller } = inboundCallReport();

    assert.equal((await service.processWebhook(noCaller)).outcome === "UNMATCHED" && "NO_CUSTOMER_NUMBER", "NO_CUSTOMER_NUMBER");
    const short = await service.processWebhook(inboundCallReport({ CallSid: "short", SourceNumber: "12345" }));
    assert.equal(short.outcome === "UNMATCHED" && short.reason, "NO_LEAD_MATCH");
    assert.equal(kit.state.calls.length, 0);
  });

  it("outbound events with no id match are never attached to a lead by phone number", async () => {
    const { kit, service } = setup();
    // A lead exists whose number appears in the payload - it must still NOT be attached.
    kit.addLead({ normalizedMobile: "9876543210", ownerId: kit.addUser({ phone: "9000000001" }) });

    const result = await service.processWebhook(outboundCallReport({ campid: "no-such-campaign" }));

    assert.equal(result.outcome === "UNMATCHED" && result.reason, "NO_CALL_MATCH_OUTBOUND");
    assert.equal(kit.state.calls.length, 0);
    assert.equal(kit.state.webhookEvents[0]!.status, WebhookStatus.RECEIVED);
  });

  it("an event with no known direction is unmatched unless a call id matches", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    const result = await service.processWebhook(inboundCallReport({ Direction: "SOMETHING_ELSE" }));
    assert.equal(result.outcome === "UNMATCHED" && result.reason, "UNKNOWN_DIRECTION");
    assert.equal(kit.state.calls.length, 0);
  });
});

describe("CallerDesk webhook service - existing Call updates and Live Call", () => {
  it("updates an existing Call found by provider call id, without creating another", async () => {
    const { kit, service } = setup();
    const ownerId = kit.addUser({ phone: "9000000001" });
    const leadId = kit.addLead({ normalizedMobile: "9876543210", ownerId });
    const existing = kit.addCall({ leadId, agentId: ownerId, status: CallStatus.INITIATED, providerCallId: OUTBOUND_SID });

    const result = processed(await service.processWebhook(outboundLiveCall({ Status: "Leg A Answer" })));

    assert.equal(result.correlation, "PROVIDER_CALL_ID");
    assert.equal(result.callCreated, false);
    assert.equal(result.callId, existing.id);
    assert.equal(kit.state.calls.length, 1);
    assert.equal(kit.state.calls[0]!.status, CallStatus.AGENT_ANSWERED);
    assert.equal(kit.state.calls[0]!.startedAt?.toISOString(), "2023-01-02T09:30:00.000Z");
    assert.equal(kit.state.activities.length, 0, "a non-terminal live event creates no timeline entry");
  });

  it("outbound lifecycle via campid: Live A -> Live B -> Report, one Call, one recording, one activity", async () => {
    const { kit, service } = setup();
    const ownerId = kit.addUser({ phone: "9000000001" });
    const leadId = kit.addLead({ normalizedMobile: "9876543210", ownerId });
    const existing = kit.addCall({ leadId, agentId: ownerId, status: CallStatus.INITIATED, providerCallId: "11387004" });

    const liveA = processed(await service.processWebhook(outboundLiveCall({ Status: "Leg A Answer" })));
    assert.equal(liveA.correlation, "CAMPAIGN_ID");
    assert.equal(kit.state.calls[0]!.providerCallId, OUTBOUND_SID, "row upgraded from campid to the real CallSid");
    assert.equal(kit.state.calls[0]!.status, CallStatus.AGENT_ANSWERED);

    const liveB = processed(await service.processWebhook(outboundLiveCall({ Status: "Leg B Answer" })));
    assert.equal(liveB.correlation, "PROVIDER_CALL_ID");
    assert.equal(kit.state.calls[0]!.status, CallStatus.CONNECTED);

    const report = processed(await service.processWebhook(outboundCallReport()));
    assert.equal(report.callId, existing.id);
    assert.equal(report.recording, "created");
    assert.equal(report.activityCreated, true);
    const call = kit.state.calls[0]!;
    assert.equal(call.status, CallStatus.COMPLETED);
    assert.equal(call.durationSeconds, 25);
    assert.equal(call.answeredAt?.toISOString(), "2023-01-02T09:30:15.000Z", "answered = customer (Leg B) picked");
    assert.equal(call.endedAt?.toISOString(), "2023-01-02T09:30:40.000Z");

    // Late/out-of-order Live event must not regress a completed call.
    processed(await service.processWebhook(outboundLiveCall({ Status: "Picked" })));
    assert.equal(kit.state.calls[0]!.status, CallStatus.COMPLETED);

    assert.equal(kit.state.calls.length, 1, "webhooks never create a duplicate Call");
    assert.equal(kit.state.recordings.length, 1);
    assert.equal(kit.state.activities.length, 1);
    assert.equal(kit.state.webhookEvents.length, 4);
  });

  it("Call Report is authoritative over a provisional terminal status", async () => {
    const { kit, service } = setup();
    const ownerId = kit.addUser({ phone: "9000000001" });
    const leadId = kit.addLead({ normalizedMobile: "9876543210", ownerId });
    kit.addCall({ leadId, agentId: ownerId, status: CallStatus.FAILED, providerCallId: OUTBOUND_SID });

    processed(await service.processWebhook(outboundCallReport()));

    assert.equal(kit.state.calls[0]!.status, CallStatus.COMPLETED);
    assert.equal(kit.state.calls.length, 1);
  });

  it("inbound Live Call creates the call (not completed, no activity); the Report then updates that same call", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);

    const live = processed(await service.processWebhook(inboundLiveCall()));
    assert.equal(live.callCreated, true);
    assert.equal(live.activityCreated, false);
    assert.equal(kit.state.calls[0]!.status, CallStatus.CONNECTED);
    assert.equal(kit.state.calls[0]!.endedAt, null);
    assert.equal(kit.state.activities.length, 0);

    const report = processed(await service.processWebhook(inboundCallReport()));
    assert.equal(report.callCreated, false);
    assert.equal(report.correlation, "PROVIDER_CALL_ID");
    assert.equal(kit.state.calls.length, 1, "Live + Report never produce two Calls");
    assert.equal(kit.state.calls[0]!.status, CallStatus.COMPLETED);
    assert.equal(kit.state.activities.length, 1);
    assert.equal(kit.state.webhookEvents.length, 2);
  });

  it("uncorrelated Live Call is persisted and left for reconciliation", async () => {
    const { kit, service } = setup();
    const result = await service.processWebhook(inboundLiveCall());
    assert.equal(result.outcome, "UNMATCHED");
    assert.equal(kit.state.webhookEvents.length, 1);
    assert.equal(kit.state.webhookEvents[0]!.eventType, "live_call");
    assert.equal(kit.state.webhookEvents[0]!.status, WebhookStatus.RECEIVED);
  });

  it("Live duplicates are keyed by CallSid + Status", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);

    processed(await service.processWebhook(inboundLiveCall({ Status: "Picked" })));
    assert.equal((await service.processWebhook(inboundLiveCall({ Status: "Picked" }))).outcome, "DUPLICATE");
    processed(await service.processWebhook(inboundLiveCall({ Status: "ANSWER" })));

    assert.equal(kit.state.calls.length, 1);
    assert.equal(kit.state.webhookEvents.length, 2);
    assert.equal(kit.state.calls[0]!.status, CallStatus.CONNECTED, "moves forward only");
  });

  it("Live event with an unrecognised status is stored as IGNORED and de-duplicated", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);

    const first = await service.processWebhook(inboundLiveCall({ Status: "WHO_KNOWS" }));
    assert.equal(first.outcome, "IGNORED");
    assert.equal(kit.state.calls.length, 0);
    assert.equal(kit.state.webhookEvents[0]!.status, WebhookStatus.IGNORED);
    assert.equal((await service.processWebhook(inboundLiveCall({ Status: "WHO_KNOWS" }))).outcome, "DUPLICATE");
    assert.equal(kit.state.webhookEvents.length, 1);
  });
});

describe("CallerDesk webhook service - failure handling", () => {
  it("a mid-processing failure rolls back, persists the raw event as FAILED, and leaks nothing", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    kit.failNext("createCallActivity");

    const result = await service.processWebhook(inboundCallReport());

    assert.equal(result.outcome, "FAILED");
    assert.equal(kit.state.calls.length, 0, "transaction rolled back - no half-written Call");
    assert.equal(kit.state.recordings.length, 0);
    assert.equal(kit.state.activities.length, 0);

    assert.equal(kit.state.webhookEvents.length, 1);
    const event = kit.state.webhookEvents[0]!;
    assert.equal(event.status, WebhookStatus.FAILED);
    assert.deepEqual(event.payload, inboundCallReport(), "raw payload survives the failure");
    assert.ok(!(event.errorMessage ?? "").includes("FAKE-LEAK-CANARY"), "no DB error text stored");
    assert.ok(!logs.join("\n").includes("FAKE-LEAK-CANARY"), "no DB error text logged");
  });

  it("a FAILED event is retried successfully and reuses its stored row", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    kit.failNext("createCall");
    assert.equal((await service.processWebhook(inboundCallReport())).outcome, "FAILED");

    const retry = processed(await service.processWebhook(inboundCallReport()));

    assert.equal(retry.callCreated, true);
    assert.equal(kit.state.calls.length, 1);
    assert.equal(kit.state.webhookEvents.length, 1);
    assert.equal(kit.state.webhookEvents[0]!.status, WebhookStatus.PROCESSED);
    assert.equal(kit.state.webhookEvents[0]!.errorMessage, null);
  });
});

describe("CallerDesk webhook service - logging safety", () => {
  it("logs provider, event type, call id, result and correlation - but no phone numbers, URLs or credentials", async () => {
    const { kit, service } = setup();
    seedInboundWorld(kit);
    await service.processWebhook(inboundCallReport());
    await service.processWebhook(inboundCallReport());

    const all = logs.join("\n");
    assert.match(all, /provider=callerdesk/);
    assert.match(all, /eventType=CALL_REPORT/);
    assert.ok(all.includes(SID));
    assert.match(all, /result=PROCESSED/);
    assert.match(all, /correlation=PHONE_NUMBER/);
    assert.match(all, /result=DUPLICATE/);

    for (const sensitive of ["9876543210", "9123456789", "callrecords.callerdesk.io", "01204567890"]) {
      assert.ok(!all.includes(sensitive), `logs must not contain ${sensitive}`);
    }
  });

  it("neutralises control characters and length in attacker-controlled values before logging", async () => {
    const { service } = setup();
    // Valid-length CallSid (<= 200) so it passes validation and reaches the logger; unknown direction -> unmatched.
    await service.processWebhook({ CallSid: `evil\nINJECTED LINE\r\nresult=FAKE${"x".repeat(100)}`, Status: "X\nY" });
    assert.ok(logs.length > 0);
    assert.ok(logs.every((line) => !line.includes("\n") && !line.includes("\r")), "no raw newline reaches a log line");
    assert.ok(logs.every((line) => line.length < 400), "attacker-controlled values are length-bounded");
    // '=' is stripped too, so a payload cannot forge a `result=...` field in our structured log lines.
    assert.ok(!logs.some((line) => line.includes("result=FAKE")), "cannot forge key=value fields");
    assert.ok(logs.some((line) => line.includes("evil?INJECTED")), "control characters are replaced, not dropped silently");
  });
});
