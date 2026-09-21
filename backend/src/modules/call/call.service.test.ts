import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { CallStatus, Role } from "@root/generated/prisma/enums.js";
import { CallerDeskProvider } from "@modules/telephony/callerdesk.provider.js";
import { ExotelProvider } from "@modules/telephony/exotel.provider.js";
import type { InitiateOutboundCallInput, InitiateOutboundCallResult, InitiationFailureKind } from "@modules/telephony/provider.types.js";
import { TelephonyInitiationFailedError, createTelephonyService, type InitiationOutcome } from "@modules/telephony/telephony.service.js";
import { pickCallingIdentity } from "./call.store.js";
import {
  ACTIVE_CALL_WINDOW_MINUTES,
  CallInitiationError,
  canAccessLead,
  createCallService,
  toDialableNumber,
} from "./call.service.js";
import { createInMemoryCallInitiationStore } from "./call.testkit.js";

let clockMs = Date.parse("2026-09-21T10:00:00.000Z");
const clock = { now: () => new Date(clockMs) };
let logs: string[] = [];

beforeEach(() => {
  clockMs = Date.parse("2026-09-21T10:00:00.000Z");
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);
});
afterEach(() => mock.restoreAll());

type TelephonyBehaviour =
  | { result: Partial<InitiateOutboundCallResult>; fallbackUsed?: boolean }
  | { fail: { kind: InitiationFailureKind; code: string }[] }
  | { unexpected: Error };

function fakeTelephony(behaviour: TelephonyBehaviour) {
  const calls: InitiateOutboundCallInput[] = [];
  return {
    calls,
    telephony: {
      async initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiationOutcome> {
        calls.push(input);
        if ("unexpected" in behaviour) throw behaviour.unexpected;
        if ("fail" in behaviour) {
          throw new TelephonyInitiationFailedError(behaviour.fail.map((f) => ({ provider: "CALLERDESK" as const, ...f })));
        }
        return {
          result: { provider: "CALLERDESK", providerCallId: "3494009", campaignId: "3494009", status: CallStatus.INITIATED, ...behaviour.result },
          fallbackUsed: behaviour.fallbackUsed ?? false,
          attempts: [],
        };
      },
    },
  };
}

/** A salesperson who owns a lead, with a phone number and a group-wide business number. */
function world(behaviour: TelephonyBehaviour = { result: {} }) {
  const kit = createInMemoryCallInitiationStore(clock);
  const agent = kit.addAgent();
  const lead = kit.addLead({ ownerId: agent.id, assignedManagerId: "manager-1", groupId: "group-1" });
  const identity = kit.addIdentity({ groupId: "group-1" });
  const tel = fakeTelephony(behaviour);
  const service = createCallService({ store: kit.store, telephony: tel.telephony, now: clock.now });
  return { kit, agent, lead, identity, tel, service, actor: { id: agent.id, role: Role.SALESPERSON } };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<CallInitiationError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CallInitiationError, `expected CallInitiationError(${code}), got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

describe("POST /api/calls - happy path", () => {
  it("creates the Call, dials via telephony with resolved numbers, and records the provider id", async () => {
    const w = world();

    const response = await w.service.initiateCall(w.actor, { leadId: w.lead.id });

    assert.equal(response.status, CallStatus.INITIATED);
    assert.deepEqual(response.callingIdentity, { displayName: "Avatar Sales", number: "01204567890" });

    assert.equal(w.kit.calls.length, 1);
    const call = w.kit.calls[0]!;
    assert.equal(call.id, response.callId);
    assert.equal(call.direction, "OUTBOUND");
    assert.equal(call.status, CallStatus.INITIATED);
    assert.equal(call.provider, "callerdesk");
    assert.equal(call.providerCallId, "3494009", "campid stored so webhooks can correlate");
    assert.equal(call.leadId, w.lead.id);
    assert.equal(call.agentId, w.agent.id);
    assert.equal(call.virtualNumberId, w.identity.virtualNumberId);
    assert.equal(call.agentNumber, "9123456789");
    assert.equal(call.customerNumber, "9876543210");

    assert.deepEqual(w.tel.calls, [
      { callId: call.id, leadId: w.lead.id, agentNumber: "9123456789", customerNumber: "9876543210", businessNumber: "01204567890" },
    ]);
  });

  it("returns a provider-neutral response: no provider name, campaign id or provider status", async () => {
    const w = world();
    const response = await w.service.initiateCall(w.actor, { leadId: w.lead.id });

    assert.deepEqual(Object.keys(response).sort(), ["callId", "callingIdentity", "status"]);
    const text = JSON.stringify(response).toLowerCase();
    for (const forbidden of ["callerdesk", "exotel", "campid", "3494009", "provider"]) {
      assert.ok(!text.includes(forbidden), `response must not contain "${forbidden}"`);
    }
  });

  it("records the backup provider when a fallback placed the call", async () => {
    const w = world({ result: { provider: "EXOTEL", providerCallId: "EX-1" }, fallbackUsed: true });
    await w.service.initiateCall(w.actor, { leadId: w.lead.id });
    assert.equal(w.kit.calls[0]!.provider, "exotel");
    assert.equal(w.kit.calls[0]!.providerCallId, "EX-1");
  });

  it("succeeds even when the provider returns no id (call placed; nothing to correlate)", async () => {
    const w = world({ result: { providerCallId: null, campaignId: null } });
    const response = await w.service.initiateCall(w.actor, { leadId: w.lead.id });
    assert.equal(response.status, CallStatus.INITIATED);
    assert.equal(w.kit.calls[0]!.providerCallId, null);
    assert.ok(logs.some((l) => l.includes("without a provider call id")));
  });

  it("still succeeds when recording the provider id fails after the call was accepted", async () => {
    const w = world();
    w.kit.failMarkInitiatedOnce();

    const response = await w.service.initiateCall(w.actor, { leadId: w.lead.id });

    assert.equal(response.status, CallStatus.INITIATED);
    assert.equal(w.tel.calls.length, 1);
    const all = logs.join("\n");
    assert.ok(all.includes("3494009"), "provider id is logged so it can be reconciled by hand");
    assert.ok(!all.includes("FAKE-LEAK-CANARY"), "DB error text is never logged");
  });
});

describe("POST /api/calls - authorisation (same rules as lead.service.ts)", () => {
  it("a salesperson may call only their own lead; others get LEAD_NOT_FOUND and nothing is dialled", async () => {
    const w = world();
    const stranger = w.kit.addAgent();

    const err = await expectCode(w.service.initiateCall({ id: stranger.id, role: Role.SALESPERSON }, { leadId: w.lead.id }), "LEAD_NOT_FOUND");

    assert.equal(err.httpStatus, 404);
    assert.equal(w.kit.calls.length, 0);
    assert.equal(w.tel.calls.length, 0);
  });

  it("an unknown lead is indistinguishable from an inaccessible one", async () => {
    const w = world();
    const missing = await expectCode(w.service.initiateCall(w.actor, { leadId: "00000000-0000-4000-8000-000000000000" }), "LEAD_NOT_FOUND");
    const forbidden = await expectCode(
      w.service.initiateCall({ id: w.kit.addAgent().id, role: Role.SALESPERSON }, { leadId: w.lead.id }),
      "LEAD_NOT_FOUND",
    );
    assert.equal(missing.message, forbidden.message);
    assert.equal(missing.httpStatus, forbidden.httpStatus);
  });

  it("a manager may call only leads assigned to them; an admin may call any lead", async () => {
    const w = world();
    const managerAgent = w.kit.addAgent({ id: "manager-1" });
    const otherManager = w.kit.addAgent({ id: "manager-2" });
    const admin = w.kit.addAgent({ id: "admin-1", phone: "9000000009" });

    await expectCode(w.service.initiateCall({ id: otherManager.id, role: Role.MANAGER }, { leadId: w.lead.id }), "LEAD_NOT_FOUND");
    assert.equal(w.tel.calls.length, 0);

    await w.service.initiateCall({ id: managerAgent.id, role: Role.MANAGER }, { leadId: w.lead.id });
    assert.equal(w.kit.calls[0]!.agentId, managerAgent.id, "the caller's own phone rings, not the lead owner's");

    const otherLead = w.kit.addLead({ ownerId: "someone-else", assignedManagerId: "manager-9", groupId: "group-1" });
    await w.service.initiateCall({ id: admin.id, role: Role.ADMIN }, { leadId: otherLead.id });
    assert.equal(w.kit.calls.length, 2);
  });

  it("canAccessLead mirrors the lead module's visibility", () => {
    const lead = { id: "l", normalizedMobile: null, mobile: null, ownerId: "s1", assignedManagerId: "m1", groupId: null };
    assert.equal(canAccessLead({ id: "x", role: Role.ADMIN }, lead), true);
    assert.equal(canAccessLead({ id: "m1", role: Role.MANAGER }, lead), true);
    assert.equal(canAccessLead({ id: "m2", role: Role.MANAGER }, lead), false);
    assert.equal(canAccessLead({ id: "s1", role: Role.SALESPERSON }, lead), true);
    assert.equal(canAccessLead({ id: "s2", role: Role.SALESPERSON }, lead), false);
    assert.equal(canAccessLead({ id: "m1", role: Role.SALESPERSON }, { ...lead, ownerId: null }), false);
  });
});

describe("POST /api/calls - number resolution", () => {
  it("normalises Indian formats and refuses anything that could dial a stranger", () => {
    assert.equal(toDialableNumber("9876543210"), "9876543210");
    assert.equal(toDialableNumber("+91 98765 43210"), "9876543210");
    assert.equal(toDialableNumber("919876543210"), "9876543210");
    assert.equal(toDialableNumber("09876543210"), "9876543210");
    assert.equal(toDialableNumber("98765-43210"), "9876543210");

    for (const bad of [null, undefined, "", "12345", "+1 415 555 2671", "14155552671", "+44 7911 123456", "98765432101234", "0919876543210"]) {
      assert.equal(toDialableNumber(bad as string | null | undefined), null, String(bad));
    }
  });

  it("uses normalizedMobile, falling back to the mobile as entered", async () => {
    const w = world();
    const lead = w.kit.addLead({ ownerId: w.agent.id, groupId: "group-1", normalizedMobile: null, mobile: "098765 43210" });
    await w.service.initiateCall(w.actor, { leadId: lead.id });
    assert.equal(w.kit.calls[0]!.customerNumber, "9876543210");
  });

  it("LEAD_PHONE_MISSING when the lead has no dialable number - nothing created or dialled", async () => {
    for (const lead of [{ normalizedMobile: null, mobile: null }, { normalizedMobile: "14155552671", mobile: null }, { normalizedMobile: "12345", mobile: null }]) {
      const w = world();
      const noPhone = w.kit.addLead({ ownerId: w.agent.id, groupId: "group-1", ...lead });
      const err = await expectCode(w.service.initiateCall(w.actor, { leadId: noPhone.id }), "LEAD_PHONE_MISSING");
      assert.equal(err.httpStatus, 422);
      assert.equal(w.kit.calls.length, 0);
      assert.equal(w.tel.calls.length, 0);
    }
  });

  it("AGENT_PHONE_MISSING when the caller has no valid phone or is inactive", async () => {
    for (const patch of [{ phone: null }, { phone: "12345" }, { phone: "+1 415 555 2671" }, { isActive: false }]) {
      const w = world();
      const agent = w.kit.addAgent({ ...patch });
      const lead = w.kit.addLead({ ownerId: agent.id, groupId: "group-1" });
      const err = await expectCode(w.service.initiateCall({ id: agent.id, role: Role.SALESPERSON }, { leadId: lead.id }), "AGENT_PHONE_MISSING");
      assert.equal(err.httpStatus, 422);
      assert.equal(w.tel.calls.length, 0);
    }
  });

  it("AGENT_PHONE_MISSING for a caller who no longer exists", async () => {
    const w = world();
    await expectCode(w.service.initiateCall({ id: "ghost", role: Role.ADMIN }, { leadId: w.lead.id }), "AGENT_PHONE_MISSING");
  });
});

describe("POST /api/calls - calling identity (business number)", () => {
  it("prefers the lead's group number, then a global one; deterministic by order", () => {
    const rows = [
      { id: "global-old", groupId: null },
      { id: "g2", groupId: "group-2" },
      { id: "g1-a", groupId: "group-1" },
      { id: "g1-b", groupId: "group-1" },
    ];
    assert.equal(pickCallingIdentity(rows, "group-1")?.id, "g1-a", "group-specific beats global; oldest wins");
    assert.equal(pickCallingIdentity(rows, "group-3")?.id, "global-old", "no number for this group -> global");
    assert.equal(pickCallingIdentity(rows, null)?.id, "global-old", "lead without a group -> global only");
    assert.equal(pickCallingIdentity([{ id: "g2", groupId: "group-2" }], "group-1"), null, "another group's number is never used");
    assert.equal(pickCallingIdentity([], null), null);
  });

  it("CALLING_IDENTITY_UNAVAILABLE when none is configured - nothing created or dialled", async () => {
    const kit = createInMemoryCallInitiationStore(clock);
    const agent = kit.addAgent();
    const lead = kit.addLead({ ownerId: agent.id, groupId: "group-1" });
    kit.addIdentity({ groupId: "some-other-group" });
    const tel = fakeTelephony({ result: {} });
    const service = createCallService({ store: kit.store, telephony: tel.telephony, now: clock.now });

    const err = await expectCode(service.initiateCall({ id: agent.id, role: Role.SALESPERSON }, { leadId: lead.id }), "CALLING_IDENTITY_UNAVAILABLE");

    assert.equal(err.httpStatus, 422);
    assert.equal(kit.calls.length, 0);
    assert.equal(tel.calls.length, 0);
  });

  it("passes the configured number to the provider verbatim (digits only)", async () => {
    const kit = createInMemoryCallInitiationStore(clock);
    const agent = kit.addAgent();
    const lead = kit.addLead({ ownerId: agent.id });
    kit.addIdentity({ number: "8069183456", displayName: null });
    const tel = fakeTelephony({ result: {} });
    const service = createCallService({ store: kit.store, telephony: tel.telephony, now: clock.now });

    const response = await service.initiateCall({ id: agent.id, role: Role.SALESPERSON }, { leadId: lead.id });

    assert.equal(tel.calls[0]!.businessNumber, "8069183456");
    assert.deepEqual(response.callingIdentity, { displayName: null, number: "8069183456" });
  });
});

describe("POST /api/calls - never creates duplicate calls", () => {
  it("a second click while the first call is active is refused and dials nothing", async () => {
    const w = world();
    const first = await w.service.initiateCall(w.actor, { leadId: w.lead.id });

    const err = await expectCode(w.service.initiateCall(w.actor, { leadId: w.lead.id }), "CALL_ALREADY_IN_PROGRESS");

    assert.equal(err.httpStatus, 409);
    assert.equal(err.callId, first.callId, "the caller is told which call is already active");
    assert.equal(w.kit.calls.length, 1);
    assert.equal(w.tel.calls.length, 1, "exactly one provider request");
  });

  it("two simultaneous requests: exactly one call is created and dialled", async () => {
    const w = world();

    const results = await Promise.allSettled([
      w.service.initiateCall(w.actor, { leadId: w.lead.id }),
      w.service.initiateCall(w.actor, { leadId: w.lead.id }),
      w.service.initiateCall(w.actor, { leadId: w.lead.id }),
    ]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((r) => r.reason instanceof CallInitiationError && r.reason.code === "CALL_ALREADY_IN_PROGRESS"));
    assert.equal(w.kit.calls.length, 1);
    assert.equal(w.tel.calls.length, 1);
  });

  it("an agent cannot start a second call while one is active, even to another lead", async () => {
    const w = world();
    const other = w.kit.addLead({ ownerId: w.agent.id, groupId: "group-1", normalizedMobile: "919812345678", mobile: null });
    await w.service.initiateCall(w.actor, { leadId: w.lead.id });

    await expectCode(w.service.initiateCall(w.actor, { leadId: other.id }), "CALL_ALREADY_IN_PROGRESS");
    assert.equal(w.tel.calls.length, 1);
  });

  it("two agents cannot both dial the same lead at once", async () => {
    const w = world();
    const manager = w.kit.addAgent({ id: "manager-1", phone: "9000000002" });
    await w.service.initiateCall(w.actor, { leadId: w.lead.id });

    await expectCode(w.service.initiateCall({ id: manager.id, role: Role.MANAGER }, { leadId: w.lead.id }), "CALL_ALREADY_IN_PROGRESS");
    assert.equal(w.tel.calls.length, 1);
  });

  it("a finished call does not block a new one", async () => {
    const w = world();
    await w.service.initiateCall(w.actor, { leadId: w.lead.id });
    w.kit.calls[0]!.status = CallStatus.COMPLETED;

    await w.service.initiateCall(w.actor, { leadId: w.lead.id });
    assert.equal(w.kit.calls.length, 2);
    assert.equal(w.tel.calls.length, 2);
  });

  it("a stale active call (webhooks never arrived) stops blocking after the window", async () => {
    const w = world();
    await w.service.initiateCall(w.actor, { leadId: w.lead.id });

    clockMs += (ACTIVE_CALL_WINDOW_MINUTES - 1) * 60_000;
    await expectCode(w.service.initiateCall(w.actor, { leadId: w.lead.id }), "CALL_ALREADY_IN_PROGRESS");

    clockMs += 2 * 60_000;
    await w.service.initiateCall(w.actor, { leadId: w.lead.id });
    assert.equal(w.kit.calls.length, 2);
  });
});

describe("POST /api/calls - provider failure handling", () => {
  it("certainly-not-placed failure: Call marked FAILED, TELEPHONY_UNAVAILABLE (503), and a retry is allowed", async () => {
    const w = world({ fail: [{ kind: "NOT_DISPATCHED", code: "PROVIDER_REJECTED" }, { kind: "NOT_DISPATCHED", code: "INITIATION_NOT_IMPLEMENTED" }] });

    const err = await expectCode(w.service.initiateCall(w.actor, { leadId: w.lead.id }), "TELEPHONY_UNAVAILABLE");

    assert.equal(err.httpStatus, 503);
    assert.equal(err.callId, w.kit.calls[0]!.id);
    assert.equal(w.kit.calls[0]!.status, CallStatus.FAILED);
    assert.ok(!/callerdesk|exotel|reject/i.test(err.message), "message is provider-neutral");

    await expectCode(w.service.initiateCall(w.actor, { leadId: w.lead.id }), "TELEPHONY_UNAVAILABLE");
    assert.equal(w.kit.calls.length, 2, "a failed call does not block the retry");
    assert.equal(w.tel.calls.length, 2);
  });

  it("possibly-placed failure: CALL_OUTCOME_UNKNOWN (502), Call stays INITIATED, and a blind retry is blocked", async () => {
    const w = world({ fail: [{ kind: "UNCERTAIN", code: "TIMEOUT" }] });

    const err = await expectCode(w.service.initiateCall(w.actor, { leadId: w.lead.id }), "CALL_OUTCOME_UNKNOWN");

    assert.equal(err.httpStatus, 502);
    assert.equal(err.callId, w.kit.calls[0]!.id);
    assert.equal(w.kit.calls[0]!.status, CallStatus.INITIATED, "not marked failed - the call may be ringing");

    await expectCode(w.service.initiateCall(w.actor, { leadId: w.lead.id }), "CALL_ALREADY_IN_PROGRESS");
    assert.equal(w.tel.calls.length, 1, "no second provider request");
  });

  it("an unexpected error from telephony is treated as uncertain, never as safe-to-retry", async () => {
    const w = world({ unexpected: new Error("connection to FAKE-LEAK-CANARY failed") });

    const err = await expectCode(w.service.initiateCall(w.actor, { leadId: w.lead.id }), "CALL_OUTCOME_UNKNOWN");

    assert.equal(w.kit.calls[0]!.status, CallStatus.INITIATED);
    assert.ok(!err.message.includes("FAKE-LEAK-CANARY"));
    assert.ok(!logs.join("\n").includes("FAKE-LEAK-CANARY"));
  });

  it("logs contain ids and outcomes but no phone numbers", async () => {
    const w = world();
    await w.service.initiateCall(w.actor, { leadId: w.lead.id });
    const all = logs.join("\n");
    assert.match(all, /result=INITIATED/);
    for (const sensitive of ["9876543210", "9123456789", "01204567890"]) {
      assert.ok(!all.includes(sensitive), `logs must not contain ${sensitive}`);
    }
  });
});

describe("POST /api/calls - end to end with the real TelephonyService and CallerDesk provider (fake fetch)", () => {
  const SUCCESS = '{"type":"success","message":"Call to Customer Initiate Successfully..","campid":3494009,"callerid":"1204567890"}';

  function realStack(fetchImpl: typeof fetch) {
    const kit = createInMemoryCallInitiationStore(clock);
    const agent = kit.addAgent();
    const lead = kit.addLead({ ownerId: agent.id, groupId: "group-1" });
    kit.addIdentity({ groupId: "group-1" });
    const exotel = new ExotelProvider();
    const exotelSpy = mock.method(exotel, "initiateOutboundCall");
    const telephony = createTelephonyService({
      providers: { CALLERDESK: new CallerDeskProvider({ apiKey: "test-key-not-real", fetchImpl }), EXOTEL: exotel },
      primary: "CALLERDESK",
      fallback: "EXOTEL",
    });
    const service = createCallService({ store: kit.store, telephony, now: clock.now });
    return { kit, lead, service, exotelSpy, actor: { id: agent.id, role: Role.SALESPERSON } };
  }

  it("CallerDesk accepts: one request, campid stored on the Call, Exotel untouched", async () => {
    const urls: URL[] = [];
    const s = realStack((async (input: string | URL) => {
      urls.push(new URL(String(input)));
      return new Response(SUCCESS, { status: 200 });
    }) as typeof fetch);

    const response = await s.service.initiateCall(s.actor, { leadId: s.lead.id });

    assert.equal(urls.length, 1);
    assert.equal(urls[0]!.searchParams.get("calling_party_a"), "9123456789");
    assert.equal(urls[0]!.searchParams.get("calling_party_b"), "9876543210");
    assert.equal(urls[0]!.searchParams.get("deskphone"), "01204567890");
    assert.equal(s.kit.calls[0]!.providerCallId, "3494009");
    assert.equal(s.kit.calls[0]!.provider, "callerdesk");
    assert.equal(response.status, CallStatus.INITIATED);
    assert.equal(s.exotelSpy.mock.callCount(), 0);
  });

  it("CallerDesk definitively rejects: Exotel is tried once (it cannot dial), no call is placed, Call FAILED", async () => {
    const s = realStack((async () => new Response('{"type":"error","message":"Invalid Auth Code!"}', { status: 200 })) as typeof fetch);

    await expectCode(s.service.initiateCall(s.actor, { leadId: s.lead.id }), "TELEPHONY_UNAVAILABLE");

    assert.equal(s.exotelSpy.mock.callCount(), 1);
    assert.equal(s.kit.calls[0]!.status, CallStatus.FAILED);
  });

  it("CallerDesk times out / 5xx: NO fallback, the customer is never dialled twice", async () => {
    for (const impl of [
      (async () => new Response("bad gateway", { status: 502 })) as typeof fetch,
      (async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
      }) as typeof fetch,
    ]) {
      const s = realStack(impl);
      await expectCode(s.service.initiateCall(s.actor, { leadId: s.lead.id }), "CALL_OUTCOME_UNKNOWN");
      assert.equal(s.exotelSpy.mock.callCount(), 0, "fallback must not run after an uncertain outcome");
      assert.equal(s.kit.calls[0]!.status, CallStatus.INITIATED);
    }
  });

  it("CallerDesk unreachable (DNS): definitive NOT_DISPATCHED, falls back once", async () => {
    const s = realStack((async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
    }) as typeof fetch);

    await expectCode(s.service.initiateCall(s.actor, { leadId: s.lead.id }), "TELEPHONY_UNAVAILABLE");
    assert.equal(s.exotelSpy.mock.callCount(), 1);
  });
});
