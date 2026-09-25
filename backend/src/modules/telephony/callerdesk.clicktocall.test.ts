import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { CallStatus } from "@root/generated/prisma/enums.js";
import {
  CALLERDESK_CLICK_TO_CALL_URL,
  CallerDeskProvider,
  classifyClickToCallResponse,
} from "./callerdesk.provider.js";
import { ProviderInitiationError, type InitiateOutboundCallInput } from "./provider.types.js";

const API_KEY = "test-authcode-not-real-0123456789abcdef";

const INPUT: InitiateOutboundCallInput = {
  callId: "call-1",
  leadId: "lead-1",
  agentNumber: "9123456789",
  customerNumber: "9876543210",
  businessNumber: "01204567890",
};

/** Official documented success body (values un-masked with synthetic ones). */
const SUCCESS_BODY = '{"type":"success","message":"Call to Customer Initiate Successfully..","campid":3494009,"callerid":"1204567890"}';
/** Observed 2026-09-21 with an invalid auth code: HTTP 200, text/html, JSON body. */
const OBSERVED_AUTH_ERROR = '{"type":"error","message":"Invalid Auth Code!"}';

interface Captured {
  url: URL;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (captured: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured = { url: new URL(input instanceof Request ? input.url : String(input)), init };
    calls.push(captured);
    return respond(captured);
  }) as typeof fetch;
  return { impl, calls };
}

const provider = (impl: typeof fetch, extra: { timeoutMs?: number } = {}) => new CallerDeskProvider({ apiKey: API_KEY, fetchImpl: impl, ...extra });

async function expectFailure(promise: Promise<unknown>, kind: "NOT_DISPATCHED" | "UNCERTAIN", code: string): Promise<ProviderInitiationError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ProviderInitiationError, `expected ProviderInitiationError, got ${String(caught)}`);
  assert.equal(caught.kind, kind);
  assert.equal(caught.code, code);
  assert.ok(!caught.message.includes(API_KEY), "the auth code must never appear in an error message");
  return caught;
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  mock.method(console, "log", capture);
  mock.method(console, "warn", capture);
  mock.method(console, "error", capture);
});
afterEach(() => mock.restoreAll());

describe("CallerDesk click-to-call request (verified contract)", () => {
  it("sends exactly the documented GET request", async () => {
    const { impl, calls } = fakeFetch(() => new Response(SUCCESS_BODY, { status: 200 }));

    await provider(impl).initiateOutboundCall(INPUT);

    assert.equal(calls.length, 1);
    const { url, init } = calls[0]!;
    assert.equal(init?.method, "GET");
    assert.equal(`${url.origin}${url.pathname}`, "https://app.callerdesk.io/api/click_to_call_v2");
    assert.equal(CALLERDESK_CLICK_TO_CALL_URL, "https://app.callerdesk.io/api/click_to_call_v2");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      calling_party_a: "9123456789", // agent - rung first
      calling_party_b: "9876543210", // customer - rung when A answers
      deskphone: "01204567890", // business number, verbatim
      call_from_did: "1", // documented as mandatory, always 1
      authcode: API_KEY, // authentication is a query parameter
    });
    assert.equal(init?.body, undefined, "no body");
    assert.equal(init?.headers, undefined, "no headers - none are documented and none carry credentials");
  });

  it("never follows redirects (which could forward the auth code to another host)", async () => {
    const { impl, calls } = fakeFetch(() => new Response(SUCCESS_BODY, { status: 200 }));
    await provider(impl).initiateOutboundCall(INPUT);
    assert.equal(calls[0]!.init?.redirect, "error");
  });

  it("does not supply a campaign id - CallerDesk returns it", async () => {
    const { impl, calls } = fakeFetch(() => new Response(SUCCESS_BODY, { status: 200 }));
    await provider(impl).initiateOutboundCall(INPUT);
    assert.ok(!calls[0]!.url.searchParams.has("campid"));
    assert.ok(!calls[0]!.url.searchParams.has("call_start_time"), "the optional scheduling parameter is not used");
  });
});

describe("CallerDesk click-to-call responses", () => {
  it("documented success: accepted, campid becomes the provider call id, status INITIATED", async () => {
    const { impl } = fakeFetch(() => new Response(SUCCESS_BODY, { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await provider(impl).initiateOutboundCall(INPUT);

    assert.deepEqual(result, { provider: "CALLERDESK", providerCallId: "3494009", campaignId: "3494009", status: CallStatus.INITIATED });
  });

  it("parses the body even though CallerDesk labels it text/html", async () => {
    const { impl } = fakeFetch(() => new Response(SUCCESS_BODY, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } }));
    assert.equal((await provider(impl).initiateOutboundCall(INPUT)).providerCallId, "3494009");
  });

  it("accepts a string campid, and a success with no usable campid (call placed, nothing to correlate)", async () => {
    const asString = fakeFetch(() => new Response('{"type":"success","campid":"3494009"}', { status: 200 }));
    assert.equal((await provider(asString.impl).initiateOutboundCall(INPUT)).providerCallId, "3494009");

    for (const body of ['{"type":"success"}', '{"type":"success","campid":"abc"}', '{"type":"success","campid":-1}', '{"type":"success","campid":null}']) {
      const { impl } = fakeFetch(() => new Response(body, { status: 200 }));
      const result = await provider(impl).initiateOutboundCall(INPUT);
      assert.equal(result.providerCallId, null, body);
      assert.equal(result.status, CallStatus.INITIATED, "still accepted - the provider said success");
    }
  });

  it("OBSERVED error (HTTP 200 + type:error) is a definitive rejection -> NOT_DISPATCHED", async () => {
    const { impl } = fakeFetch(() => new Response(OBSERVED_AUTH_ERROR, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" } }));
    await expectFailure(provider(impl).initiateOutboundCall(INPUT), "NOT_DISPATCHED", "PROVIDER_REJECTED");
  });

  it("the provider's error text never leaks into the thrown error", async () => {
    const { impl } = fakeFetch(() => new Response('{"type":"error","message":"Insufficient balance for account 12345"}', { status: 200 }));
    const err = await expectFailure(provider(impl).initiateOutboundCall(INPUT), "NOT_DISPATCHED", "PROVIDER_REJECTED");
    assert.ok(!err.message.includes("12345"));
  });

  it("anything else is UNCERTAIN, because a call may already be ringing", async () => {
    const cases: { name: string; response: () => Response; code: string }[] = [
      { name: "HTTP 500", response: () => new Response("oops", { status: 500 }), code: "HTTP_500" },
      { name: "HTTP 502 html", response: () => new Response("<html>bad gateway</html>", { status: 502 }), code: "HTTP_502" },
      { name: "HTTP 429", response: () => new Response("slow down", { status: 429 }), code: "HTTP_429" },
      { name: "HTTP 404", response: () => new Response("nope", { status: 404 }), code: "HTTP_404" },
      { name: "200 html", response: () => new Response("<html>hello</html>", { status: 200 }), code: "UNPARSEABLE_RESPONSE" },
      { name: "200 empty", response: () => new Response("", { status: 200 }), code: "UNPARSEABLE_RESPONSE" },
      { name: "200 array", response: () => new Response("[1,2]", { status: 200 }), code: "UNRECOGNISED_RESPONSE" },
      { name: "200 unknown type", response: () => new Response('{"type":"pending"}', { status: 200 }), code: "UNRECOGNISED_RESPONSE" },
      { name: "200 no type", response: () => new Response('{"campid":1}', { status: 200 }), code: "UNRECOGNISED_RESPONSE" },
    ];
    for (const c of cases) {
      const { impl } = fakeFetch(c.response);
      await expectFailure(provider(impl).initiateOutboundCall(INPUT), "UNCERTAIN", c.code);
    }
  });

  it("classifies pure responses consistently", () => {
    assert.deepEqual(classifyClickToCallResponse(200, SUCCESS_BODY), { kind: "ACCEPTED", campid: "3494009" });
    assert.deepEqual(classifyClickToCallResponse(200, OBSERVED_AUTH_ERROR), { kind: "REJECTED" });
    assert.deepEqual(classifyClickToCallResponse(200, ` \n${SUCCESS_BODY}\n `), { kind: "ACCEPTED", campid: "3494009" });
    assert.deepEqual(classifyClickToCallResponse(200, '{"type":"SUCCESS","campid":7}'), { kind: "ACCEPTED", campid: "7" });
    assert.equal(classifyClickToCallResponse(201, SUCCESS_BODY).kind, "UNCERTAIN", "only 200 is documented");
  });
});

describe("CallerDesk click-to-call transport failures", () => {
  const rejectWith = (code: string, viaCause = true) =>
    fakeFetch(() => {
      const err = new TypeError("fetch failed");
      if (viaCause) (err as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
      else Object.assign(err, { code });
      throw err;
    });

  it("failures where no connection was made are NOT_DISPATCHED", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
      await expectFailure(provider(rejectWith(code).impl).initiateOutboundCall(INPUT), "NOT_DISPATCHED", "CONNECTION_FAILED");
    }
    await expectFailure(provider(rejectWith("ENOTFOUND", false).impl).initiateOutboundCall(INPUT), "NOT_DISPATCHED", "CONNECTION_FAILED");
  });

  it("failures after the request may have been sent are UNCERTAIN", async () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT"]) {
      await expectFailure(provider(rejectWith(code).impl).initiateOutboundCall(INPUT), "UNCERTAIN", "REQUEST_FAILED");
    }
    const bare = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expectFailure(provider(bare.impl).initiateOutboundCall(INPUT), "UNCERTAIN", "REQUEST_FAILED");
  });

  it("a redirect (request refused by redirect:error) is UNCERTAIN, never followed", async () => {
    const redirect = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    });
    await expectFailure(provider(redirect.impl).initiateOutboundCall(INPUT), "UNCERTAIN", "REQUEST_FAILED");
  });

  it("our own timeout after sending is UNCERTAIN", async () => {
    const hanging = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await expectFailure(provider(hanging.impl, { timeoutMs: 20 }).initiateOutboundCall(INPUT), "UNCERTAIN", "TIMEOUT");
  });

  it("a stalled response body is also UNCERTAIN, not a hang", async () => {
    const stalled = fakeFetch(({ init }) => {
      const body = new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200 });
    });
    await expectFailure(provider(stalled.impl, { timeoutMs: 20 }).initiateOutboundCall(INPUT), "UNCERTAIN", "TIMEOUT");
  });
});

describe("CallerDesk click-to-call guards (no network is ever used)", () => {
  it("without an API key: NOT_DISPATCHED / NOT_CONFIGURED, no request", async () => {
    const { impl, calls } = fakeFetch(() => new Response(SUCCESS_BODY));
    await expectFailure(new CallerDeskProvider({ apiKey: undefined, fetchImpl: impl }).initiateOutboundCall(INPUT), "NOT_DISPATCHED", "NOT_CONFIGURED");
    assert.equal(calls.length, 0);
  });

  it("rejects malformed numbers before any request is made", async () => {
    const bad: Partial<InitiateOutboundCallInput>[] = [
      { agentNumber: "919123456789" }, // country code not accepted by the documented contract
      { agentNumber: "12345" },
      { agentNumber: "9123456789&authcode=x" },
      { customerNumber: "+919876543210" },
      { customerNumber: "" },
      { businessNumber: null },
      { businessNumber: "0120 4567 890" },
      { businessNumber: "1234567" },
      { businessNumber: "01204567890&call_from_did=0" },
    ];
    for (const override of bad) {
      const { impl, calls } = fakeFetch(() => new Response(SUCCESS_BODY));
      await expectFailure(provider(impl).initiateOutboundCall({ ...INPUT, ...override }), "NOT_DISPATCHED", "INVALID_INPUT");
      assert.equal(calls.length, 0, JSON.stringify(override));
    }
  });

  it("never logs or throws the auth code, and reports itself configured only with a key", async () => {
    assert.equal(new CallerDeskProvider({ apiKey: API_KEY }).isConfigured(), true);
    assert.equal(new CallerDeskProvider({ apiKey: undefined }).isConfigured(), false);

    const { impl } = fakeFetch(() => new Response(OBSERVED_AUTH_ERROR, { status: 200 }));
    await expectFailure(provider(impl).initiateOutboundCall(INPUT), "NOT_DISPATCHED", "PROVIDER_REJECTED");
    assert.ok(!logs.join("\n").includes(API_KEY));
  });
});
