// Run with: npx tsx --test src/modules/agency/agency.test.ts
// The external AI calling agency's payment-link API, over real HTTP against the real router and service. No database, WhatsApp or Meta: an in-memory repository (with the same unique
// (key, idempotency key) rule as the table) and a fake messaging service that can succeed, be refused by Meta, be unreachable or be unconfigured.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { ApiError } from "@/utils/apiError.js";
import { extractApiKey, generateApiKey, hashApiKey } from "./agency.keys.js";
import { SlidingWindowLimiter } from "./agency.ratelimit.js";
import { agencyJsonErrorHandler, createAgencyRouter } from "./agency.routes.js";
import { classifySendError, type AgencyKeyRow, type AgencyMessaging, type AgencyRepo, type StoredRequest } from "./agency.payment-link.service.js";
import { hostAllowed, maskMobile, validateMobile, validatePaymentLink, validateRequest } from "./agency.validators.js";

const LINK = "https://payments.cashfree.com/links/abc123";
const MOBILE = "+919876543210";
const goodBody = (over: Record<string, unknown> = {}) => ({ customerName: "Rahul Sharma", mobile: MOBILE, paymentLink: LINK, orderId: "CRM-TEST-0001", customerConsent: true, ...over });

type LogRow = { id: string; apiKeyId: string; idempotencyKey: string; requestHash: string; status: string; httpStatus: number | null; response: unknown; errorCode: string | null; leadId: string | null; providerMessageId: string | null; templateName: string | null; toMasked: string; createdAt: Date };

function memoryRepo(world: { keys: Map<string, AgencyKeyRow>; optedOut?: Set<string>; orders?: Record<string, { id: string; leadId: string; leadMobile: string | null }> }) {
  const rows: LogRow[] = [];
  const leads = new Map<string, string>(); // mobile -> lead id
  const consent = new Map<string, string>();
  const created: { customerName: string; mobile: string }[] = [];
  const repo: AgencyRepo = {
    findKeyByHash: async (hash) => world.keys.get(hash) ?? null,
    touchKey: async () => undefined,
    claim: async (r) => {
      const existing = rows.find((x) => x.apiKeyId === r.apiKeyId && x.idempotencyKey === r.idempotencyKey);
      if (existing) return { created: false, existing: toStored(existing) };
      rows.push({ id: r.id, apiKeyId: r.apiKeyId, idempotencyKey: r.idempotencyKey, requestHash: r.requestHash, status: "RECEIVED", httpStatus: null, response: null, errorCode: null, leadId: null, providerMessageId: null, templateName: null, toMasked: r.toMasked, createdAt: new Date() });
      return { created: true, existing: null };
    },
    reclaimFailed: async (id) => {
      const row = rows.find((x) => x.id === id);
      if (!row || row.status !== "FAILED") return false;
      row.status = "RECEIVED";
      return true;
    },
    findRecentSameRequest: async (apiKeyId, hash, since) => {
      const row = [...rows].reverse().find((x) => x.apiKeyId === apiKeyId && x.requestHash === hash && (x.status === "SENT" || x.status === "RECEIVED") && x.createdAt >= since);
      return row ? toStored(row) : null;
    },
    complete: async (id, patch) => {
      const row = rows.find((x) => x.id === id)!;
      Object.assign(row, { status: patch.status, httpStatus: patch.httpStatus, response: patch.response, errorCode: patch.errorCode ?? null, leadId: patch.leadId ?? row.leadId, providerMessageId: patch.providerMessageId ?? null, templateName: patch.templateName ?? null });
    },
    logRejected: async (r) => {
      rows.push({ id: r.id, apiKeyId: r.apiKeyId, idempotencyKey: `rejected:${r.id}`, requestHash: "", status: "REJECTED", httpStatus: r.httpStatus, response: r.response, errorCode: r.errorCode, leadId: null, providerMessageId: null, templateName: null, toMasked: "-", createdAt: new Date() });
    },
    findLeadByMobile: async (mobile) => (leads.has(mobile) ? { id: leads.get(mobile)!, normalizedMobile: mobile } : null),
    createLead: async (input) => {
      created.push(input);
      const id = `lead-${leads.size + 1}`;
      leads.set(input.mobile, id);
      return { id };
    },
    findOrder: async (ref) => world.orders?.[ref] ?? null,
    recordConsent: async (leadId) => {
      if (world.optedOut?.has(leadId)) return "OPTED_OUT";
      consent.set(leadId, "OPTED_IN");
      return "OPTED_IN";
    },
    countSentToLead: async (leadId) => rows.filter((x) => x.leadId === leadId && x.status === "SENT").length,
    approvedPaymentLinkTemplates: async () => [{ id: "tpl-1", name: "payment_link_v1" }],
  };
  return { repo, rows, leads, consent, created };
}
const toStored = (r: LogRow): StoredRequest => ({ id: r.id, status: r.status, requestHash: r.requestHash, httpStatus: r.httpStatus, response: r.response, createdAt: r.createdAt });

type Mode = "ok" | "meta-400" | "meta-500" | "unreachable" | "not-configured" | "recipient";
function fakeMessaging(opts: { variables?: string[]; guardKeepsFirst?: boolean } = {}) {
  const state = { mode: "ok" as Mode, sent: [] as { leadId: string; orderId?: string; manualValues: Record<string, string> }[], counter: 0, lastBodyByLead: new Map<string, string>(), variables: opts.variables ?? ["customer_name", "payment_link"] };
  const crmKnown = (orderId?: string) => (orderId ? ["order_number"] : []);
  const messaging: AgencyMessaging = {
    describeAgencySend: async (input) => {
      const fields = state.variables.map((name) => ({ name, value: input.manualValues?.[name] ?? (crmKnown(input.orderId).includes(name) ? "CRM-TEST-0001" : null) }));
      const missing = fields.filter((f) => f.value === null);
      return { errors: missing.map((f) => `${f.name} missing`), fields, templateName: "payment_link_v1" };
    },
    sendTemplateAsAgency: async (input) => {
      if (state.mode === "not-configured") throw new ApiError("Meta WhatsApp Cloud API is not configured", 503);
      state.sent.push({ leadId: input.leadId, orderId: input.orderId, manualValues: input.manualValues ?? {} });
      const body = `Hi ${input.manualValues?.customer_name}, pay here: ${input.manualValues?.payment_link}`;
      if (state.mode !== "ok") {
        const errorMessage = { "meta-400": "Meta Cloud API rejected the template message (HTTP 400): (#132001) Template name does not exist in the translation", "meta-500": "Meta Cloud API rejected the template message (HTTP 500): internal error", unreachable: "Could not reach Meta Cloud API for template message: fetch failed", recipient: "Meta Cloud API rejected the template message (HTTP 400): (#131026) Message undeliverable" }[state.mode as "meta-400"]!;
        return { id: `msg-${++state.counter}`, status: "FAILED", providerMessageId: null, templateName: "payment_link_v1", body, errorMessage };
      }
      const earlier = state.lastBodyByLead.get(input.leadId);
      if (opts.guardKeepsFirst && earlier) return { id: "msg-first", status: "SENT", providerMessageId: "wamid.FIRST", templateName: "payment_link_v1", body: earlier, errorMessage: null };
      state.lastBodyByLead.set(input.leadId, body);
      return { id: `msg-${++state.counter}`, status: "SENT", providerMessageId: `wamid.${state.counter}`, templateName: "payment_link_v1", body, errorMessage: null };
    },
  };
  return { messaging, state };
}

interface Harness {
  url: string;
  key: string;
  state: ReturnType<typeof fakeMessaging>["state"];
  mem: ReturnType<typeof memoryRepo>;
  post(body: unknown, headers?: Record<string, string>, raw?: string): Promise<{ status: number; json: any; headers: Headers; text: string }>;
  close(): Promise<void>;
}

async function start(opts: { rate?: number; messaging?: Parameters<typeof fakeMessaging>[0]; optedOut?: string[]; orders?: Record<string, { id: string; leadId: string; leadMobile: string | null }>; env?: Record<string, string> } = {}): Promise<Harness> {
  const { key, hash } = generateApiKey();
  const keyRow: AgencyKeyRow = { id: "key-1", name: "Test Agency", isActive: true, revokedAt: null, rateLimitPerMinute: opts.rate ?? 100 };
  const mem = memoryRepo({ keys: new Map([[hash, keyRow]]), optedOut: new Set(opts.optedOut), orders: opts.orders });
  const { messaging, state } = fakeMessaging(opts.messaging);
  const app = express();
  app.use("/api/agency", express.json({ limit: "32kb" }), createAgencyRouter({ repo: mem.repo, messaging, env: opts.env ?? {} }), agencyJsonErrorHandler);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/agency/whatsapp/payment-link`;
  return {
    url, key, state, mem,
    post: async (body, headers = {}, raw) => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, ...headers }, body: raw ?? JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers, text };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("a valid request is sent through the existing WhatsApp messaging service", () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(() => h.close());

  it("returns success, a request id and the WhatsApp message id; sends one template with the customer's name and the link", async () => {
    const r = await h.post(goodBody(), { "idempotency-key": "call-1001-attempt-1" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.success, true);
    assert.match(r.json.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(r.headers.get("x-request-id"), r.json.requestId);
    assert.equal(r.json.status, "SENT");
    assert.equal(r.json.duplicate, false);
    assert.equal(r.json.message.whatsappMessageId, "wamid.1");
    assert.equal(r.json.message.template, "payment_link_v1");
    assert.equal(r.json.message.to, maskMobile(MOBILE), "the number is masked in the answer");
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.state.sent[0]!.manualValues.customer_name, "Rahul Sharma");
    assert.equal(h.state.sent[0]!.manualValues.payment_link, LINK);
    assert.equal(h.mem.consent.get("lead-1"), "OPTED_IN", "the customer's consent on the call is recorded");
    assert.equal(h.mem.created.length, 1, "an unknown number becomes a customer record");
    const log = h.mem.rows[0]!;
    assert.equal(log.status, "SENT");
    assert.equal(log.providerMessageId, "wamid.1");
    assert.equal(log.httpStatus, 200);
  });

  it("also accepts the key as a Bearer token, and never echoes the key back", async () => {
    const r = await h.post(goodBody({ mobile: "+91 98765 43211", paymentLink: `${LINK}?x=1` }), { "x-api-key": "", authorization: `Bearer ${h.key}` });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(h.key));
  });
});

describe("unauthorized requests are refused and send nothing", () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(() => h.close());

  it("no key, a wrong key, a malformed key and a revoked key all get 401", async () => {
    const attempts: Record<string, string>[] = [{ "x-api-key": "" }, { "x-api-key": "avk_not-a-real-key-at-all-1234567" }, { "x-api-key": "short" }, { "x-api-key": "", authorization: "Basic abc" }];
    for (const headers of attempts) {
      const r = await h.post(goodBody(), headers);
      assert.equal(r.status, 401, JSON.stringify(headers));
      assert.equal(r.json.success, false);
      assert.equal(r.json.error.code, "UNAUTHORIZED");
    }
    assert.equal(h.state.sent.length, 0);
    assert.equal(h.mem.rows.length, 0, "an unauthenticated call writes nothing");
  });

  it("repeated bad keys from one address are throttled", async () => {
    let last = 0;
    for (let i = 0; i < 25; i += 1) last = (await h.post(goodBody(), { "x-api-key": `avk_wrong_${i}_aaaaaaaaaaaaaaaaaaaa` })).status;
    assert.equal(last, 429);
  });

  it("a revoked or inactive key is refused", async () => {
    const inactive = generateApiKey();
    const mem = memoryRepo({ keys: new Map([[inactive.hash, { id: "k2", name: "Old", isActive: false, revokedAt: new Date(), rateLimitPerMinute: 10 }]]) });
    const app = express();
    app.use("/api/agency", express.json(), createAgencyRouter({ repo: mem.repo, messaging: fakeMessaging().messaging, env: {} }));
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/agency/whatsapp/payment-link`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": inactive.key }, body: JSON.stringify(goodBody()) });
    assert.equal(res.status, 401);
    await new Promise((r) => server.close(() => r(null)));
  });
});

describe("validation: numbers, links, consent and parameters", () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(() => h.close());

  const field = (r: { json: any }, name: string) => (r.json.error.details as { field: string; message: string }[]).find((d) => d.field === name);

  it("invalid mobile numbers are rejected with the reason, nothing is sent, and the attempt is logged", async () => {
    const cases: [string, unknown][] = [["no country code", "9876543210"], ["too short", "+91123"], ["letters", "+91abcdefghij"], ["bad Indian number", "+915876543210"], ["too long", "+9198765432101234567"], ["empty", ""], ["a number", 919876543210], ["missing", undefined]];
    for (const [label, mobile] of cases) {
      const r = await h.post(goodBody({ mobile }));
      assert.equal(r.status, 400, label);
      assert.equal(r.json.error.code, "VALIDATION_FAILED", label);
      assert.ok(field(r, "mobile"), label);
    }
    assert.equal(h.state.sent.length, 0);
    assert.ok(h.mem.rows.every((x) => x.status === "REJECTED") && h.mem.rows.length === cases.length, "every rejected request is logged");
    assert.equal(validateMobile("+44 7911 123456").mobile, "+447911123456", "other countries are fine");
  });

  it("invalid payment links are rejected: not https, not a URL, an unapproved or local or IP host, credentials, scripts, spaces", async () => {
    const bad = ["http://payments.cashfree.com/x", "not a url", "payments.cashfree.com/links/abc", "https://evil.example.com/pay", "https://cashfree.com.evil.com/pay", "https://127.0.0.1/pay", "https://localhost/pay", "https://user:pw@payments.cashfree.com/x", "javascript:alert(1)", "https://payments.cashfree.com/a b", `https://payments.cashfree.com/${"a".repeat(2100)}`, "", 42];
    for (const paymentLink of bad) {
      const r = await h.post(goodBody({ paymentLink }));
      assert.equal(r.status, 400, String(paymentLink));
      assert.ok(field(r, "paymentLink"), String(paymentLink));
    }
    assert.equal(h.state.sent.length, 0);
    assert.equal(validatePaymentLink("https://pay.example.org/p/1", ["*"]).host, "pay.example.org", "'*' approves any https host");
    assert.equal(hostAllowed("a.b.cashfree.com", ["*.cashfree.com"]), true);
    assert.equal(hostAllowed("cashfree.com", ["*.cashfree.com"]), false);
  });

  it("reports every problem at once; customerConsent must be true; reserved or unsafe template parameters are refused", async () => {
    const r = await h.post({ mobile: "123", paymentLink: "x", customerConsent: false, templateParams: { payment_link: "https://evil.example", Bad_Name: "x", note: "line1\nline2", amount: "" } });
    assert.equal(r.status, 400);
    for (const f of ["customerName", "mobile", "paymentLink", "customerConsent", "templateParams.payment_link", "templateParams.Bad_Name", "templateParams.note", "templateParams.amount"]) assert.ok(field(r, f), f);
  });

  it("malformed JSON gets a clean error in the same shape", async () => {
    const r = await h.post(undefined, {}, "{not json");
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "INVALID_JSON");
    assert.equal(r.json.success, false);
  });

  it("pure validation: names are trimmed, '#' removed from the order id", () => {
    const v = validateRequest(goodBody({ customerName: "  Rahul   Sharma ", orderId: "#AWL110598" }));
    assert.equal(v.value?.customerName, "Rahul Sharma");
    assert.equal(v.value?.orderId, "AWL110598");
  });
});

describe("Meta / WhatsApp failures are reported clearly and logged", () => {
  it("a Meta refusal (template problem) is a 502 with a code and the reason; the log row is FAILED; nothing secret leaks", async () => {
    const h = await start();
    h.state.mode = "meta-400";
    const r = await h.post(goodBody());
    assert.equal(r.status, 502);
    assert.equal(r.json.success, false);
    assert.equal(r.json.error.code, "TEMPLATE_REJECTED");
    assert.equal(r.json.error.retryable, false);
    assert.match(r.json.error.message, /132001/);
    assert.ok(!/token|secret|authorization|bearer/i.test(r.text));
    assert.equal(h.mem.rows[0]!.status, "FAILED");
    assert.equal(h.mem.rows[0]!.errorCode, "TEMPLATE_REJECTED");
    await h.close();
  });

  it("Meta down or unreachable is retryable; an undeliverable recipient is a 422; not configured is a 503", async () => {
    const h = await start();
    for (const [mode, status, code, retryable] of [["meta-500", 502, "WHATSAPP_UNAVAILABLE", true], ["unreachable", 502, "WHATSAPP_UNREACHABLE", true], ["recipient", 422, "RECIPIENT_NOT_REACHABLE", false], ["not-configured", 503, "WHATSAPP_NOT_CONFIGURED", true]] as const) {
      h.state.mode = mode;
      const r = await h.post(goodBody({ paymentLink: `${LINK}?m=${mode}` }));
      assert.equal(r.status, status, mode);
      assert.equal(r.json.error.code, code, mode);
      assert.equal(r.json.error.retryable, retryable, mode);
    }
    await h.close();
  });

  it("after a failure the same Idempotency-Key can be retried and then succeeds exactly once", async () => {
    const h = await start();
    h.state.mode = "unreachable";
    const first = await h.post(goodBody(), { "idempotency-key": "retry-me-0001" });
    assert.equal(first.status, 502);
    h.state.mode = "ok";
    const second = await h.post(goodBody(), { "idempotency-key": "retry-me-0001" });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.json.duplicate, false);
    assert.equal(second.json.requestId, first.json.requestId, "the same request, retried");
    const third = await h.post(goodBody(), { "idempotency-key": "retry-me-0001" });
    assert.equal(third.json.duplicate, true);
    assert.equal(h.state.sent.filter((s) => s.manualValues.payment_link === LINK).length, 2, "one failed attempt + one success, nothing more");
    assert.equal(h.mem.rows.length, 1);
    await h.close();
  });

  it("classifySendError turns the provider's words into stable codes", () => {
    assert.equal(classifySendError("Could not reach Meta Cloud API: fetch failed").code, "WHATSAPP_UNREACHABLE");
    assert.equal(classifySendError("rejected (HTTP 429): too many").code, "WHATSAPP_RATE_LIMITED");
    assert.equal(classifySendError("rejected (HTTP 503)").code, "WHATSAPP_UNAVAILABLE");
    assert.equal(classifySendError("rejected (HTTP 401): Invalid OAuth access token").code, "WHATSAPP_AUTH_ERROR");
    assert.equal(classifySendError("rejected (HTTP 400): (#131026) Message undeliverable").code, "RECIPIENT_NOT_REACHABLE");
    assert.equal(classifySendError("rejected (HTTP 400): something else").code, "WHATSAPP_REJECTED");
  });
});

describe("duplicate requests, concurrency and limits", () => {
  it("the same Idempotency-Key sends once and returns the first answer; with a different request it is refused", async () => {
    const h = await start();
    const a = await h.post(goodBody(), { "idempotency-key": "same-call-0001" });
    const b = await h.post(goodBody(), { "idempotency-key": "same-call-0001" });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.equal(b.json.requestId, a.json.requestId);
    assert.equal(b.json.message.whatsappMessageId, a.json.message.whatsappMessageId);
    assert.equal(h.state.sent.length, 1);
    const other = await h.post(goodBody({ paymentLink: `${LINK}-different` }), { "idempotency-key": "same-call-0001" });
    assert.equal(other.status, 409);
    assert.equal(other.json.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(h.state.sent.length, 1);
    await h.close();
  });

  it("without an Idempotency-Key an identical request within minutes is the same request", async () => {
    const h = await start();
    const a = await h.post(goodBody());
    const b = await h.post(goodBody());
    assert.equal(b.json.duplicate, true);
    assert.equal(b.json.requestId, a.json.requestId);
    assert.equal(h.state.sent.length, 1);
    const different = await h.post(goodBody({ paymentLink: `${LINK}-2` }));
    assert.equal(different.json.duplicate, false, "another link is a new request");
    await h.close();
  });

  it("concurrent identical requests WITHOUT a key: exactly one WhatsApp message is sent", async () => {
    const h = await start();
    const results = await Promise.all(Array.from({ length: 8 }, () => h.post(goodBody())));
    assert.equal(h.state.sent.length, 1);
    assert.equal(results.filter((r) => r.status === 200 && r.json.duplicate === false).length, 1);
    assert.equal(h.mem.rows.length, 1, "one request row");
    await h.close();
  });

  it("concurrent identical requests: exactly one WhatsApp message is sent", async () => {
    const h = await start();
    const results = await Promise.all(Array.from({ length: 8 }, () => h.post(goodBody(), { "idempotency-key": "burst-call-0001" })));
    assert.equal(h.state.sent.length, 1);
    assert.equal(results.filter((r) => r.status === 200 && r.json.duplicate === false).length, 1);
    assert.ok(results.every((r) => r.status === 200 || (r.status === 409 && r.json.error.code === "REQUEST_IN_PROGRESS")));
    await h.close();
  });

  it("per-key rate limit: the request over the limit gets 429 with Retry-After, and sends nothing", async () => {
    const h = await start({ rate: 3 });
    for (let i = 0; i < 3; i += 1) assert.equal((await h.post(goodBody({ paymentLink: `${LINK}-r${i}`, mobile: `+9198765432${10 + i}` }))).status, 200);
    const over = await h.post(goodBody({ paymentLink: `${LINK}-r9`, mobile: "+919876543299" }));
    assert.equal(over.status, 429);
    assert.equal(over.json.error.code, "RATE_LIMITED");
    assert.ok(Number(over.headers.get("retry-after")) >= 1);
    assert.equal(h.state.sent.length, 3);
    await h.close();
  });

  it("one customer cannot be flooded: the per-hour cap applies across requests", async () => {
    const h = await start({ env: { AGENCY_RECIPIENT_LIMIT_PER_HOUR: "2" } });
    assert.equal((await h.post(goodBody({ paymentLink: `${LINK}-1` }))).status, 200);
    assert.equal((await h.post(goodBody({ paymentLink: `${LINK}-2` }))).status, 200);
    const third = await h.post(goodBody({ paymentLink: `${LINK}-3` }));
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, "RECIPIENT_LIMIT");
    assert.equal(h.state.sent.length, 2);
    await h.close();
  });

  it("a different link inside the send path's 30-second guard is not reported as sent", async () => {
    const h = await start({ messaging: { guardKeepsFirst: true } });
    assert.equal((await h.post(goodBody({ paymentLink: `${LINK}-first`, orderId: undefined }))).status, 200);
    const second = await h.post(goodBody({ paymentLink: `${LINK}-second`, orderId: undefined }));
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "RECENT_MESSAGE_CONFLICT");
    assert.equal(second.json.error.retryable, true);
    await h.close();
  });

  it("SlidingWindowLimiter lets the window slide", () => {
    let t = 0;
    const l = new SlidingWindowLimiter(1000, () => t);
    assert.equal(l.take("a", 2).allowed, true);
    assert.equal(l.take("a", 2).allowed, true);
    assert.equal(l.take("a", 2).allowed, false);
    assert.equal(l.take("b", 2).allowed, true, "keys are independent");
    t = 1001;
    assert.equal(l.take("a", 2).allowed, true);
  });
});

describe("consent, orders and template parameters", () => {
  it("a customer who opted out is never messaged", async () => {
    const h = await start({ optedOut: ["lead-1"] });
    await h.mem.repo.createLead({ customerName: "Rahul", mobile: MOBILE }); // lead-1 exists and has opted out
    const r = await h.post(goodBody());
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, "CUSTOMER_OPTED_OUT");
    assert.equal(h.state.sent.length, 0);
    await h.close();
  });

  it("an order that belongs to another number is refused; a known order is linked; an unknown reference is just carried along", async () => {
    const h = await start({ orders: { "CRM-OTHER-1": { id: "ord-9", leadId: "lead-77", leadMobile: "+919000000001" }, "CRM-MINE-1": { id: "ord-1", leadId: "lead-5", leadMobile: MOBILE } } });
    const wrong = await h.post(goodBody({ orderId: "CRM-OTHER-1" }));
    assert.equal(wrong.status, 422);
    assert.equal(wrong.json.error.code, "ORDER_MOBILE_MISMATCH");
    assert.equal(h.state.sent.length, 0);
    const ok = await h.post(goodBody({ orderId: "CRM-MINE-1" }));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(h.state.sent[0]!.orderId, "ord-1");
    assert.equal(h.state.sent[0]!.leadId, "lead-5");
    await h.close();
  });

  it("a template that needs more values says exactly which; the agency supplies them in templateParams", async () => {
    const h = await start({ messaging: { variables: ["customer_name", "payment_link", "amount"] } });
    const missing = await h.post(goodBody({ orderId: undefined }));
    assert.equal(missing.status, 422);
    assert.equal(missing.json.error.code, "MISSING_TEMPLATE_PARAMETERS");
    assert.deepEqual(missing.json.error.details.missing, ["amount"]);
    assert.equal(h.state.sent.length, 0);
    const ok = await h.post(goodBody({ orderId: undefined, templateParams: { amount: "449" } }), { "idempotency-key": "with-params-0001" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(h.state.sent[0]!.manualValues.amount, "449");
    await h.close();
  });
});

describe("keys", () => {
  it("a key is 'avk_' + 256 random bits; only the hash is kept; the header forms are recognised", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.match(a.key, /^avk_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.key, b.key);
    assert.equal(a.hash, hashApiKey(a.key));
    assert.equal(a.hash.length, 64);
    assert.ok(!a.hash.includes(a.key.slice(4)));
    assert.equal(extractApiKey({ "x-api-key": a.key }), a.key);
    assert.equal(extractApiKey({ authorization: `Bearer ${a.key}` }), a.key);
    assert.equal(extractApiKey({ "x-api-key": "nope" }), null);
    assert.equal(extractApiKey({}), null);
  });
});
