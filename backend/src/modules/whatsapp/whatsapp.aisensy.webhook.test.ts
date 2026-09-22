// Unit tests for the AiSensy Project Webhook receiver (contact.*/message.*/payment.*/order.placed/
// lead_form.submitted - POST /api/webhooks/aisensy). Same in-memory WebhookStore-fake convention as
// shopify.webhook.test.ts: the handler/processor functions are exercised directly, no HTTP layer.
//
// message.status.updated is the one topic with a confirmed real payload and real DB-writing
// processing (whatsapp.aisensy.webhook.events.ts/.processor.ts) - the full round trip against a real
// WhatsAppMessage row (status progression, regression protection, Activity creation) is covered in
// whatsapp.aisensy.webhook.db-test.ts, same split as the rest of this codebase (DB-touching
// orchestration is tested against a real, rolled-back transaction, not a deep Prisma mock). What's
// tested here is everything that does NOT need a database: topic recognition/dedup, payload parsing,
// and the processor's early-exit branches (unmatched messageId, unsupported status, malformed
// payload) that never reach a write.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadAiSensyProjectWebhookConfig } from "./whatsapp.aisensy.webhook.config.js";
import { deliveryId, extractTopic, parseAiSensyMessageStatusUpdate, TOPICS_OBSERVED_IN_DASHBOARD } from "./whatsapp.aisensy.webhook.events.js";
import { handleAiSensyProjectWebhook, type AiSensyProjectWebhookRequest } from "./whatsapp.aisensy.webhook.handler.js";
import { processAiSensyProjectWebhookEvent } from "./whatsapp.aisensy.webhook.processor.js";
import { LEASE_MS, MAX_ATTEMPTS, type StoredEvent, type WebhookStore } from "../shopify/shopify.webhook.store.js";

// The exact real payload captured from this account's own AiSensy project (2026-09-22) - see the
// task that added this file. Never a fabricated shape.
const REAL_SENT_PAYLOAD = {
  id: "6ab27af6c0e602d3f99460ec",
  data: {
    message: {
      id: "6ab27af418d59a943d153073",
      type: "message",
      sender: "ASSISTANT",
      status: "SENT",
      read_at: 1790081781000,
      sent_at: 1790081781000,
      userName: "Vishwaa Reddy",
      messageId: "wamid.HBgMOTE5MzIxNjE0MDI1FQIAERgSNjhGREVCQTQ2RjdGMUU1NUQyAA==",
      contact_id: "6a6452b80405540002a17805",
      project_id: "6a6088353b43790e9cbf6114",
      countryCode: "91",
      delivered_at: 1790081781000,
      message_type: "TEXT",
      phone_number: "919321614025",
      message_content: { text: "Hey there!", type: "TEXT", isFromFlow: true, isAiGenerated: true },
    },
  },
  topic: "message.status.updated",
  created_at: "2026-09-22T12:56:27.308Z",
  project_id: "6a6088353b43790e9cbf6114",
  delivery_attempt: "1",
};

const REAL_READ_PAYLOAD = {
  ...REAL_SENT_PAYLOAD,
  id: "6ab27af7d6e40e29a25aea97",
  data: { message: { ...REAL_SENT_PAYLOAD.data.message, status: "READ", sent_at: 1790081779530, read_at: 1790081781000 } },
  created_at: "2026-09-22T12:56:24.550Z",
};

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

/** Handler deps with a schedule() that just records which event ids were queued, for assertions. */
function handlerDeps(store: WebhookStore, token: string | null = null) {
  const scheduled: string[] = [];
  return { deps: { config: { token }, store, schedule: (id: string) => scheduled.push(id) }, scheduled };
}

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
    const { deps } = handlerDeps(store);
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created", id: "c1" }), deps);
    assert.equal(result.status, 200);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.eventType, "contact.created");
    assert.equal(rows[0]!.status, "IGNORED"); // honest: no mapping exists for this topic
  });

  it("rejects a request with the wrong token when one is configured", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store, "correct");
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }, { query: { token: "wrong" } }), deps);
    assert.equal(result.status, 401);
    assert.equal(rows.length, 0, "an unverified request is never recorded");
  });

  it("rejects a request with no token at all when one is configured", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store, "correct");
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }), deps);
    assert.equal(result.status, 401);
    assert.equal(rows.length, 0);
  });

  it("accepts a request with the correct token", async () => {
    const { store } = memoryStore();
    const { deps } = handlerDeps(store, "correct");
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }, { query: { token: "correct" } }), deps);
    assert.equal(result.status, 200);
  });

  it("never echoes the configured token back in the response", async () => {
    const { store } = memoryStore();
    const { deps } = handlerDeps(store, "super-secret-value");
    const result = await handleAiSensyProjectWebhook(req({ type: "contact.created" }, { query: { token: "super-secret-value" } }), deps);
    assert.equal(JSON.stringify(result).includes("super-secret-value"), false);
  });

  it("rejects a malformed (non-JSON) body", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store);
    const result = await handleAiSensyProjectWebhook(req("{not json"), deps);
    assert.equal(result.status, 400);
    assert.equal(rows.length, 0);
  });

  it("safely records valid JSON that is not an object, without crashing or guessing a topic", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store);
    const result = await handleAiSensyProjectWebhook(req(42), deps);
    assert.equal(result.status, 200);
    assert.equal(rows[0]!.eventType, "unknown");
    assert.deepEqual(rows[0]!.payload, { raw: 42 });
  });

  it("records an unrecognised/unsupported topic exactly like a known one - both are equally unmapped today", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store);
    const result = await handleAiSensyProjectWebhook(req({ type: "some.future.topic", data: { x: 1 } }), deps);
    assert.equal(result.status, 200);
    assert.equal(rows[0]!.eventType, "some.future.topic");
  });

  it("labels a delivery with no recognisable topic field as unknown, never a fabricated guess", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store);
    await handleAiSensyProjectWebhook(req({ data: { some: "field" } }), deps);
    assert.equal(rows[0]!.eventType, "unknown");
  });

  it("is idempotent: the exact same delivery body twice is recorded once", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store);
    const body = { type: "message.created", id: "m1" };
    const first = await handleAiSensyProjectWebhook(req(body), deps);
    const second = await handleAiSensyProjectWebhook(req(body), deps);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(second.message, /Duplicate/);
    assert.equal(rows.length, 1);
  });

  it("treats two different payloads as different deliveries", async () => {
    const { store, rows } = memoryStore();
    const { deps } = handlerDeps(store);
    await handleAiSensyProjectWebhook(req({ type: "message.created", id: "m1" }), deps);
    await handleAiSensyProjectWebhook(req({ type: "message.created", id: "m2" }), deps);
    assert.equal(rows.length, 2);
  });

  it("stores payload/topic verbatim for every OTHER topic observed in the dashboard, without scheduling processing", async () => {
    for (const topic of TOPICS_OBSERVED_IN_DASHBOARD) {
      if (topic === "message.status.updated") continue; // the one exception - covered below
      const { store, rows } = memoryStore();
      const { deps, scheduled } = handlerDeps(store);
      await handleAiSensyProjectWebhook(req({ type: topic, id: `evt-${topic}` }), deps);
      assert.equal(rows[0]!.eventType, topic);
      assert.equal(rows[0]!.status, "IGNORED");
      assert.equal(scheduled.length, 0);
    }
  });

  it("schedules processing ONLY for message.status.updated - no other topic is auto-processed", async () => {
    const { store: store1, rows: rows1 } = memoryStore();
    const { deps: deps1, scheduled: scheduled1 } = handlerDeps(store1);
    const result1 = await handleAiSensyProjectWebhook(req(REAL_SENT_PAYLOAD), deps1);
    assert.equal(result1.status, 200);
    assert.equal(rows1[0]!.status, "RECEIVED"); // not pre-ignored - genuinely queued
    assert.equal(scheduled1.length, 1);
    assert.equal(scheduled1[0], rows1[0]!.id);

    const { store: store2 } = memoryStore();
    const { deps: deps2, scheduled: scheduled2 } = handlerDeps(store2);
    await handleAiSensyProjectWebhook(req({ type: "contact.created" }), deps2);
    assert.equal(scheduled2.length, 0);
  });
});

describe("parseAiSensyMessageStatusUpdate - only the confirmed real shape, never a guess", () => {
  it("parses the real captured SENT delivery", () => {
    const update = parseAiSensyMessageStatusUpdate(REAL_SENT_PAYLOAD);
    assert.ok(update);
    assert.equal(update!.providerMessageId, "wamid.HBgMOTE5MzIxNjE0MDI1FQIAERgSNjhGREVCQTQ2RjdGMUU1NUQyAA==");
    assert.equal(update!.status, "SENT");
    assert.equal(update!.timestamp.getTime(), 1790081781000); // sent_at, converted from ms epoch
  });

  it("parses the real captured READ delivery", () => {
    const update = parseAiSensyMessageStatusUpdate(REAL_READ_PAYLOAD);
    assert.ok(update);
    assert.equal(update!.status, "READ");
    assert.equal(update!.timestamp.getTime(), 1790081781000); // read_at, converted from ms epoch
  });

  it("returns null for an unsupported status - never guesses onto the closest CRM value", () => {
    const payload = { ...REAL_SENT_PAYLOAD, data: { message: { ...REAL_SENT_PAYLOAD.data.message, status: "DELIVERED" } } };
    assert.equal(parseAiSensyMessageStatusUpdate(payload), null);
  });

  it("returns null when data.message is missing entirely - never crashes", () => {
    assert.equal(parseAiSensyMessageStatusUpdate({ topic: "message.status.updated" }), null);
    assert.equal(parseAiSensyMessageStatusUpdate({}), null);
    assert.equal(parseAiSensyMessageStatusUpdate(null), null);
    assert.equal(parseAiSensyMessageStatusUpdate("not an object"), null);
  });

  it("returns null when messageId or status is missing from data.message", () => {
    assert.equal(parseAiSensyMessageStatusUpdate({ data: { message: { status: "SENT" } } }), null); // no messageId
    assert.equal(parseAiSensyMessageStatusUpdate({ data: { message: { messageId: "wamid.x" } } }), null); // no status
  });

  it("falls back to created_at, then now(), when the per-status ms timestamp is absent", () => {
    const noTimestamp = { data: { message: { messageId: "wamid.x", status: "SENT" } }, created_at: "2026-01-01T00:00:00.000Z" };
    assert.equal(parseAiSensyMessageStatusUpdate(noTimestamp)!.timestamp.toISOString(), "2026-01-01T00:00:00.000Z");

    const fixedNow = new Date("2026-05-05T05:05:05.000Z");
    const nothingAtAll = { data: { message: { messageId: "wamid.x", status: "READ" } } };
    assert.equal(parseAiSensyMessageStatusUpdate(nothingAtAll, () => fixedNow)!.timestamp.getTime(), fixedNow.getTime());
  });
});

describe("processAiSensyProjectWebhookEvent - branches that never touch the database", () => {
  const throwingDb = { whatsAppMessage: { findUnique: async () => { throw new Error("must not be called on this branch"); } } } as any;

  it("ignores (never processes) a stored event for any topic other than message.status.updated", async () => {
    const { store, rows } = memoryStore();
    const { id } = await store.record({ eventType: "contact.created", externalEventId: "e1", payload: { type: "contact.created" } });
    const outcome = await processAiSensyProjectWebhookEvent(id, { store, db: throwingDb });
    assert.equal(outcome, "ignored");
    assert.equal(rows.find((r) => r.id === id)!.status, "IGNORED");
  });

  it("ignores an unparseable message.status.updated payload without touching the database", async () => {
    const { store, rows } = memoryStore();
    const { id } = await store.record({ eventType: "message.status.updated", externalEventId: "e2", payload: { topic: "message.status.updated" } });
    const outcome = await processAiSensyProjectWebhookEvent(id, { store, db: throwingDb });
    assert.equal(outcome, "ignored");
    assert.equal(rows.find((r) => r.id === id)!.status, "IGNORED");
  });

  it("ignores an unsupported status without touching the database", async () => {
    const { store, rows } = memoryStore();
    const payload = { ...REAL_SENT_PAYLOAD, data: { message: { ...REAL_SENT_PAYLOAD.data.message, status: "FAILED" } } };
    const { id } = await store.record({ eventType: "message.status.updated", externalEventId: "e3", payload });
    const outcome = await processAiSensyProjectWebhookEvent(id, { store, db: throwingDb });
    assert.equal(outcome, "ignored");
    assert.equal(rows.find((r) => r.id === id)!.status, "IGNORED");
  });

  it("logs and safely ignores an unknown messageId - never creates a fake/partial CRM message", async () => {
    const { store, rows } = memoryStore();
    const { id } = await store.record({ eventType: "message.status.updated", externalEventId: "e4", payload: REAL_SENT_PAYLOAD });
    const db = { whatsAppMessage: { findUnique: async () => null } } as any;
    const outcome = await processAiSensyProjectWebhookEvent(id, { store, db });
    assert.equal(outcome, "ignored");
    assert.equal(rows.find((r) => r.id === id)!.status, "IGNORED");
  });

  it("skips (does nothing) claiming an event id that does not exist or is already done", async () => {
    const { store } = memoryStore();
    const outcome = await processAiSensyProjectWebhookEvent("no-such-id", { store, db: throwingDb });
    assert.equal(outcome, "skipped");
  });
});
