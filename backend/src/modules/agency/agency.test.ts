// Run with: npx tsx --test src/modules/agency/agency.test.ts
// The external AI calling agency's payment-link API (request: customerName + mobile ONLY), over real HTTP against the real router and service. No database, payment gateway, WhatsApp or Meta:
// an in-memory repository (with the same unique (key, idempotency key) rule as the table), a fake payment-link maker and a fake messaging service. No real link is created and no real message is sent.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { ApiError } from "@/utils/apiError.js";
import { extractApiKey, generateApiKey, hashApiKey } from "./agency.keys.js";
import { SlidingWindowLimiter } from "./agency.ratelimit.js";
import { agencyJsonErrorHandler, createAgencyRouter } from "./agency.routes.js";
import { classifySendError, type AgencyKeyRow, type AgencyMessaging, type AgencyRepo, type EligibleOrder, type PaymentLinkMaker, type StoredRequest } from "./agency.payment-link.service.js";
import { maskMobile, validateMobile, validateRequest } from "./agency.validators.js";

const MOBILE = "+919876543210";
const goodBody = (over: Record<string, unknown> = {}) => ({ customerName: "Rahul Sharma", mobile: MOBILE, ...over });
const order = (n: number, amount = "449.00", over: Partial<EligibleOrder> = {}): EligibleOrder => ({ id: `order-${n}`, leadId: "lead-1", orderNumber: `CRM-TEST-000${n}`, shopifyOrderNumber: `#AWL11000${n}`, amount, ...over });

type LogRow = { id: string; apiKeyId: string; idempotencyKey: string; requestHash: string; status: string; httpStatus: number | null; response: unknown; errorCode: string | null; leadId: string | null; orderId: string | null; providerMessageId: string | null; templateName: string | null; toMasked: string; createdAt: Date };

interface World { keys: Map<string, AgencyKeyRow>; known: boolean; orders: EligibleOrder[]; consent: Record<string, "OPTED_IN" | "OPTED_OUT" | "UNKNOWN">; templates: boolean }

function memoryRepo(world: World) {
  const rows: LogRow[] = [];
  const repo: AgencyRepo = {
    findKeyByHash: async (hash) => world.keys.get(hash) ?? null,
    touchKey: async () => undefined,
    claim: async (r) => {
      const existing = rows.find((x) => x.apiKeyId === r.apiKeyId && x.idempotencyKey === r.idempotencyKey);
      if (existing) return { created: false, existing: toStored(existing) };
      rows.push({ id: r.id, apiKeyId: r.apiKeyId, idempotencyKey: r.idempotencyKey, requestHash: r.requestHash, status: "RECEIVED", httpStatus: null, response: null, errorCode: null, leadId: null, orderId: null, providerMessageId: null, templateName: null, toMasked: r.toMasked, createdAt: new Date() });
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
      Object.assign(row, { status: patch.status, httpStatus: patch.httpStatus, response: patch.response, errorCode: patch.errorCode ?? null, leadId: patch.leadId ?? row.leadId, orderId: patch.orderId ?? null, providerMessageId: patch.providerMessageId ?? null, templateName: patch.templateName ?? null });
    },
    logRejected: async (r) => {
      rows.push({ id: r.id, apiKeyId: r.apiKeyId, idempotencyKey: `rejected:${r.id}`, requestHash: "", status: "REJECTED", httpStatus: r.httpStatus, response: r.response, errorCode: r.errorCode, leadId: null, orderId: null, providerMessageId: null, templateName: null, toMasked: "-", createdAt: new Date() });
    },
    findEligibleCodOrders: async () => ({ known: world.known, orders: world.orders }),
    getConsent: async (leadId) => world.consent[leadId] ?? "UNKNOWN",
    countSentToLead: async (leadId) => rows.filter((x) => x.leadId === leadId && x.status === "SENT").length,
    approvedPaymentLinkTemplates: async () => (world.templates ? [{ id: "tpl-1", name: "payment_link_v1" }] : []),
  };
  return { repo, rows };
}
const toStored = (r: LogRow): StoredRequest => ({ id: r.id, status: r.status, requestHash: r.requestHash, httpStatus: r.httpStatus, response: r.response, createdAt: r.createdAt });

type LinkMode = "ok" | "refused" | "conflict" | "gateway-down" | "no-url";
function fakeLinks() {
  const state = { mode: "ok" as LinkMode, created: [] as string[] };
  const links: PaymentLinkMaker = {
    createLink: async (orderId) => {
      state.created.push(orderId);
      if (state.mode === "refused") throw new ApiError("This order has no pending amount to collect", 400);
      if (state.mode === "conflict") throw new ApiError("An open payment link exists for a different amount. Cancel it before creating a new one.", 409);
      if (state.mode === "gateway-down") throw new Error("connect ECONNREFUSED api.cashfree.example");
      const amount = state.created.length > 0 ? "449.00" : "0.00";
      return { paymentUrl: state.mode === "no-url" ? null : `https://payments.cashfree.com/links/${orderId}`, amount, reused: false, expiresAt: new Date("2026-11-12T00:00:00Z") };
    },
  };
  return { links, state };
}

type Mode = "ok" | "meta-400" | "meta-500" | "unreachable" | "not-configured" | "recipient";
function fakeMessaging() {
  const state = { mode: "ok" as Mode, sent: [] as { leadId: string; orderId?: string; manualValues: Record<string, string> }[], counter: 0 };
  const messaging: AgencyMessaging = {
    describeAgencySend: async (input) => {
      const fields = ["customer_name", "payment_link"].map((name) => ({ name, value: input.manualValues?.[name] ?? null }));
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
      return { id: `msg-${++state.counter}`, status: "SENT", providerMessageId: `wamid.${state.counter}`, templateName: "payment_link_v1", body, errorMessage: null };
    },
  };
  return { messaging, state };
}

interface Harness {
  url: string;
  key: string;
  world: World;
  msg: ReturnType<typeof fakeMessaging>["state"];
  link: ReturnType<typeof fakeLinks>["state"];
  mem: ReturnType<typeof memoryRepo>;
  post(body: unknown, headers?: Record<string, string>, raw?: string): Promise<{ status: number; json: any; headers: Headers; text: string }>;
  close(): Promise<void>;
}

async function start(opts: { rate?: number; orders?: EligibleOrder[]; known?: boolean; consent?: World["consent"]; templates?: boolean; env?: Record<string, string> } = {}): Promise<Harness> {
  const { key, hash } = generateApiKey();
  const keyRow: AgencyKeyRow = { id: "key-1", name: "Test Agency", isActive: true, revokedAt: null, rateLimitPerMinute: opts.rate ?? 100 };
  const world: World = { keys: new Map([[hash, keyRow]]), known: opts.known ?? true, orders: opts.orders ?? [order(1)], consent: opts.consent ?? {}, templates: opts.templates ?? true };
  const mem = memoryRepo(world);
  const { messaging, state: msg } = fakeMessaging();
  const { links, state: link } = fakeLinks();
  const app = express();
  app.use("/api/agency", express.json({ limit: "32kb" }), createAgencyRouter({ repo: mem.repo, messaging, links, env: opts.env ?? {} }), agencyJsonErrorHandler);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/agency/whatsapp/payment-link`;
  return {
    url, key, world, msg, link, mem,
    post: async (body, headers = {}, raw) => {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, ...headers }, body: raw ?? JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers, text };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("exactly one eligible COD order: the CRM creates its payment link and sends it", () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(() => h.close());

  it("sends ONLY customerName and mobile; the link comes from the CRM payment service for the found order's amount; one template message is sent", async () => {
    const r = await h.post(goodBody(), { "idempotency-key": "call-1001-attempt-1" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.success, true);
    assert.match(r.json.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(r.json.status, "SENT");
    assert.equal(r.json.duplicate, false);
    assert.equal(r.json.message.whatsappMessageId, "wamid.1");
    assert.equal(r.json.message.to, maskMobile(MOBILE), "the number is masked in the answer");
    assert.deepEqual(r.json.order, { orderNumber: "CRM-TEST-0001", shopifyOrderNumber: "#AWL110001" });
    assert.equal(r.json.payment.amount, "449.00");
    assert.equal(r.json.payment.currency, "INR");
    assert.equal(JSON.stringify(r.json).includes("payments.cashfree.com"), false, "the payment URL itself is not returned to the agency");
    assert.deepEqual(h.link.created, ["order-1"], "one payment link was requested, for the found order");
    assert.equal(h.msg.sent.length, 1);
    assert.equal(h.msg.sent[0]!.manualValues.payment_link, "https://payments.cashfree.com/links/order-1");
    assert.equal(h.msg.sent[0]!.manualValues.customer_name, "Rahul Sharma");
    assert.equal(h.msg.sent[0]!.manualValues.amount, "449.00");
    assert.equal(h.msg.sent[0]!.manualValues.order_number, "#AWL110001");
    assert.equal(h.msg.sent[0]!.orderId, "order-1");
    const log = h.mem.rows[0]!;
    assert.deepEqual([log.status, log.orderId, log.leadId, log.providerMessageId], ["SENT", "order-1", "lead-1", "wamid.1"]);
  });
});

describe("the request is exactly two fields", () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(() => h.close());

  it("paymentLink, orderId, customerConsent, templateParams and any other field are refused, not silently ignored; nothing is created or sent", async () => {
    for (const extra of [{ paymentLink: "https://payments.cashfree.com/links/x" }, { orderId: "CRM-1" }, { customerConsent: true }, { templateParams: { amount: "1" } }, { anything: 1 }]) {
      const r = await h.post(goodBody(extra));
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.json.error.code, "VALIDATION_FAILED");
      assert.match(r.json.error.details[0].message, /not accepted/);
    }
    assert.equal(h.link.created.length, 0);
    assert.equal(h.msg.sent.length, 0);
  });

  it("invalid names and numbers are rejected with the reason; every problem is reported at once; the attempt is logged", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ mobile: "9876543210" }, "country code"], [{ mobile: "+91 12345" }, "valid"], [{ mobile: "+915876543210" }, "Indian mobile"], [{ mobile: "abc" }, "digits"], [{ mobile: "" }, "required"], [{ mobile: 9876543210 }, "required"],
      [{ customerName: "" }, "required"], [{ customerName: "x".repeat(101) }, "100"],
    ];
    for (const [over, text] of cases) {
      const r = await h.post(goodBody(over));
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.match(JSON.stringify(r.json.error.details), new RegExp(text), JSON.stringify(over));
    }
    const both = await h.post({ customerName: "", mobile: "nope" });
    assert.equal(both.json.error.details.length, 2);
    assert.ok(h.mem.rows.some((x) => x.status === "REJECTED"));
    assert.equal(h.link.created.length + h.msg.sent.length, 0);
  });

  it("pure validation: names are trimmed and spaces collapsed; numbers are canonical", () => {
    const v = validateRequest({ customerName: "  Rahul   Sharma ", mobile: "+91 98765-43210" });
    assert.deepEqual(v.value, { customerName: "Rahul Sharma", mobile: "+919876543210" });
    assert.equal(validateMobile("+14155552671").mobile, "+14155552671");
  });
});

describe("no eligible order, an unknown customer or several eligible orders: nothing is created or sent", () => {
  it("no eligible COD order is a clear 404 and creates no payment link", async () => {
    const h = await start({ orders: [] });
    try {
      const r = await h.post(goodBody());
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, "NO_ELIGIBLE_ORDER");
      assert.match(r.json.error.message, /no COD order/);
      assert.equal(h.link.created.length + h.msg.sent.length, 0);
      assert.equal(h.mem.rows[0]!.status, "FAILED");
    } finally { await h.close(); }
  });

  it("a mobile number the CRM does not know is a 404 CUSTOMER_NOT_FOUND (no customer record is created)", async () => {
    const h = await start({ known: false, orders: [] });
    try {
      const r = await h.post(goodBody());
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, "CUSTOMER_NOT_FOUND");
      assert.equal(h.link.created.length + h.msg.sent.length, 0);
    } finally { await h.close(); }
  });

  it("several eligible COD orders: the CRM does not guess - 409 with the candidates, no link, no message", async () => {
    const h = await start({ orders: [order(1, "449.00"), order(2, "999.00")] });
    try {
      const r = await h.post(goodBody());
      assert.equal(r.status, 409);
      assert.equal(r.json.success, false);
      assert.equal(r.json.error.code, "MULTIPLE_ELIGIBLE_ORDERS");
      assert.deepEqual(r.json.error.details.orders, [{ orderNumber: "CRM-TEST-0001", shopifyOrderNumber: "#AWL110001", amount: "449.00" }, { orderNumber: "CRM-TEST-0002", shopifyOrderNumber: "#AWL110002", amount: "999.00" }]);
      assert.equal(h.link.created.length + h.msg.sent.length, 0);
    } finally { await h.close(); }
  });
});

describe("consent is validated before anything is created or sent", () => {
  it("a customer who opted out is never messaged and no payment link is created for them", async () => {
    const h = await start({ consent: { "lead-1": "OPTED_OUT" } });
    try {
      const r = await h.post(goodBody());
      assert.equal(r.status, 422);
      assert.equal(r.json.error.code, "CUSTOMER_OPTED_OUT");
      assert.equal(h.link.created.length + h.msg.sent.length, 0);
    } finally { await h.close(); }
  });

  it("strict mode (AGENCY_REQUIRE_EXPLICIT_OPT_IN=true): only an explicit OPTED_IN is messaged; default mode messages everyone who has not opted out", async () => {
    const strict = await start({ env: { AGENCY_REQUIRE_EXPLICIT_OPT_IN: "true" }, consent: {} });
    try {
      const r = await strict.post(goodBody());
      assert.equal(r.status, 422);
      assert.equal(r.json.error.code, "CONSENT_NOT_RECORDED");
      assert.equal(strict.link.created.length, 0);
      strict.world.consent["lead-1"] = "OPTED_IN";
      assert.equal((await strict.post(goodBody(), { "idempotency-key": "after-consent-1" })).status, 200);
    } finally { await strict.close(); }
    const open = await start({ consent: { "lead-1": "UNKNOWN" } });
    try { assert.equal((await open.post(goodBody())).status, 200); } finally { await open.close(); }
  });
});

describe("payment-link generation failures: clear errors, nothing sent, retry with the same key", () => {
  it("a refusal by the payment service is a 422 ORDER_NOT_PAYABLE; an open link for another amount is a 409; the gateway being down is a retryable 502; no WhatsApp message in any case", async () => {
    const h = await start();
    try {
      h.link.mode = "refused";
      const a = await h.post(goodBody(), { "idempotency-key": "link-fail-0001" });
      assert.equal(a.status, 422);
      assert.equal(a.json.error.code, "ORDER_NOT_PAYABLE");
      h.link.mode = "conflict";
      assert.equal((await h.post(goodBody(), { "idempotency-key": "link-fail-0002" })).json.error.code, "PAYMENT_LINK_CONFLICT");
      h.link.mode = "gateway-down";
      const c = await h.post(goodBody(), { "idempotency-key": "link-fail-0003" });
      assert.equal(c.status, 502);
      assert.equal(c.json.error.code, "PAYMENT_LINK_FAILED");
      assert.equal(c.json.error.retryable, true);
      assert.doesNotMatch(c.text, /ECONNREFUSED|cashfree\.example/, "no internal detail leaks to the agency");
      h.link.mode = "no-url";
      assert.equal((await h.post(goodBody(), { "idempotency-key": "link-fail-0004" })).json.error.code, "PAYMENT_LINK_FAILED");
      assert.equal(h.msg.sent.length, 0, "no message is ever sent without a link");
      // recovery: the same key succeeds once the gateway works
      h.link.mode = "ok";
      const ok = await h.post(goodBody(), { "idempotency-key": "link-fail-0003" });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(h.msg.sent.length, 1);
    } finally { await h.close(); }
  });

  it("no approved template: the failure comes BEFORE a payment link is created, so no link is left that nobody was told about", async () => {
    const h = await start({ templates: false });
    try {
      const r = await h.post(goodBody());
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, "NO_APPROVED_TEMPLATE");
      assert.equal(h.link.created.length, 0);
    } finally { await h.close(); }
  });
});

describe("WhatsApp / Meta failures are reported clearly and logged", () => {
  it("a Meta refusal is a 502 with a code and the reason; the log row is FAILED; nothing secret leaks", async () => {
    const h = await start();
    try {
      h.msg.mode = "meta-400";
      const r = await h.post(goodBody());
      assert.equal(r.status, 502);
      assert.equal(r.json.error.code, "TEMPLATE_REJECTED");
      assert.equal(h.mem.rows[0]!.status, "FAILED");
      assert.doesNotMatch(r.text, /access[_ ]?token|app[_ ]?secret|Bearer/i);
    } finally { await h.close(); }
  });

  it("Meta down or unreachable is retryable; an undeliverable recipient is a 422; WhatsApp not configured is a 503", async () => {
    const h = await start();
    try {
      for (const [mode, status, code, retryable] of [["meta-500", 502, "WHATSAPP_UNAVAILABLE", true], ["unreachable", 502, "WHATSAPP_UNREACHABLE", true], ["recipient", 422, "RECIPIENT_NOT_REACHABLE", false], ["not-configured", 503, "WHATSAPP_NOT_CONFIGURED", true]] as const) {
        h.msg.mode = mode;
        const r = await h.post(goodBody(), { "idempotency-key": `meta-${mode}-0001` });
        assert.equal(r.status, status, mode);
        assert.equal(r.json.error.code, code, mode);
        assert.equal(r.json.error.retryable ?? false, retryable, mode);
      }
    } finally { await h.close(); }
  });

  it("after a WhatsApp failure the same Idempotency-Key succeeds exactly once, reusing the payment link request for the same order", async () => {
    const h = await start();
    try {
      h.msg.mode = "meta-500";
      const key = { "idempotency-key": "retry-after-meta-1" };
      assert.equal((await h.post(goodBody(), key)).status, 502);
      h.msg.mode = "ok";
      const second = await h.post(goodBody(), key);
      assert.equal(second.status, 200, second.text);
      const third = await h.post(goodBody(), key);
      assert.equal(third.json.duplicate, true);
      assert.equal(h.msg.sent.filter((s) => s.manualValues.payment_link).length, 2, "one failed attempt and one successful send; the repeat sent nothing");
      assert.ok(h.link.created.every((id) => id === "order-1"), "always the same order");
    } finally { await h.close(); }
  });

  it("classifySendError turns the provider's words into stable codes", () => {
    assert.equal(classifySendError("Could not reach Meta Cloud API: fetch failed").code, "WHATSAPP_UNREACHABLE");
    assert.equal(classifySendError("rejected (HTTP 429): too many").code, "WHATSAPP_RATE_LIMITED");
    assert.equal(classifySendError("(HTTP 401) Invalid OAuth access token").code, "WHATSAPP_AUTH_ERROR");
    assert.equal(classifySendError("(#131026) Message undeliverable").code, "RECIPIENT_NOT_REACHABLE");
    assert.equal(classifySendError("something odd").code, "WHATSAPP_REJECTED");
  });
});

describe("unauthorized requests are refused and create / send nothing", () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(() => h.close());

  it("no key, a wrong key, a malformed key all get 401; the Bearer form works; a revoked key is refused", async () => {
    const noKey = await fetch(h.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodBody()) });
    assert.equal(noKey.status, 401);
    assert.equal((await h.post(goodBody(), { "x-api-key": "avk_wrong" })).status, 401);
    assert.equal((await h.post(goodBody(), { "x-api-key": "not-a-key" })).status, 401);
    assert.equal(h.link.created.length + h.msg.sent.length, 0);
    const bearer = await h.post(goodBody(), { "x-api-key": "", authorization: `Bearer ${h.key}` });
    assert.equal(bearer.status, 200, bearer.text);
    const row = [...h.world.keys.values()][0]!;
    row.revokedAt = new Date();
    assert.equal((await h.post(goodBody(), { "idempotency-key": "after-revoke-01" })).status, 401);
  });

  it("malformed JSON gets a clean error in the same shape", async () => {
    const h2 = await start();
    try {
      const r = await h2.post(null, {}, "{ not json");
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, "INVALID_JSON");
    } finally { await h2.close(); }
  });
});

describe("duplicate requests, concurrency and limits (unchanged)", () => {
  it("the same Idempotency-Key sends once and returns the first answer; with a different request it is refused", async () => {
    const h = await start();
    try {
      const key = { "idempotency-key": "dup-key-00001" };
      const a = await h.post(goodBody(), key);
      const b = await h.post(goodBody(), key);
      assert.equal(a.status, 200);
      assert.equal(b.json.duplicate, true);
      assert.equal(b.json.requestId, a.json.requestId);
      assert.equal(h.msg.sent.length, 1);
      assert.equal(h.link.created.length, 1);
      const other = await h.post(goodBody({ mobile: "+919876500001" }), key);
      assert.equal(other.status, 409);
      assert.equal(other.json.error.code, "IDEMPOTENCY_KEY_REUSED");
    } finally { await h.close(); }
  });

  it("without an Idempotency-Key, concurrent identical requests send exactly one message and create one link", async () => {
    const h = await start();
    try {
      const rs = await Promise.all([1, 2, 3, 4].map(() => h.post(goodBody())));
      assert.equal(h.msg.sent.length, 1);
      assert.equal(h.link.created.length, 1);
      assert.ok(rs.some((r) => r.status === 200));
    } finally { await h.close(); }
  });

  it("per-key rate limit: the request over the limit gets 429 with Retry-After, and creates / sends nothing", async () => {
    const h = await start({ rate: 2 });
    try {
      assert.equal((await h.post(goodBody(), { "idempotency-key": "rate-limit-001" })).status, 200);
      await h.post(goodBody({ customerName: "B" }), { "idempotency-key": "rate-limit-002" });
      const limited = await h.post(goodBody({ customerName: "C" }), { "idempotency-key": "rate-limit-003" });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.error.code, "RATE_LIMITED");
      assert.ok(limited.headers.get("retry-after"));
      assert.equal(h.link.created.length, 2, "only the two allowed requests reached the payment service");
    } finally { await h.close(); }
  });

  it("SlidingWindowLimiter lets the window slide", () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(1000, () => t);
    assert.equal(limiter.take("k", 2).allowed, true);
    assert.equal(limiter.take("k", 2).allowed, true);
    assert.equal(limiter.take("k", 2).allowed, false);
    t = 1500;
    assert.equal(limiter.take("k", 2).allowed, true);
  });
});

describe("keys", () => {
  it("a key is 'avk_' + 256 random bits; only the hash is kept; the header forms are recognised", () => {
    const { key, hash, prefix } = generateApiKey();
    assert.match(key, /^avk_[A-Za-z0-9_-]{43}$/);
    assert.equal(hashApiKey(key), hash);
    assert.ok(key.startsWith(prefix));
    assert.equal(extractApiKey({ "x-api-key": key }), key);
    assert.equal(extractApiKey({ authorization: `Bearer ${key}` }), key);
  });
});
