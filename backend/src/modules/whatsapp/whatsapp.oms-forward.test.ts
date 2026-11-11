import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { prisma } from "@/lib/prisma.js";
import { OmsForwardStatus } from "../../../generated/prisma/enums.js";
import { describeForwardError, describeTarget, forwardOne, isForwardingConfigured } from "./whatsapp.oms-forward.js";
import { logger } from "@/utils/logger.js";

// Unit tests only -- mocks both `fetch` (the OMS call) and `prisma.webhookEvent` (replaced
// wholesale with a plain stub, since Prisma's generated client exposes model delegates as
// proxies/getters that `node:test`'s `mock.method` can't patch in place), never touches a real
// database. This repo's DATABASE_URL in this environment points at a remote Neon instance, not a
// local dev database, so true `.db-test.ts`-style integration tests against a real webhook_events
// table were deliberately not attempted here -- see the accompanying report.

const ORIGINAL_ENV = { ...process.env };
const originalWebhookEvent = prisma.webhookEvent;

afterEach(() => {
  process.env.OMS_WHATSAPP_FORWARD_URL = ORIGINAL_ENV.OMS_WHATSAPP_FORWARD_URL;
  process.env.SALES_CRM_FORWARD_SECRET = ORIGINAL_ENV.SALES_CRM_FORWARD_SECRET;
  (prisma as any).webhookEvent = originalWebhookEvent;
  mock.restoreAll();
});

function configureForwarding() {
  process.env.OMS_WHATSAPP_FORWARD_URL = "http://localhost:8000/api/v1/internal/whatsapp/forwarded-event";
  process.env.SALES_CRM_FORWARD_SECRET = "test-shared-secret";
}

interface StubCalls {
  updateMany: any[];
  findUnique: any[];
  update: any[];
}

function stubWebhookEvent(opts: {
  claimable?: boolean;
  row?: Partial<{ externalEventId: string | null; omsForwardAttempts: number }>;
}): StubCalls {
  const calls: StubCalls = { updateMany: [], findUnique: [], update: [] };
  const row = {
    id: "evt-1",
    payload: { entry: [] },
    externalEventId: "sha256:abc123",
    omsForwardAttempts: 1,
    ...opts.row,
  };
  (prisma as any).webhookEvent = {
    updateMany: async (args: any) => {
      calls.updateMany.push(args);
      return { count: opts.claimable === false ? 0 : 1 };
    },
    findUnique: async (args: any) => {
      calls.findUnique.push(args);
      return row;
    },
    update: async (args: any) => {
      calls.update.push(args);
      return { ...row, ...args.data };
    },
  };
  return calls;
}

describe("isForwardingConfigured", () => {
  it("is false when either env var is missing", () => {
    delete process.env.OMS_WHATSAPP_FORWARD_URL;
    delete process.env.SALES_CRM_FORWARD_SECRET;
    assert.equal(isForwardingConfigured(), false);
  });

  it("is true when both are set", () => {
    configureForwarding();
    assert.equal(isForwardingConfigured(), true);
  });
});

describe("forwardOne", () => {
  it("is a no-op when forwarding is not configured (never throws, never touches the DB)", async () => {
    delete process.env.OMS_WHATSAPP_FORWARD_URL;
    delete process.env.SALES_CRM_FORWARD_SECRET;
    const calls = stubWebhookEvent({});
    const result = await forwardOne("evt-1");
    assert.equal(result, "skipped");
    assert.equal(calls.updateMany.length, 0);
  });

  it("returns 'skipped' when the event can't be claimed (already claimed by another worker)", async () => {
    configureForwarding();
    stubWebhookEvent({ claimable: false });
    const result = await forwardOne("evt-1");
    assert.equal(result, "skipped");
  });

  it("forwards the payload + delivery digest and marks FORWARDED on success", async () => {
    configureForwarding();
    const calls = stubWebhookEvent({});
    const fetchSpy = mock.method(globalThis, "fetch", async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      assert.equal(body.delivery_digest, "sha256:abc123");
      assert.deepEqual(body.payload, { entry: [] });
      assert.equal(init.headers.Authorization, "Bearer test-shared-secret");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await forwardOne("evt-1");

    assert.equal(result, "forwarded");
    assert.equal(fetchSpy.mock.callCount(), 1);
    assert.equal(calls.update[0].data.omsForwardStatus, OmsForwardStatus.FORWARDED);
  });

  it("marks FAILED with backoff on a non-2xx OMS response, retries while under MAX_ATTEMPTS", async () => {
    configureForwarding();
    const calls = stubWebhookEvent({ row: { omsForwardAttempts: 2 } });
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({}), { status: 500 }));

    const result = await forwardOne("evt-1");

    assert.equal(result, "retry");
    assert.equal(calls.update[0].data.omsForwardStatus, OmsForwardStatus.FAILED);
    assert.ok(calls.update[0].data.omsForwardNextAttemptAt instanceof Date);
  });

  it("stops retrying once MAX_ATTEMPTS is reached, clears next-attempt (never silently discarded -- stays FAILED, visible)", async () => {
    configureForwarding();
    const calls = stubWebhookEvent({ row: { omsForwardAttempts: 8 } }); // == MAX_ATTEMPTS
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({}), { status: 500 }));

    const result = await forwardOne("evt-1");

    assert.equal(result, "failed");
    assert.equal(calls.update[0].data.omsForwardStatus, OmsForwardStatus.FAILED);
    assert.equal(calls.update[0].data.omsForwardNextAttemptAt, null);
  });

  it("treats a network error / OMS-unavailable the same as a failed response -- never throws out of forwardOne", async () => {
    configureForwarding();
    const calls = stubWebhookEvent({ row: { omsForwardAttempts: 1 } });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await forwardOne("evt-1");

    assert.equal(result, "retry");
    assert.equal(calls.update[0].data.omsForwardStatus, OmsForwardStatus.FAILED);
  });

  it("times out instead of hanging forever when OMS never responds", async () => {
    configureForwarding();
    stubWebhookEvent({ row: { omsForwardAttempts: 1 } });
    mock.method(globalThis, "fetch", async (_url: string, init: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    });

    const start = Date.now();
    const result = await forwardOne("evt-1");
    const elapsed = Date.now() - start;

    assert.equal(result, "retry");
    assert.ok(elapsed < 15_000, `expected the 10s timeout to fire, took ${elapsed}ms`);
  });

  it("fails safely (never forwards) when the stored event has no delivery digest", async () => {
    configureForwarding();
    const calls = stubWebhookEvent({ row: { externalEventId: null } });
    const fetchSpy = mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));

    const result = await forwardOne("evt-1");

    assert.equal(result, "failed");
    assert.equal(fetchSpy.mock.callCount(), 0); // never even attempted the HTTP call
    assert.match(calls.update[0].data.omsForwardErrorMessage, /delivery digest/i);
  });

  it("a refused connection is logged and stored with the REAL reason (Node's cause), the target and a hint - not just 'fetch failed'; the secret is never included", async () => {
    configureForwarding();
    const calls = stubWebhookEvent({ row: { omsForwardAttempts: 2 } });
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" }) });
    mock.method(globalThis, "fetch", async () => { throw refused; });
    const warn = mock.method(logger, "warn", () => undefined);

    assert.equal(await forwardOne("evt-1"), "retry");

    const stored: string = calls.update[0].data.omsForwardErrorMessage;
    assert.match(stored, /ECONNREFUSED/);
    assert.match(stored, /http:\/\/localhost:8000\/api\/v1\/internal\/whatsapp\/forwarded-event/);
    assert.match(stored, /nothing is listening/);
    const logged = String(warn.mock.calls[0]!.arguments[0]);
    assert.match(logged, /whatsapp_oms_forward_failed: eventId=evt-1 attempt=2\/8 reason=fetch failed: ECONNREFUSED/);
    assert.equal(logged.includes("test-shared-secret") || stored.includes("test-shared-secret"), false);
  });

  it("describeForwardError: DNS failure, IPv4+IPv6 AggregateError, timeout and non-Error values", () => {
    const url = "https://oms.example.com/hook?token=SECRET#frag";
    const dns = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND oms.example.com"), { code: "ENOTFOUND" }) });
    assert.match(describeForwardError(dns, url), /ENOTFOUND.*DNS/);
    const agg = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(""), { code: "ECONNREFUSED", errors: [Object.assign(new Error("connect ECONNREFUSED ::1:8000"), { code: "ECONNREFUSED" }), Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" })] }) });
    assert.match(describeForwardError(agg, "http://localhost:8000/x"), /ECONNREFUSED/);
    assert.match(describeForwardError(Object.assign(new Error("aborted"), { name: "AbortError" }), url), /timeout/);
    assert.match(describeForwardError("boom", url), /boom/);
    const text = describeForwardError(dns, url);
    assert.equal(text.includes("SECRET") || text.includes("frag") || text.includes("token"), false, "no query string or fragment in the logged target");
    assert.equal(describeTarget("not a url"), "(invalid OMS_WHATSAPP_FORWARD_URL)");
  });

  it("a non-2xx answer logs the status, the attempt, the target and a short excerpt of the OMS's reason", async () => {
    configureForwarding();
    const calls = stubWebhookEvent({ row: { omsForwardAttempts: 1 } });
    mock.method(globalThis, "fetch", async () => new Response('{"detail":"Invalid forward secret"}', { status: 401 }));
    const warn = mock.method(logger, "warn", () => undefined);
    assert.equal(await forwardOne("evt-1"), "retry");
    assert.match(calls.update[0].data.omsForwardErrorMessage, /OMS responded 401.*Invalid forward secret/);
    assert.match(String(warn.mock.calls[0]!.arguments[0]), /status=401 attempt=1\/8 target=http:\/\/localhost:8000.*Invalid forward secret/);
  });
});
