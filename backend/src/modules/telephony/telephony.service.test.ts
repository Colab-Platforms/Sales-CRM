import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { CallerDeskProvider } from "./callerdesk.provider.js";
import { ExotelProvider } from "./exotel.provider.js";
import {
  ProviderInitiationError,
  type InitiateOutboundCallInput,
  type InitiateOutboundCallResult,
  type InitiationFailureKind,
  type TelephonyProvider,
  type TelephonyProviderName,
} from "./provider.types.js";
import {
  TelephonyInitiationFailedError,
  createTelephonyService,
  readTelephonyConfigFromEnv,
} from "./telephony.service.js";

const INPUT: InitiateOutboundCallInput = {
  callId: "call-1",
  leadId: "lead-1",
  agentNumber: "9123456789",
  customerNumber: "9876543210",
  businessNumber: null,
};

type Behaviour = { ok: InitiateOutboundCallResult } | { kind: InitiationFailureKind; code: string } | { unexpected: Error };

function fakeProvider(name: TelephonyProviderName, behaviour: Behaviour) {
  const calls: InitiateOutboundCallInput[] = [];
  const provider: TelephonyProvider = {
    name,
    isConfigured: () => true,
    async initiateOutboundCall(input) {
      calls.push(input);
      if ("ok" in behaviour) return behaviour.ok;
      if ("unexpected" in behaviour) throw behaviour.unexpected;
      throw new ProviderInitiationError(name, behaviour.kind, behaviour.code, "failed");
    },
    async getCallStatus() {
      return null;
    },
    normalizeWebhookEvent() {
      return { ok: false, reason: "n/a" };
    },
  };
  return { provider, calls };
}

const okResult = (provider: TelephonyProviderName): InitiateOutboundCallResult => ({
  provider,
  providerCallId: "sid-1",
  campaignId: null,
  status: "INITIATED",
});

function build(primary: Behaviour, fallback: Behaviour, config?: { fallback?: TelephonyProviderName | null }) {
  const cd = fakeProvider("CALLERDESK", primary);
  const ex = fakeProvider("EXOTEL", fallback);
  const service = createTelephonyService({
    providers: { CALLERDESK: cd.provider, EXOTEL: ex.provider },
    primary: "CALLERDESK",
    fallback: config && "fallback" in config ? (config.fallback ?? null) : "EXOTEL",
  });
  return { service, cd, ex };
}

afterEach(() => mock.restoreAll());

describe("provider fallback (CallerDesk primary, Exotel backup)", () => {
  it("uses only the primary when it succeeds", async () => {
    const { service, cd, ex } = build({ ok: okResult("CALLERDESK") }, { ok: okResult("EXOTEL") });

    const outcome = await service.initiateOutboundCall(INPUT);

    assert.equal(outcome.result.provider, "CALLERDESK");
    assert.equal(outcome.fallbackUsed, false);
    assert.equal(cd.calls.length, 1);
    assert.equal(ex.calls.length, 0, "a successful primary call is never duplicated on the backup");
  });

  it("falls back once when the primary certainly did not dispatch the call", async () => {
    const { service, cd, ex } = build({ kind: "NOT_DISPATCHED", code: "NOT_CONFIGURED" }, { ok: okResult("EXOTEL") });

    const outcome = await service.initiateOutboundCall(INPUT);

    assert.equal(outcome.result.provider, "EXOTEL");
    assert.equal(outcome.fallbackUsed, true);
    assert.equal(cd.calls.length, 1);
    assert.equal(ex.calls.length, 1);
    assert.deepEqual(outcome.attempts, [{ provider: "CALLERDESK", kind: "NOT_DISPATCHED", code: "NOT_CONFIGURED" }]);
  });

  it("does NOT fall back when the outcome is uncertain (a call may already be ringing)", async () => {
    const { service, ex } = build({ kind: "UNCERTAIN", code: "TIMEOUT" }, { ok: okResult("EXOTEL") });

    await assert.rejects(service.initiateOutboundCall(INPUT), (err: unknown) => {
      assert.ok(err instanceof TelephonyInitiationFailedError);
      assert.equal(err.callMayHaveBeenPlaced, true);
      assert.deepEqual(err.attempts, [{ provider: "CALLERDESK", kind: "UNCERTAIN", code: "TIMEOUT" }]);
      return true;
    });
    assert.equal(ex.calls.length, 0, "no second call to the customer");
  });

  it("treats an unexpected error as uncertain and never falls back", async () => {
    const { service, ex } = build({ unexpected: new Error("boom") }, { ok: okResult("EXOTEL") });

    await assert.rejects(service.initiateOutboundCall(INPUT), (err: unknown) => err instanceof TelephonyInitiationFailedError && err.callMayHaveBeenPlaced);
    assert.equal(ex.calls.length, 0);
  });

  it("surfaces both attempts when the backup also fails, without retrying either", async () => {
    const { service, cd, ex } = build({ kind: "NOT_DISPATCHED", code: "REJECTED" }, { kind: "NOT_DISPATCHED", code: "NOT_CONFIGURED" });

    await assert.rejects(service.initiateOutboundCall(INPUT), (err: unknown) => {
      assert.ok(err instanceof TelephonyInitiationFailedError);
      assert.equal(err.callMayHaveBeenPlaced, false);
      assert.equal(err.attempts.length, 2);
      return true;
    });
    assert.equal(cd.calls.length, 1, "no retry loop");
    assert.equal(ex.calls.length, 1, "no retry loop");
  });

  it("flags an uncertain backup failure as possibly placed", async () => {
    const { service } = build({ kind: "NOT_DISPATCHED", code: "REJECTED" }, { kind: "UNCERTAIN", code: "TIMEOUT" });
    await assert.rejects(service.initiateOutboundCall(INPUT), (err: unknown) => err instanceof TelephonyInitiationFailedError && err.callMayHaveBeenPlaced);
  });

  it("does not fall back when no backup is configured", async () => {
    const { service, ex } = build({ kind: "NOT_DISPATCHED", code: "NOT_CONFIGURED" }, { ok: okResult("EXOTEL") }, { fallback: null });
    await assert.rejects(service.initiateOutboundCall(INPUT), TelephonyInitiationFailedError);
    assert.equal(ex.calls.length, 0);
  });

  it("never 'falls back' to the same provider", () => {
    assert.deepEqual(readTelephonyConfigFromEnv({ TELEPHONY_PRIMARY_PROVIDER: "EXOTEL", TELEPHONY_FALLBACK_PROVIDER: "EXOTEL" }), {
      primary: "EXOTEL",
      fallback: null,
    });
  });
});

describe("telephony configuration", () => {
  it("defaults to CallerDesk primary and Exotel backup", () => {
    assert.deepEqual(readTelephonyConfigFromEnv({}), { primary: "CALLERDESK", fallback: "EXOTEL" });
  });

  it("is case-insensitive, ignores junk, and supports disabling the fallback", () => {
    assert.deepEqual(readTelephonyConfigFromEnv({ TELEPHONY_PRIMARY_PROVIDER: "exotel", TELEPHONY_FALLBACK_PROVIDER: "callerdesk" }), {
      primary: "EXOTEL",
      fallback: "CALLERDESK",
    });
    assert.deepEqual(readTelephonyConfigFromEnv({ TELEPHONY_PRIMARY_PROVIDER: "nonsense", TELEPHONY_FALLBACK_PROVIDER: "none" }), {
      primary: "CALLERDESK",
      fallback: null,
    });
  });
});

describe("provider adapters", () => {
  it("CallerDesk without credentials never touches the network", async () => {
    const fetchSpy = mock.method(globalThis, "fetch", async () => {
      throw new Error("network must not be used");
    });

    await assert.rejects(new CallerDeskProvider({ apiKey: undefined }).initiateOutboundCall({ ...INPUT, businessNumber: "01204567890" }), (err: unknown) => {
      assert.ok(err instanceof ProviderInitiationError);
      assert.equal(err.kind, "NOT_DISPATCHED");
      assert.equal(err.code, "NOT_CONFIGURED");
      return true;
    });
    assert.equal(fetchSpy.mock.callCount(), 0);
    assert.equal(await new CallerDeskProvider({}).getCallStatus("x"), null);
  });

  it("Exotel never dials and reports itself unconfigured", async () => {
    const provider = new ExotelProvider();
    assert.equal(provider.isConfigured(), false);
    await assert.rejects(provider.initiateOutboundCall(INPUT), (err: unknown) => err instanceof ProviderInitiationError && err.kind === "NOT_DISPATCHED");
    assert.equal(await provider.getCallStatus("x"), null);
  });

  it("real adapters: a CallerDesk rejection falls back to Exotel, which cannot dial, so the chain fails with no call placed", async () => {
    const fakeFetch = (async () => new Response('{"type":"error","message":"nope"}', { status: 200 })) as typeof fetch;
    const service = createTelephonyService({
      providers: { CALLERDESK: new CallerDeskProvider({ apiKey: "test-key-not-real", fetchImpl: fakeFetch }), EXOTEL: new ExotelProvider() },
      primary: "CALLERDESK",
      fallback: "EXOTEL",
    });
    await assert.rejects(service.initiateOutboundCall({ ...INPUT, businessNumber: "01204567890" }), (err: unknown) => {
      assert.ok(err instanceof TelephonyInitiationFailedError);
      assert.equal(err.callMayHaveBeenPlaced, false);
      assert.deepEqual(
        err.attempts.map((a) => `${a.provider}:${a.kind}:${a.code}`),
        ["CALLERDESK:NOT_DISPATCHED:PROVIDER_REJECTED", "EXOTEL:NOT_DISPATCHED:INITIATION_NOT_IMPLEMENTED"],
      );
      return true;
    });
  });

  it("real adapters: an unconfirmed CallerDesk response never reaches Exotel", async () => {
    const fakeFetch = (async () => new Response("<html>gateway error</html>", { status: 502 })) as typeof fetch;
    const exotel = new ExotelProvider();
    const exotelSpy = mock.method(exotel, "initiateOutboundCall");
    const service = createTelephonyService({
      providers: { CALLERDESK: new CallerDeskProvider({ apiKey: "test-key-not-real", fetchImpl: fakeFetch }), EXOTEL: exotel },
      primary: "CALLERDESK",
      fallback: "EXOTEL",
    });
    await assert.rejects(service.initiateOutboundCall({ ...INPUT, businessNumber: "01204567890" }), (err: unknown) => {
      assert.ok(err instanceof TelephonyInitiationFailedError);
      assert.equal(err.callMayHaveBeenPlaced, true);
      return true;
    });
    assert.equal(exotelSpy.mock.callCount(), 0, "no second call to the customer");
  });
});

describe("CallerDesk adapter webhook normalisation (provider-neutral output)", () => {
  it("returns a neutral event with no CallerDesk-specific status or field names", () => {
    const provider = new CallerDeskProvider({ timestampUtcOffset: "+05:30" });
    const result = provider.normalizeWebhookEvent({ CallSid: "s1", Status: "Leg B Cancel - Customer Busy (17 Customer)", Direction: "WEBOBD", EndTime: "2023-01-02 14:00:00" });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.event.status, "BUSY");
      assert.equal(result.event.direction, "OUTBOUND");
      assert.equal(result.event.provider, "CALLERDESK");
    }
    assert.equal(provider.normalizeWebhookEvent("garbage").ok, false);
  });
});
