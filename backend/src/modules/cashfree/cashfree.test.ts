import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import { ProviderHttpError, safeMessage } from "../integrations/integrations.common.js";
import { fakeFetch, memoryStore } from "../integrations/integrations.testutil.js";
import { canTransition, linkToUpdate } from "./cashfree.apply.js";
import { CashfreeClient, parseLink } from "./cashfree.client.js";
import { CashfreeConfigError, DEFAULT_API_VERSION, loadCashfreeConfig, loadCashfreeWebhookConfig } from "./cashfree.config.js";
import { deliveryId, methodFromGroup, parseEvent } from "./cashfree.events.js";
import { computeSignature, verifyCashfreeSignature } from "./cashfree.hmac.js";
import { formatExpiry, linkIdFor, toCashfreePhone } from "./cashfree.payments.service.js";
import { handleCashfreeWebhook } from "./cashfree.webhook.handler.js";
import { eventToUpdate, processCashfreeEvent } from "./cashfree.webhook.processor.js";

const SECRET = "test-client-secret-not-real";
const ENV = { CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP_ID", CASHFREE_CLIENT_SECRET: SECRET, PUBLIC_BACKEND_URL: "https://crm.example.com/" };

describe("Cashfree config", () => {
  it("stays off unless CASHFREE_ENABLED=true", () => {
    assert.throws(() => loadCashfreeConfig({ ...ENV, CASHFREE_ENABLED: undefined }), CashfreeConfigError);
    assert.equal(loadCashfreeWebhookConfig({ ...ENV, CASHFREE_ENABLED: "false" }), null);
  });

  it("defaults to the sandbox host and the documented API version", () => {
    const config = loadCashfreeConfig(ENV);
    assert.equal(config.environment, "sandbox");
    assert.equal(config.baseUrl, "https://sandbox.cashfree.com/pg");
    assert.equal(config.apiVersion, DEFAULT_API_VERSION);
    assert.equal(config.notifyUrl, "https://crm.example.com/api/webhooks/cashfree");
  });

  it("selects the host from CASHFREE_ENV only - the legacy URL variables are ignored", () => {
    const config = loadCashfreeConfig({ ...ENV, CASHFREE_ENV: "production", CASHFREE_API_URL: "https://evil.example.com", CASHFREE_BASE_URL: "https://evil.example.com" });
    assert.equal(config.baseUrl, "https://api.cashfree.com/pg");
  });

  it("only registers a webhook URL for a public https backend", () => {
    assert.equal(loadCashfreeConfig({ ...ENV, PUBLIC_BACKEND_URL: "http://localhost:5000" }).notifyUrl, null);
    assert.equal(loadCashfreeConfig({ ...ENV, PUBLIC_BACKEND_URL: undefined }).notifyUrl, null);
  });

  it("reports problems by variable name and never echoes a value", () => {
    try {
      loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "has space", CASHFREE_CLIENT_SECRET: "", CASHFREE_ENV: "staging" });
      assert.fail("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /CASHFREE_CLIENT_ID/);
      assert.match(message, /CASHFREE_CLIENT_SECRET/);
      assert.match(message, /CASHFREE_ENV/);
      assert.ok(!message.includes("has space") && !message.includes("staging"));
    }
  });

  it("keeps the secret out of JSON, inspect and enumeration", () => {
    const config = loadCashfreeConfig(ENV);
    assert.ok(!JSON.stringify(config).includes(SECRET));
    assert.ok(!Object.keys(config).includes("clientSecret"));
    assert.equal(config.clientSecret, SECRET);
    assert.ok(!JSON.stringify(loadCashfreeWebhookConfig(ENV)).includes(SECRET));
  });
});

describe("Cashfree webhook signature", () => {
  const body = Buffer.from('{"data":{"payment":{"payment_amount":100.00}},"type":"PAYMENT_SUCCESS_WEBHOOK"}');
  const ts = "1726912345678";
  const signature = createHmac("sha256", SECRET).update(ts + body.toString("utf8")).digest("base64");

  it("is Base64(HMAC-SHA256(timestamp + rawBody, secret))", () => {
    assert.equal(computeSignature(ts, body, SECRET), signature);
    assert.ok(verifyCashfreeSignature(body, { "x-webhook-timestamp": ts, "x-webhook-signature": signature }, SECRET));
  });

  it("rejects a changed body, a wrong secret, a wrong timestamp and missing headers", () => {
    const headers = { "x-webhook-timestamp": ts, "x-webhook-signature": signature };
    assert.ok(!verifyCashfreeSignature(Buffer.from(body.toString().replace("100.00", "100")), headers, SECRET)); // re-serialised decimal
    assert.ok(!verifyCashfreeSignature(body, headers, "another-secret"));
    assert.ok(!verifyCashfreeSignature(body, { ...headers, "x-webhook-timestamp": "1" }, SECRET));
    assert.ok(!verifyCashfreeSignature(body, { "x-webhook-signature": signature }, SECRET));
    assert.ok(!verifyCashfreeSignature(body, { "x-webhook-timestamp": ts }, SECRET));
    assert.ok(!verifyCashfreeSignature(body, { "x-webhook-timestamp": ts, "x-webhook-signature": "short" }, SECRET));
  });
});

const successPayload = {
  type: "PAYMENT_SUCCESS_WEBHOOK",
  event_time: "2026-09-21T10:00:00+05:30",
  data: {
    order: { order_id: "CFPay_abc123", order_amount: 649.0, order_currency: "INR", order_tags: { crm_payment: "0f8b7c1e-1111-4222-8333-444455556666" } },
    payment: { cf_payment_id: 5551234, payment_status: "SUCCESS", payment_amount: 649.0, payment_time: "2026-09-21T10:00:00+05:30", bank_reference: "BANKREF1", payment_group: "upi", payment_message: "00::Transaction success" },
    customer_details: { customer_name: "Priya", customer_phone: "9876500000" },
  },
};

describe("Cashfree events", () => {
  it("reads a PAYMENT_SUCCESS_WEBHOOK", () => {
    const event = parseEvent(successPayload);
    assert.ok(event && event.kind === "payment");
    assert.equal(event.outcome, "SUCCESS");
    assert.equal(event.orderId, "CFPay_abc123");
    assert.equal(event.crmPaymentId, "0f8b7c1e-1111-4222-8333-444455556666");
    assert.equal(event.payment.cfPaymentId, "5551234");
    assert.equal(event.payment.amount, "649");
    assert.equal(event.payment.method, PaymentMethod.UPI);
    assert.equal(event.payment.bankReference, "BANKREF1");
  });

  it("treats a success webhook whose payment status is not SUCCESS as no success", () => {
    const event = parseEvent({ ...successPayload, data: { ...successPayload.data, payment: { ...successPayload.data.payment, payment_status: "PENDING" } } });
    assert.ok(event && event.kind === "payment");
    assert.equal(event.outcome, "OTHER");
  });

  it("reads a PAYMENT_LINK_EVENT in both the flat and the nested shape", () => {
    const flat = parseEvent({ type: "PAYMENT_LINK_EVENT", data: { link_id: "crm_x", link_status: "paid", link_amount: 100, link_amount_paid: 100, order: { order_id: "ord1" } } });
    assert.ok(flat && flat.kind === "link");
    assert.deepEqual([flat.linkId, flat.linkStatus, flat.amountPaid, flat.orderId], ["crm_x", "PAID", "100", "ord1"]);

    const bare = parseEvent({ type: "PAYMENT_LINK_EVENT", link_id: "crm_y", link_status: "EXPIRED" });
    assert.ok(bare && bare.kind === "link");
    assert.equal(bare.linkStatus, "EXPIRED");

    const nested = parseEvent({ type: "PAYMENT_LINK_EVENT", data: { link: { link_id: "crm_z", link_status: "CANCELLED", link_notes: { crm_payment: "p-1" } } } });
    assert.ok(nested && nested.kind === "link");
    assert.equal(nested.linkStatus, "CANCELLED");
    assert.equal(nested.crmPaymentId, "p-1");
  });

  it("returns null for things it does not understand, instead of guessing", () => {
    assert.equal(parseEvent({ type: "REFUND_STATUS_WEBHOOK", data: {} }), null);
    assert.equal(parseEvent({ type: "PAYMENT_LINK_EVENT", data: { link_status: "PAID" } }), null);
    assert.equal(parseEvent("nope"), null);
    assert.equal(parseEvent(null), null);
  });

  it("maps payment groups to CRM payment methods", () => {
    assert.equal(methodFromGroup("upi"), PaymentMethod.UPI);
    assert.equal(methodFromGroup("credit_card"), PaymentMethod.CARD);
    assert.equal(methodFromGroup("net_banking"), PaymentMethod.NET_BANKING);
    assert.equal(methodFromGroup("wallet"), PaymentMethod.WALLET);
    assert.equal(methodFromGroup("something_new"), PaymentMethod.OTHER);
    assert.equal(methodFromGroup(null), null);
  });

  it("uses Cashfree's idempotency header when present and a body hash otherwise", () => {
    const raw = Buffer.from("{}");
    assert.equal(deliveryId({ "x-idempotency-key": "abc" }, raw), "abc");
    assert.equal(deliveryId({ "x-idempotency-header": "def" }, raw), "def");
    assert.match(deliveryId({}, raw), /^sha256:[0-9a-f]{64}$/);
    assert.equal(deliveryId({}, raw), deliveryId({}, Buffer.from("{}")));
  });
});

describe("Cashfree payment rules", () => {
  it("only moves a payment forward, and never undoes SUCCESS", () => {
    assert.ok(canTransition(PaymentStatus.PENDING, PaymentStatus.SUCCESS));
    assert.ok(canTransition(PaymentStatus.PENDING, PaymentStatus.FAILED));
    assert.ok(canTransition(PaymentStatus.PROCESSING, PaymentStatus.SUCCESS));
    assert.ok(canTransition(PaymentStatus.FAILED, PaymentStatus.SUCCESS)); // paid just before the link expired
    assert.ok(!canTransition(PaymentStatus.SUCCESS, PaymentStatus.FAILED));
    assert.ok(!canTransition(PaymentStatus.SUCCESS, PaymentStatus.PENDING));
    assert.ok(!canTransition(PaymentStatus.SUCCESS, PaymentStatus.SUCCESS));
    assert.ok(!canTransition(PaymentStatus.REFUNDED, PaymentStatus.SUCCESS));
    assert.ok(!canTransition(PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.FAILED));
  });

  it("maps link statuses to payment updates", () => {
    assert.equal(linkToUpdate({ linkStatus: "PAID", linkAmountPaid: "649.00" }).status, "SUCCESS");
    assert.equal(linkToUpdate({ linkStatus: "PAID", linkAmountPaid: "649.00" }).paidAmount, "649.00");
    assert.equal(linkToUpdate({ linkStatus: "EXPIRED", linkAmountPaid: null }).status, "FAILED");
    assert.match(linkToUpdate({ linkStatus: "CANCELLED", linkAmountPaid: null }).failureReason!, /cancelled/i);
    assert.equal(linkToUpdate({ linkStatus: "PARTIALLY_PAID", linkAmountPaid: "10" }).status, "PROCESSING");
    assert.equal(linkToUpdate({ linkStatus: "ACTIVE", linkAmountPaid: null }).status, null);
  });

  it("turns a webhook into an update - a failed attempt does not close a payable link", () => {
    const success = parseEvent(successPayload)!;
    const update = eventToUpdate(success, new Date());
    assert.equal(update?.status, "SUCCESS");
    assert.equal(update?.cfPaymentId, "5551234");

    const failed = parseEvent({ ...successPayload, type: "PAYMENT_FAILED_WEBHOOK", data: { ...successPayload.data, payment: { ...successPayload.data.payment, payment_status: "FAILED", payment_message: "Bank declined" } } })!;
    const failedUpdate = eventToUpdate(failed, new Date());
    assert.equal(failedUpdate?.status, null);
    assert.ok(failedUpdate?.meta?.lastFailedAttempt);

    const dropped = parseEvent({ ...successPayload, type: "PAYMENT_USER_DROPPED_WEBHOOK" })!;
    assert.equal(eventToUpdate(dropped, new Date()), null);
  });

  it("derives a valid, stable link id and formats expiry as documented ISO 8601", () => {
    const id = linkIdFor("0f8b7c1e-1111-4222-8333-444455556666");
    assert.equal(id, "crm_0f8b7c1e1111422283334444" + "55556666");
    assert.ok(id.length <= 50 && /^[A-Za-z0-9_-]+$/.test(id));
    assert.equal(formatExpiry(new Date("2026-09-24T10:00:00.123Z")), "2026-09-24T10:00:00+00:00");
  });

  it("normalises Indian mobile numbers to the 10 digits Cashfree needs", () => {
    assert.equal(toCashfreePhone("919876500000"), "9876500000");
    assert.equal(toCashfreePhone("09876500000"), "9876500000");
    assert.equal(toCashfreePhone("9876500000"), "9876500000");
    assert.equal(toCashfreePhone("12345"), null);
    assert.equal(toCashfreePhone(null), null);
  });
});

describe("Cashfree client", () => {
  const config = loadCashfreeConfig(ENV);
  const linkBody = { cf_link_id: 991, link_id: "crm_x", link_status: "ACTIVE", link_url: "https://payments-test.cashfree.com/links/abc", link_amount: 649, link_amount_paid: 0, link_expiry_time: "2026-09-24T10:00:00+05:30" };
  const request = {
    link_id: "crm_x",
    link_amount: 649,
    link_currency: "INR",
    link_purpose: "Payment for order SHP-1",
    customer_details: { customer_phone: "9876500000" },
    link_partial_payments: false as const,
    link_expiry_time: "2026-09-24T10:00:00+00:00",
    link_notify: { send_sms: false as const, send_email: false as const },
    link_auto_reminders: false as const,
    link_notes: { crm_payment: "p" },
  };

  it("creates a link with the documented headers, path and idempotency key", async () => {
    const { impl, calls } = fakeFetch([[200, linkBody]]);
    const link = await new CashfreeClient(config, impl).createLink(request, "11111111-2222-4333-8444-555555555555");
    assert.equal(link.linkUrl, "https://payments-test.cashfree.com/links/abc");
    assert.equal(link.cfLinkId, "991");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sandbox.cashfree.com/pg/links");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["x-client-id"], "TEST_APP_ID");
    assert.equal(calls[0].headers["x-client-secret"], SECRET);
    assert.equal(calls[0].headers["x-api-version"], DEFAULT_API_VERSION);
    assert.equal(calls[0].headers["x-idempotency-key"], "11111111-2222-4333-8444-555555555555");
    assert.deepEqual(calls[0].body, request);
  });

  it("fetches and cancels by link id", async () => {
    const { impl, calls } = fakeFetch([[200, { ...linkBody, link_status: "PAID", link_amount_paid: 649 }], [200, { ...linkBody, link_status: "CANCELLED" }]]);
    const client = new CashfreeClient(config, impl);
    assert.equal((await client.getLink("crm_x")).linkStatus, "PAID");
    assert.equal((await client.cancelLink("crm_x"))?.linkStatus, "CANCELLED");
    assert.equal(calls[0].url, "https://sandbox.cashfree.com/pg/links/crm_x");
    assert.equal(calls[1].url, "https://sandbox.cashfree.com/pg/links/crm_x/cancel");
    assert.equal(calls[1].method, "POST");
  });

  it("surfaces a provider refusal without ever including credentials", async () => {
    const { impl } = fakeFetch([[409, { message: `link already exists (${"A".repeat(60)})`, code: "link_id_already_exists" }]]);
    await assert.rejects(new CashfreeClient(config, impl).createLink(request, "k"), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, 409);
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes(SECRET) && !error.message.includes("TEST_APP_ID"));
      assert.ok(!error.message.includes("A".repeat(40))); // long token-like runs are redacted
      return true;
    });
  });

  it("marks network failures, timeouts and 5xx as retryable", async () => {
    const network = fakeFetch([new Error("ECONNRESET")]);
    await assert.rejects(new CashfreeClient(config, network.impl).getLink("x"), (e: unknown) => e instanceof ProviderHttpError && e.status === null && e.retryable);
    const server = fakeFetch([[503, { message: "busy" }]]);
    await assert.rejects(new CashfreeClient(config, server.impl).getLink("x"), (e: unknown) => e instanceof ProviderHttpError && e.status === 503 && e.retryable);
  });

  it("refuses a create answer that carries no link", async () => {
    const { impl } = fakeFetch([[200, { link_id: "crm_x", link_status: "ACTIVE" }]]);
    await assert.rejects(new CashfreeClient(config, impl).createLink(request, "k"), /without a payment link/);
    assert.equal(parseLink({}), null);
  });

  it("redacts credential-like text from any message", () => {
    assert.ok(!safeMessage(`bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc12345678`).includes("eyJ"));
    assert.equal(safeMessage(undefined), "Request failed");
    assert.equal(safeMessage("x".repeat(500)).length <= 300, true);
  });
});

describe("Cashfree webhook handler", () => {
  const cfg = loadCashfreeWebhookConfig(ENV)!;
  const rawFor = (payload: unknown) => Buffer.from(JSON.stringify(payload));
  const signedHeaders = (raw: Buffer, extra: Record<string, string> = {}) => {
    const ts = "1726912345678";
    return { "x-webhook-timestamp": ts, "x-webhook-signature": computeSignature(ts, raw, SECRET), ...extra };
  };

  it("refuses everything when Cashfree is not configured", async () => {
    const { store } = memoryStore();
    const raw = rawFor(successPayload);
    const res = await handleCashfreeWebhook({ rawBody: raw, headers: signedHeaders(raw) }, { config: null, store, schedule: () => assert.fail("must not schedule") });
    assert.equal(res.status, 503);
  });

  it("rejects a bad signature before recording or scheduling anything", async () => {
    const { store, rows } = memoryStore();
    const raw = rawFor(successPayload);
    const res = await handleCashfreeWebhook({ rawBody: raw, headers: { ...signedHeaders(raw), "x-webhook-signature": "AAAA" } }, { config: cfg, store, schedule: () => assert.fail("must not schedule") });
    assert.equal(res.status, 401);
    assert.equal(rows.length, 0);
  });

  it("rejects an unreadable body even when correctly signed", async () => {
    const { store, rows } = memoryStore();
    const raw = Buffer.from("not json");
    const res = await handleCashfreeWebhook({ rawBody: raw, headers: signedHeaders(raw) }, { config: cfg, store, schedule: () => assert.fail("must not schedule") });
    assert.equal(res.status, 400);
    assert.equal(rows.length, 0);
  });

  it("records a valid delivery once, acknowledges it, and schedules processing once", async () => {
    const { store, rows } = memoryStore();
    const scheduled: string[] = [];
    const raw = rawFor(successPayload);
    const request = { rawBody: raw, headers: signedHeaders(raw, { "x-idempotency-key": "evt-1" }) };
    const first = await handleCashfreeWebhook(request, { config: cfg, store, schedule: (id) => scheduled.push(id) });
    const second = await handleCashfreeWebhook(request, { config: cfg, store, schedule: (id) => scheduled.push(id) });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(second.message, /duplicate/i);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventType, "PAYMENT_SUCCESS_WEBHOOK");
    assert.equal(scheduled.length, 1);
  });

  it("records but does not process an event type the CRM does not act on", async () => {
    const { store, rows } = memoryStore();
    const raw = rawFor({ type: "PAYMENT_CHARGES_WEBHOOK", data: {} });
    const res = await handleCashfreeWebhook({ rawBody: raw, headers: signedHeaders(raw) }, { config: cfg, store, schedule: () => assert.fail("must not schedule") });
    assert.equal(res.status, 200);
    assert.equal(rows[0].status, "IGNORED");
  });

  it("marks an event it cannot read as ignored, and retries a processing crash with backoff", async () => {
    const ignored = memoryStore();
    const raw = rawFor({ type: "PAYMENT_LINK_EVENT", data: {} });
    await handleCashfreeWebhook({ rawBody: raw, headers: signedHeaders(raw) }, { config: cfg, store: ignored.store, schedule: () => undefined });
    assert.equal(await processCashfreeEvent("evt-1", { store: ignored.store, runner: { $transaction: async () => assert.fail("no database work for an unreadable event") } }), "ignored");
    assert.equal(ignored.rows[0].status, "IGNORED");

    const crashing = memoryStore();
    const good = rawFor(successPayload);
    await handleCashfreeWebhook({ rawBody: good, headers: signedHeaders(good) }, { config: cfg, store: crashing.store, schedule: () => undefined });
    const outcome = await processCashfreeEvent("evt-1", { store: crashing.store, runner: { $transaction: async () => { throw new Error(`db down ${SECRET}${"z".repeat(50)}`); } } });
    assert.equal(outcome, "retry");
    assert.equal(crashing.rows[0].status, "FAILED");
    assert.ok(crashing.rows[0].nextAttemptAt);
    assert.ok(!crashing.rows[0].errorMessage!.includes("z".repeat(40)));
  });
});
