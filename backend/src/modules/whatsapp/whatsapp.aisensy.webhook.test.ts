// Unit tests for the AiSensy Project Webhook receiver (contact.*/message.*/payment.*/order.placed/
// lead_form.submitted - POST /api/webhooks/aisensy). Same in-memory WebhookStore-fake convention as
// shopify.webhook.test.ts: the handler function is exercised directly, no HTTP layer.
//
// What these tests deliberately do NOT cover: mapping any topic's fields onto a CRM record (contact/
// message/status/chat/campaign/payment/order/lead) - no such mapping exists yet (see
// whatsapp.aisensy.webhook.handler.ts's header comment for why), so there is nothing to test there.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadAiSensyProjectWebhookConfig } from "./whatsapp.aisensy.webhook.config.js";
import { deliveryId, extractTopic, TOPICS_OBSERVED_IN_DASHBOARD } from "./whatsapp.aisensy.webhook.events.js";
import { handleAiSensyProjectWebhook, type AiSensyProjectWebhookRequest } from "./whatsapp.aisensy.webhook.handler.js";
import { LEASE_MS, MAX_ATTEMPTS, type StoredEvent, type WebhookStore } from "../shopify/shopify.webhook.store.js";

interface Row {
  id: string;
  eventType: string;
  externalEventId: string;
  payload: unknown;
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED" | "IGNORED";
  attempts: number;
  nextAttemptAt: Date | null;
}

function memoryStore() {
  const rows: Row[] = [];
  const store: WebhookStore = {
    async record({ eventType, externalEventId, payload, ignored }) {
      const existing = rows.find((r) => r.externalEventId === externalEventId);
      if (existing) return { id: existing.id, duplicate: true };
      const row: Row = { id: `evt-${rows.length + 1}`, eventType, externalEventId, payload, status: ignored ? "IGNORED" : "RECEIVED", attempts: 0, nextAttemptAt: null };
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
      row.nextAttemptAt = null;
    },
    async fail(id, _message, nextAttemptAt) {
      const row = rows.find((r) => r.id === id)!;
      row.status = "FAILED";
      row.nextAttemptAt = nextAttemptAt;
    },
    async due(_now, limit) {
      return rows
        .filter((r) => (r.status === "RECEIVED" && r.attempts < MAX_ATTEMPTS))
        .slice(0, limit)
        .map((r) => r.id);
    },
  };
  return { store, rows };
}

const req = (body: unknown, opts: { query?: Record<string, unknown> } = {}): AiSensyProjectWebhookRequest => ({
  rawBody: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  headers: {},
  query: opts.query ?? {},
});

describe("loadAiSensyProjectWebhookConfig", () => {
  it("has no token configured by default - never crashes, never invents a secret", () => {
    assert.equal(loadAiSensyProjectWebhookConfig({}).token, null);
  });

  it("reads AISENSY_PROJECT_WEBHOOK_TOKEN, trimmed, blank treated as unset", () => {
    assert.equal(loadAiSensyProjectWebhookConfig({ AISENSY_PROJECT_WEBHOOK_TOKEN: "  secret-1  " }).token, "secret-1");
    assert.equal(loadAiSensyProjectWebhookConfig({ AISENSY_PROJECT_WEBHOOK_TOKEN: "   " }).token, null);
  });
});

describe("extractTopic - best-effort label only, never a guess", () => {
  it("reads type/topic/event, in that order", () => {
    assert.equal(extractTopic({ type: "contact.created" }), "contact.created");
    assert.equal(extractTopic({ topic: "message.created" }), "message.created");
    assert.equal(extractTopic({ event: "order.placed" }), "order.placed");
    assert.equal(extractTopic({ type: "a", topic: "b" }), "a");
  });

  it("returns null (never a fabricated label) when none of those fields is usable", () => {
    assert.equal(extractTopic({}), null);
    assert.equal(extractTopic({ type: true }), null);
    assert.equal(extractTopic({ type: {} }), null);
    assert.equal(extractTopic(null), null);
    assert.equal(extractTopic("just a string"), null);
    assert.equal(extractTopic([1, 2, 3]), null);
  });

  it("TOPICS_OBSERVED_IN_DASHBOARD lists the topics from the account's AiSensy Webhook UI, for reference only", () => {
    assert.ok(TOPICS_OBSERVED_IN_DASHBOARD.includes("contact.created"));
    assert.ok(TOPICS_OBSERVED_IN_DASHBOARD.includes("message.status.updated"));
    assert.equal(TOPICS_OBSERVED_IN_DASHBOARD.length, 14);
  });
});

describe("deliveryId", () => {
  it("is stable for identical bytes and differs for different bytes - the documented-data fallback this task calls for", () => {
    assert.equal(deliveryId(Buffer.from("a")), deliveryId(Buffer.from("a")));
    assert.notEqual(deliveryId(Buffer.from("a")), deliveryId(Buffer.from("b")));
  });
});

describe("handleAiSensyProjectWebhook", () => {
  it("accepts and records a valid delivery when no token is configured", async () => {
    const { store, rows } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created", id: "c1" }), { config: { token: null }, store });
    assert.equal(result.status, 200);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.eventType, "contact.created");
    assert.equal(rows[0]!.status, "IGNORED"); // honest: no business logic has run
  });

  it("rejects a request with the wrong token when one is configured", async () => {
    const { store, rows } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }, { query: { token: "wrong" } }), { config: { token: "correct" }, store });
    assert.equal(result.status, 401);
    assert.equal(rows.length, 0, "an unverified request is never recorded");
  });

  it("rejects a request with no token at all when one is configured", async () => {
    const { store, rows } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }), { config: { token: "correct" }, store });
    assert.equal(result.status, 401);
    assert.equal(rows.length, 0);
  });

  it("accepts a request with the correct token", async () => {
    const { store } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }, { query: { token: "correct" } }), { config: { token: "correct" }, store });
    assert.equal(result.status, 200);
  });

  it("never echoes the configured token back in the response", async () => {
    const { store } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }, { query: { token: "super-secret-value" } }), { config: { token: "super-secret-value" }, store });
    assert.equal(JSON.stringify(result).includes("super-secret-value"), false);
  });

  it("rejects a malformed (non-JSON) body", async () => {
    const { store, rows } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req("{not json"), { config: { token: null }, store });
    assert.equal(result.status, 400);
    assert.equal(rows.length, 0);
  });

  it("safely records valid JSON that is not an object, without crashing or guessing a topic", async () => {
    const { store, rows } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req(42), { config: { token: null }, store });
    assert.equal(result.status, 200);
    assert.equal(rows[0]!.eventType, "unknown");
    assert.deepEqual(rows[0]!.payload, { raw: 42 });
  });

  it("records an unrecognised/unsupported topic exactly like a known one - both are equally unmapped today", async () => {
    const { store, rows } = memoryStore();
    const result = await handleAiSensyProjectWebhook(req({ type: "some.future.topic", data: { x: 1 } }), { config: { token: null }, store });
    assert.equal(result.status, 200);
    assert.equal(rows[0]!.eventType, "some.future.topic");
  });

  it("labels a delivery with no recognisable topic field as unknown, never a fabricated guess", async () => {
    const { store, rows } = memoryStore();
    await handleAiSensyProjectWebhook(req({ data: { some: "field" } }), { config: { token: null }, store });
    assert.equal(rows[0]!.eventType, "unknown");
  });

  it("is idempotent: the exact same delivery body twice is recorded once", async () => {
    const { store, rows } = memoryStore();
    const body = { type: "message.created", id: "m1" };
    const first = await handleAiSensyProjectWebhook(req(body), { config: { token: null }, store });
    const second = await handleAiSensyProjectWebhook(req(body), { config: { token: null }, store });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(second.message, /Duplicate/);
    assert.equal(rows.length, 1);
  });

  it("treats two different payloads as different deliveries", async () => {
    const { store, rows } = memoryStore();
    await handleAiSensyProjectWebhook(req({ type: "message.created", id: "m1" }), { config: { token: null }, store });
    await handleAiSensyProjectWebhook(req({ type: "message.created", id: "m2" }), { config: { token: null }, store });
    assert.equal(rows.length, 2);
  });

  it("stores payload/topic verbatim for later reconciliation, for every topic observed in the dashboard", async () => {
    for (const topic of TOPICS_OBSERVED_IN_DASHBOARD) {
      const { store, rows } = memoryStore();
      await handleAiSensyProjectWebhook(req({ type: topic, id: `evt-${topic}` }), { config: { token: null }, store });
      assert.equal(rows[0]!.eventType, topic);
      assert.equal(rows[0]!.status, "IGNORED");
    }
  });
});
