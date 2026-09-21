import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { AiSensyProvider } from "./whatsapp.aisensy.provider.js";
import { resolveWhatsAppConfig, loadWhatsAppConfig } from "./whatsapp.config.js";
import { GupshupProvider } from "./whatsapp.gupshup.provider.js";
import { bodyDigest, computeAiSensyHmac, verifyAiSensyHmac, verifyGupshupToken } from "./whatsapp.hmac.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import { handleWhatsAppWebhook } from "./whatsapp.webhook.handler.js";
import { processWhatsAppWebhookEvent } from "./whatsapp.webhook.processor.js";
import { backoffMs, LEASE_MS, MAX_ATTEMPTS, type StoredEvent, type WebhookStore } from "./whatsapp.webhook.store.js";
import { startWebhookWorker } from "./whatsapp.webhook.worker.js";

// ---- an in-memory store, same shape as the database one (unique delivery id, atomic claim, lease) ----

interface Row {
  id: string;
  eventType: string;
  externalEventId: string;
  payload: unknown;
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED" | "IGNORED";
  attempts: number;
  nextAttemptAt: Date | null;
  errorMessage: string | null;
  receivedAt: Date;
}

function memoryStore() {
  const rows: Row[] = [];
  const store: WebhookStore = {
    async record({ eventType, externalEventId, payload, ignored }) {
      const existing = rows.find((r) => r.externalEventId === externalEventId);
      if (existing) return { id: existing.id, duplicate: true };
      const row: Row = { id: `evt-${rows.length + 1}`, eventType, externalEventId, payload, status: ignored ? "IGNORED" : "RECEIVED", attempts: 0, nextAttemptAt: null, errorMessage: null, receivedAt: new Date() };
      rows.push(row);
      return { id: row.id, duplicate: false };
    },
    async claim(id, now) {
      const row = rows.find((r) => r.id === id);
      const claimable = row && (row.status === "RECEIVED" || ((row.status === "FAILED" || row.status === "PROCESSING") && row.nextAttemptAt !== null && row.nextAttemptAt <= now));
      if (!row || !claimable) return null;
      row.status = "PROCESSING";
      row.attempts += 1;
      row.nextAttemptAt = new Date(now.getTime() + LEASE_MS);
      return { id: row.id, eventType: row.eventType, payload: row.payload, attempts: row.attempts } satisfies StoredEvent;
    },
    async complete(id, status) {
      const row = rows.find((r) => r.id === id)!;
      row.status = status;
      row.errorMessage = null;
      row.nextAttemptAt = null;
    },
    async fail(id, message, nextAttemptAt) {
      const row = rows.find((r) => r.id === id)!;
      row.status = "FAILED";
      row.errorMessage = message;
      row.nextAttemptAt = nextAttemptAt;
    },
    async due(now, limit) {
      return rows
        .filter((r) => (r.status === "RECEIVED" && r.receivedAt.getTime() <= now.getTime() - 30_000)
          || (r.status === "FAILED" && r.nextAttemptAt !== null && r.nextAttemptAt <= now && r.attempts < MAX_ATTEMPTS)
          || (r.status === "PROCESSING" && r.nextAttemptAt !== null && r.nextAttemptAt <= now))
        .slice(0, limit)
        .map((r) => r.id);
    },
  };
  return { store, rows };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ==== Config: safe behaviour when WhatsApp is not configured (Phase 3) ====

describe("WhatsApp config", () => {
  it("is not configured when WHATSAPP_PROVIDER is unset - never falls back to a fake provider", () => {
    assert.equal(loadWhatsAppConfig({}), null);
    const result = resolveWhatsAppConfig({});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.provider, null);
      assert.match(result.problems[0], /WHATSAPP_PROVIDER/);
    }
  });

  it("rejects an unsupported provider name without throwing", () => {
    const result = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "TWILIO" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems[0], /AISENSY.*GUPSHUP/);
  });

  it("reports which AiSensy variables are missing, by name only, never a bad value", () => {
    const result = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "aisensy", AISENSY_API_KEY: "  " });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.problems.some((p) => p.includes("AISENSY_API_KEY")));
      assert.ok(result.problems.some((p) => p.includes("AISENSY_SOURCE_NUMBER")));
      assert.ok(result.problems.some((p) => p.includes("AISENSY_WEBHOOK_SECRET")));
    }
  });

  it("resolves a complete AiSensy config, with secrets kept out of JSON/enumeration", () => {
    const result = resolveWhatsAppConfig({
      WHATSAPP_PROVIDER: "AISENSY",
      AISENSY_API_KEY: "secret-key",
      AISENSY_SOURCE_NUMBER: "919876500000",
      AISENSY_WEBHOOK_SECRET: "whsec",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.kind, "AISENSY");
      assert.equal(JSON.stringify(result.config).includes("secret-key"), false);
      assert.equal(JSON.stringify(result.config).includes("whsec"), false);
    }
  });

  it("resolves a complete Gupshup config the same way", () => {
    const result = resolveWhatsAppConfig({
      WHATSAPP_PROVIDER: "GUPSHUP",
      GUPSHUP_API_KEY: "gs-key",
      GUPSHUP_APP_NAME: "DemoApp",
      GUPSHUP_SOURCE_NUMBER: "919876500000",
      GUPSHUP_WEBHOOK_TOKEN: "gs-token",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.kind, "GUPSHUP");
      assert.equal(JSON.stringify(result.config).includes("gs-key"), false);
      assert.equal(JSON.stringify(result.config).includes("gs-token"), false);
    }
  });
});

// ==== Signature/token verification ====

describe("AiSensy HMAC verification", () => {
  const SECRET = "test-aisensy-secret";
  const BODY = Buffer.from(JSON.stringify({ hello: "world" }));

  it("matches an independently computed hex HMAC-SHA256 of the raw body", () => {
    assert.equal(computeAiSensyHmac(BODY, SECRET), createHmac("sha256", SECRET).update(BODY).digest("hex"));
  });

  it("accepts a correct signature and rejects a wrong secret, a tampered body, and a missing header", () => {
    const good = computeAiSensyHmac(BODY, SECRET);
    assert.equal(verifyAiSensyHmac(BODY, good, SECRET), true);
    assert.equal(verifyAiSensyHmac(BODY, good, "other-secret"), false);
    assert.equal(verifyAiSensyHmac(Buffer.from(JSON.stringify({ hello: "tampered" })), good, SECRET), false);
    assert.equal(verifyAiSensyHmac(BODY, undefined, SECRET), false);
  });
});

describe("Gupshup token verification", () => {
  it("accepts the exact configured token and rejects anything else", () => {
    assert.equal(verifyGupshupToken("secret-token", "secret-token"), true);
    assert.equal(verifyGupshupToken("wrong-token", "secret-token"), false);
    assert.equal(verifyGupshupToken(undefined, "secret-token"), false);
    assert.equal(verifyGupshupToken("", "secret-token"), false);
  });
});

describe("bodyDigest", () => {
  it("is stable for the same bytes and different for different bytes", () => {
    assert.equal(bodyDigest(Buffer.from("x")), bodyDigest(Buffer.from("x")));
    assert.notEqual(bodyDigest(Buffer.from("x")), bodyDigest(Buffer.from("y")));
  });
});

// ==== AiSensy provider ====

const aisensyConfig = () => {
  const r = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "AISENSY", AISENSY_API_KEY: "key", AISENSY_SOURCE_NUMBER: "919876500000", AISENSY_WEBHOOK_SECRET: "whsec" });
  if (!r.ok || r.config.kind !== "AISENSY") throw new Error("bad test setup");
  return r.config;
};

describe("AiSensyProvider", () => {
  it("sends a template message with the documented campaign API shape and reads the message id back", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse(200, { id: "aisensy-msg-1" });
    }) as typeof fetch;

    const provider = new AiSensyProvider(aisensyConfig(), { fetchImpl });
    const result = await provider.sendTemplateMessage({ to: "+919876543210", templateName: "order_update", params: ["Ravi", "SHP-100"], contactName: "Ravi Kumar" });

    assert.equal(result.providerMessageId, "aisensy-msg-1");
    assert.ok(captured);
    const c = captured as unknown as { url: string; init: RequestInit };
    assert.equal(c.url, "https://backend.aisensy.com/campaign/t1/api/v2");
    const body = JSON.parse(c.init.body as string);
    assert.equal(body.apiKey, "key");
    assert.equal(body.campaignName, "order_update");
    assert.equal(body.destination, "+919876543210");
    assert.equal(body.userName, "Ravi Kumar");
    assert.deepEqual(body.templateParams, ["Ravi", "SHP-100"]);
  });

  it("falls back to the phone number as userName when no contact name is known", async () => {
    let captured: any = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return jsonResponse(200, {});
    }) as typeof fetch;
    await new AiSensyProvider(aisensyConfig(), { fetchImpl }).sendTemplateMessage({ to: "+919876543210", templateName: "t", params: [] });
    assert.equal(captured.userName, "+919876543210");
  });

  it("throws WhatsAppSendError on a non-2xx response, without crashing", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: "bad template" })) as typeof fetch;
    const provider = new AiSensyProvider(aisensyConfig(), { fetchImpl });
    await assert.rejects(() => provider.sendTemplateMessage({ to: "+91", templateName: "t", params: [] }), WhatsAppSendError);
  });

  it("throws WhatsAppSendError when the network call itself fails", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const provider = new AiSensyProvider(aisensyConfig(), { fetchImpl });
    await assert.rejects(() => provider.sendTemplateMessage({ to: "+91", templateName: "t", params: [] }), WhatsAppSendError);
  });

  it("verifies its webhook with the configured secret", () => {
    const provider = new AiSensyProvider(aisensyConfig());
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const good = computeAiSensyHmac(body, "whsec");
    assert.equal(provider.verifyWebhook({ rawBody: body, headers: { "x-aisensy-signature": good } }), true);
    assert.equal(provider.verifyWebhook({ rawBody: body, headers: { "x-aisensy-signature": "wrong" } }), false);
    assert.equal(provider.verifyWebhook({ rawBody: body, headers: {} }), false);
  });

  const metaEnvelope = (value: Record<string, unknown>) => ({ entry: [{ changes: [{ value }] }] });

  it("parses an inbound text message in the Meta Cloud API envelope", () => {
    const provider = new AiSensyProvider(aisensyConfig());
    const payload = metaEnvelope({
      metadata: { display_phone_number: "919876500000" },
      messages: [{ id: "wamid.1", from: "919876543210", type: "text", text: { body: "Hi there" }, timestamp: "1700000000" }],
    });
    const messages = provider.parseIncomingWebhook(payload);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { providerMessageId: "wamid.1", from: "919876543210", to: "919876500000", messageType: "TEXT", text: "Hi there", timestamp: new Date(1700000000 * 1000) });
  });

  it("classifies a non-text message as MEDIA/INTERACTIVE/OTHER without inventing text", () => {
    const provider = new AiSensyProvider(aisensyConfig());
    const payload = metaEnvelope({ messages: [
      { id: "wamid.2", from: "91", type: "image", timestamp: "1" },
      { id: "wamid.3", from: "91", type: "interactive", timestamp: "1" },
      { id: "wamid.4", from: "91", type: "sticker", timestamp: "1" },
    ] });
    const messages = provider.parseIncomingWebhook(payload);
    assert.deepEqual(messages.map((m) => [m.messageType, m.text]), [["MEDIA", null], ["INTERACTIVE", null], ["MEDIA", null]]);
  });

  it("parses a delivery status update, mapping the documented status values", () => {
    const provider = new AiSensyProvider(aisensyConfig());
    const payload = metaEnvelope({ statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1700000000" }] });
    assert.deepEqual(provider.parseDeliveryStatusWebhook(payload), [{ providerMessageId: "wamid.1", status: "DELIVERED", timestamp: new Date(1700000000 * 1000), errorCode: undefined, errorMessage: undefined }]);
  });

  it("carries an error code/message through for a failed status", () => {
    const provider = new AiSensyProvider(aisensyConfig());
    const payload = metaEnvelope({ statuses: [{ id: "wamid.1", status: "failed", timestamp: "1", errors: [{ code: 131047, title: "Re-engagement message" }] }] });
    const [update] = provider.parseDeliveryStatusWebhook(payload);
    assert.equal(update.status, "FAILED");
    assert.equal(update.errorCode, "131047");
    assert.equal(update.errorMessage, "Re-engagement message");
  });

  it("returns [] rather than throwing for a shape it does not recognise", () => {
    const provider = new AiSensyProvider(aisensyConfig());
    assert.deepEqual(provider.parseIncomingWebhook({ unexpected: true }), []);
    assert.deepEqual(provider.parseIncomingWebhook(null), []);
    assert.deepEqual(provider.parseDeliveryStatusWebhook("not an object"), []);
  });
});

// ==== Gupshup provider ====

const gupshupConfig = () => {
  const r = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "GUPSHUP", GUPSHUP_API_KEY: "gs-key", GUPSHUP_APP_NAME: "DemoApp", GUPSHUP_SOURCE_NUMBER: "917834811114", GUPSHUP_WEBHOOK_TOKEN: "gs-token" });
  if (!r.ok || r.config.kind !== "GUPSHUP") throw new Error("bad test setup");
  return r.config;
};

describe("GupshupProvider", () => {
  it("sends a template message as form-encoded, with the documented field names", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse(202, { status: "submitted", messageId: "gs-msg-1" });
    }) as typeof fetch;

    const provider = new GupshupProvider(gupshupConfig(), { fetchImpl });
    const result = await provider.sendTemplateMessage({ to: "918x98xx21x4", templateName: "c6aecef6-tmpl", params: ["Agent", "Tracking code"] });

    assert.equal(result.providerMessageId, "gs-msg-1");
    assert.ok(captured);
    const c = captured as unknown as { url: string; init: RequestInit };
    assert.equal(c.url, "https://api.gupshup.io/wa/api/v1/template/msg");
    assert.equal((c.init.headers as Record<string, string>).apikey, "gs-key");
    const form = new URLSearchParams(c.init.body as string);
    assert.equal(form.get("channel"), "whatsapp");
    assert.equal(form.get("source"), "917834811114");
    assert.equal(form.get("destination"), "918x98xx21x4");
    assert.equal(form.get("src.name"), "DemoApp");
    assert.deepEqual(JSON.parse(form.get("template")!), { id: "c6aecef6-tmpl", params: ["Agent", "Tracking code"] });
  });

  it("throws WhatsAppSendError on a non-2xx response", async () => {
    const fetchImpl = (async () => jsonResponse(401, { message: "invalid apikey" })) as typeof fetch;
    const provider = new GupshupProvider(gupshupConfig(), { fetchImpl });
    await assert.rejects(() => provider.sendTemplateMessage({ to: "91", templateName: "t", params: [] }), WhatsAppSendError);
  });

  it("verifies its webhook with the configured Authorization token", () => {
    const provider = new GupshupProvider(gupshupConfig());
    assert.equal(provider.verifyWebhook({ rawBody: Buffer.from(""), headers: { authorization: "gs-token" } }), true);
    assert.equal(provider.verifyWebhook({ rawBody: Buffer.from(""), headers: { authorization: "wrong" } }), false);
    assert.equal(provider.verifyWebhook({ rawBody: Buffer.from(""), headers: {} }), false);
  });

  it("parses an inbound text message in Gupshup's message envelope", () => {
    const provider = new GupshupProvider(gupshupConfig());
    const payload = { app: "DemoApp", timestamp: 1700000000000, version: 2, type: "message", payload: { id: "gs-in-1", source: "919876543210", type: "text", payload: { text: "Hello" } } };
    assert.deepEqual(provider.parseIncomingWebhook(payload), [{ providerMessageId: "gs-in-1", from: "919876543210", to: null, messageType: "TEXT", text: "Hello", timestamp: new Date(1700000000000) }]);
  });

  it("parses a message-event status update using Gupshup's documented envelope", () => {
    const provider = new GupshupProvider(gupshupConfig());
    const payload = { app: "DemoApp", timestamp: 1700000000000, version: 2, type: "message-event", payload: { id: "gs-msg-1", gsId: "gs-internal-1", type: "delivered", destination: "919876543210", payload: {} } };
    assert.deepEqual(provider.parseDeliveryStatusWebhook(payload), [{ providerMessageId: "gs-msg-1", status: "DELIVERED", timestamp: new Date(1700000000000), errorCode: undefined, errorMessage: undefined }]);
  });

  it("does not surface enqueued/deleted as one of our delivery statuses", () => {
    const provider = new GupshupProvider(gupshupConfig());
    for (const type of ["enqueued", "deleted"]) {
      const payload = { type: "message-event", timestamp: 1, payload: { id: "x", type } };
      assert.deepEqual(provider.parseDeliveryStatusWebhook(payload), []);
    }
  });

  it("returns [] rather than throwing for an unrecognised shape", () => {
    const provider = new GupshupProvider(gupshupConfig());
    assert.deepEqual(provider.parseIncomingWebhook({ type: "system-event", payload: {} }), []);
    assert.deepEqual(provider.parseIncomingWebhook(undefined), []);
    assert.deepEqual(provider.parseDeliveryStatusWebhook(42), []);
  });
});

// ==== Webhook handler: authenticate, record once, acknowledge ====

describe("WhatsApp webhook handler", () => {
  const provider = new AiSensyProvider(aisensyConfig());
  const sign = (body: string) => computeAiSensyHmac(Buffer.from(body), "whsec");
  const BODY = JSON.stringify({ type: "message-event", payload: { id: "x", type: "sent" } });

  const setup = (p = provider) => {
    const { store, rows } = memoryStore();
    const scheduled: string[] = [];
    const handle = (rawBody: string, headers: Record<string, string> = { "x-aisensy-signature": sign(rawBody) }) =>
      handleWhatsAppWebhook({ rawBody: Buffer.from(rawBody), headers }, { provider: p, store, schedule: (id) => void scheduled.push(id) });
    return { handle, rows, scheduled };
  };

  it("acknowledges, records, and schedules a validly signed delivery", async () => {
    const { handle, rows, scheduled } = setup();
    const res = await handle(BODY);
    assert.deepEqual(res, { status: 200, message: "Received" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventType, "message-event");
    assert.deepEqual(scheduled, ["evt-1"]);
  });

  it("refuses an invalid signature without recording anything", async () => {
    const { handle, rows, scheduled } = setup();
    const res = await handle(BODY, { "x-aisensy-signature": "wrong" });
    assert.equal(res.status, 401);
    assert.equal(rows.length, 0);
    assert.equal(scheduled.length, 0);
  });

  it("reports 503 and records nothing when the provider is not configured", async () => {
    const { handle, rows } = setup(null as any);
    assert.equal((await handle(BODY)).status, 503);
    assert.equal(rows.length, 0);
  });

  it("rejects a body that is not JSON", async () => {
    const { handle, rows } = setup();
    const bad = "{not json";
    assert.equal((await handle(bad, { "x-aisensy-signature": sign(bad) })).status, 400);
    assert.equal(rows.length, 0);
  });

  it("does not record or schedule the same delivery twice, deduplicated by body digest", async () => {
    const { handle, rows, scheduled } = setup();
    await handle(BODY);
    const again = await handle(BODY);
    assert.deepEqual(again, { status: 200, message: "Duplicate delivery ignored" });
    assert.equal(rows.length, 1);
    assert.equal(scheduled.length, 1);
  });

  it("treats two different bodies as different deliveries", async () => {
    const { handle, rows } = setup();
    await handle(BODY);
    await handle(JSON.stringify({ type: "message-event", payload: { id: "y", type: "sent" } }));
    assert.equal(rows.length, 2);
  });
});

// ==== Webhook processor: parse-both-defensively, persist, retry ====

describe("WhatsApp webhook processing", () => {
  const NOW = new Date("2026-09-20T12:00:00Z");
  const fakeProvider = (overrides: Partial<{ messages: unknown[]; statuses: unknown[] }> = {}) => ({
    id: "AISENSY" as const,
    sendTemplateMessage: async () => ({ providerMessageId: null, raw: null }),
    verifyWebhook: () => true,
    parseIncomingWebhook: () => (overrides.messages ?? []) as any,
    parseDeliveryStatusWebhook: () => (overrides.statuses ?? []) as any,
  });
  const received = async (payload: unknown = { type: "message-event" }) => {
    const ctx = memoryStore();
    const { id: eventId } = await ctx.store.record({ eventType: "message-event", externalEventId: "x", payload });
    return { ...ctx, eventId };
  };

  it("persists every message and status the provider finds, and marks the event processed", async () => {
    const { store, rows, eventId } = await received();
    const messagesPersisted: unknown[] = [];
    const statusesPersisted: unknown[] = [];
    const outcome = await processWhatsAppWebhookEvent(eventId, {
      store,
      provider: fakeProvider({ messages: [{ providerMessageId: "m1" }], statuses: [{ providerMessageId: "m2" }] }) as any,
      persist: { message: async (m) => void messagesPersisted.push(m), status: async (s) => void statusesPersisted.push(s) },
      now: () => NOW,
    });
    assert.equal(outcome, "processed");
    assert.equal(rows[0].status, "PROCESSED");
    assert.equal(messagesPersisted.length, 1);
    assert.equal(statusesPersisted.length, 1);
  });

  it("marks a delivery IGNORED when neither parser recognises the payload", async () => {
    const { store, rows, eventId } = await received();
    const outcome = await processWhatsAppWebhookEvent(eventId, { store, provider: fakeProvider() as any, persist: { message: async () => {}, status: async () => {} }, now: () => NOW });
    assert.equal(outcome, "ignored");
    assert.equal(rows[0].status, "IGNORED");
  });

  it("never processes the same event twice", async () => {
    const { store, eventId } = await received();
    let calls = 0;
    const persist = { message: async () => void calls++, status: async () => void calls++ };
    await processWhatsAppWebhookEvent(eventId, { store, provider: fakeProvider({ messages: [{}] }) as any, persist, now: () => NOW });
    assert.equal(await processWhatsAppWebhookEvent(eventId, { store, provider: fakeProvider({ messages: [{}] }) as any, persist, now: () => NOW }), "skipped");
    assert.equal(calls, 1);
  });

  it("records a failure and retries with backoff, then gives up after MAX_ATTEMPTS", async () => {
    const { store, rows, eventId } = await received();
    const failing = fakeProvider({ messages: [{}] });
    const persist = { message: async () => { throw new Error("db down"); }, status: async () => {} };
    let clock = NOW.getTime();
    let outcome = "";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      outcome = await processWhatsAppWebhookEvent(eventId, { store, provider: failing as any, persist, now: () => new Date(clock) });
      clock += 2 * 3_600_000;
    }
    assert.equal(outcome, "failed");
    assert.equal(rows[0].attempts, MAX_ATTEMPTS);
    assert.equal(rows[0].nextAttemptAt, null);
  });

  it("backs off 1, 2, 4 ... minutes, capped at an hour - same schedule as Shopify's", () => {
    assert.deepEqual([1, 2, 3, 4].map(backoffMs), [60_000, 120_000, 240_000, 480_000]);
    assert.equal(backoffMs(20), 3_600_000);
  });
});

describe("WhatsApp retry worker", () => {
  it("re-processes a delivery recorded but never handled, and a due failure", async () => {
    const { store, rows } = memoryStore();
    const now = new Date("2026-09-20T12:00:00Z");
    await store.record({ eventType: "message-event", externalEventId: "a", payload: {} });
    await store.record({ eventType: "message-event", externalEventId: "b", payload: {} });
    rows[0].receivedAt = new Date(now.getTime() - 120_000);
    rows[1].status = "FAILED";
    rows[1].attempts = 1;
    rows[1].nextAttemptAt = new Date(now.getTime() - 1);

    const handled: string[] = [];
    const worker = startWebhookWorker({ store, process: async (id) => void handled.push(id), now: () => now, intervalMs: 3_600_000 });
    assert.equal(await worker.tick(), 2);
    assert.deepEqual(handled.sort(), ["evt-1", "evt-2"]);
    worker.stop();
  });

  it("does not run two passes at once, and survives a failing pass", async () => {
    const errors: unknown[] = [];
    const store: WebhookStore = { ...memoryStore().store, due: async () => { throw new Error("db down"); } };
    const worker = startWebhookWorker({ store, process: async () => {}, intervalMs: 3_600_000, onError: (e) => errors.push(e) });
    assert.equal(await worker.tick(), 0);
    assert.equal(errors.length, 1);
    worker.stop();
  });
});
