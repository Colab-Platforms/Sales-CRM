import "dotenv/config"; // requireRole below pulls in @/lib/jwt.js, which reads JWT_SECRET at module load - same convention as @/lib/prisma.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { decryptJson, encryptJson } from "@/utils/crypto.js";
import { requireRole } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import { Role } from "../../../generated/prisma/enums.js";
import { resolveMetaWebhookChallenge, verifyMetaSignature } from "./whatsapp.hmac.js";
import { MetaCloudApiProvider, type MetaCloudApiCredentials } from "./whatsapp.meta.provider.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import { handleWhatsAppWebhook } from "./whatsapp.webhook.handler.js";
import { processWhatsAppWebhookEvent } from "./whatsapp.webhook.processor.js";
import { LEASE_MS, MAX_ATTEMPTS, type StoredEvent, type WebhookStore } from "./whatsapp.webhook.store.js";

// Same in-memory WebhookStore fixture whatsapp.test.ts uses for AiSensy/Gupshup - duplicated here
// rather than imported/shared, matching that file's own convention (it is not exported either).
function memoryStore() {
  interface Row {
    id: string;
    eventType: string;
    externalEventId: string;
    payload: unknown;
    status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED" | "IGNORED";
    attempts: number;
    nextAttemptAt: Date | null;
    receivedAt: Date;
  }
  const rows: Row[] = [];
  const store: WebhookStore = {
    async record({ eventType, externalEventId, payload, ignored }) {
      const existing = rows.find((r) => r.externalEventId === externalEventId);
      if (existing) return { id: existing.id, duplicate: true };
      const row: Row = { id: `evt-${rows.length + 1}`, eventType, externalEventId, payload, status: ignored ? "IGNORED" : "RECEIVED", attempts: 0, nextAttemptAt: null, receivedAt: new Date() };
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

const credentials = (): MetaCloudApiCredentials => ({
  phoneNumberId: "1234567890",
  businessAccountId: "9876543210",
  accessToken: "EAA-super-secret-token",
  appSecret: "app-secret",
  verifyToken: "verify-me",
  graphApiVersion: "v21.0",
});

// ==== HMAC / signature verification ====

describe("verifyMetaSignature", () => {
  it("accepts a correctly computed X-Hub-Signature-256 and rejects a tampered body, wrong secret, or missing header", () => {
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const good = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    assert.equal(verifyMetaSignature(body, good, "app-secret"), true);
    assert.equal(verifyMetaSignature(body, good, "wrong-secret"), false);
    assert.equal(verifyMetaSignature(Buffer.from(JSON.stringify({ a: 2 })), good, "app-secret"), false);
    assert.equal(verifyMetaSignature(body, undefined, "app-secret"), false);
    assert.equal(verifyMetaSignature(body, "not-prefixed-hex", "app-secret"), false);
  });
});

describe("resolveMetaWebhookChallenge (GET verification handshake)", () => {
  it("echoes the challenge only when mode=subscribe and the verify token matches", () => {
    const result = resolveMetaWebhookChallenge({ mode: "subscribe", verifyToken: "verify-me", challenge: "chal-123" }, "verify-me");
    assert.equal(result, "chal-123");
  });

  it("returns null (403) for a wrong verify token, without leaking why", () => {
    assert.equal(resolveMetaWebhookChallenge({ mode: "subscribe", verifyToken: "wrong", challenge: "chal-123" }, "verify-me"), null);
  });

  it("returns null when there is no active/decryptable config", () => {
    assert.equal(resolveMetaWebhookChallenge({ mode: "subscribe", verifyToken: "verify-me", challenge: "chal-123" }, null), null);
  });

  it("returns null for a non-subscribe mode or a missing challenge", () => {
    assert.equal(resolveMetaWebhookChallenge({ mode: "unsubscribe", verifyToken: "verify-me", challenge: "c" }, "verify-me"), null);
    assert.equal(resolveMetaWebhookChallenge({ mode: "subscribe", verifyToken: "verify-me", challenge: undefined }, "verify-me"), null);
  });
});

// ==== Encryption round-trip (WhatsAppConfig credentials use the same shared crypto.ts as Source) ====

describe("WhatsApp Cloud API config credential encryption", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");

  it("round-trips accessToken/appSecret/verifyToken through encryptJson/decryptJson", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const secret = { accessToken: "EAA-token", appSecret: "app-secret", verifyToken: "verify-me" };
    const encrypted = encryptJson(secret);
    assert.equal(typeof encrypted, "string");
    assert.doesNotMatch(encrypted, /EAA-token/);
    const decrypted = decryptJson<typeof secret>(encrypted);
    assert.deepEqual(decrypted, secret);
  });

  it("throws (never returns a plausible-looking wrong value) when decrypted with the wrong key", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
    const encrypted = encryptJson({ accessToken: "a", appSecret: "b", verifyToken: "c" });
    process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    assert.throws(() => decryptJson(encrypted));
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
  });

  it("throws when the key is missing or not a valid 32-byte base64 value", () => {
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    assert.throws(() => encryptJson({ a: 1 }));
    process.env.INTEGRATION_ENCRYPTION_KEY = "not-base64-32-bytes";
    assert.throws(() => encryptJson({ a: 1 }));
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY;
  });
});

// ==== MetaCloudApiProvider ====

describe("MetaCloudApiProvider", () => {
  it("sends a text message with the documented Graph API shape and Bearer auth", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse(200, { messages: [{ id: "wamid.OUT1" }] });
    }) as typeof fetch;

    const provider = new MetaCloudApiProvider(credentials(), { fetchImpl });
    const result = await provider.sendText({ to: "+919876543210", body: "Hello" });

    assert.equal(result.providerMessageId, "wamid.OUT1");
    assert.ok(captured);
    const c = captured as unknown as { url: string; init: RequestInit };
    assert.equal(c.url, "https://graph.facebook.com/v21.0/1234567890/messages");
    assert.equal((c.init.headers as Record<string, string>).Authorization, "Bearer EAA-super-secret-token");
    const body = JSON.parse(c.init.body as string);
    assert.equal(body.messaging_product, "whatsapp");
    assert.equal(body.type, "text");
    assert.equal(body.text.body, "Hello");
  });

  it("sends a template message with positional body parameters", async () => {
    let captured: any = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return jsonResponse(200, { messages: [{ id: "wamid.OUT2" }] });
    }) as typeof fetch;
    await new MetaCloudApiProvider(credentials(), { fetchImpl }).sendTemplateMessage({ to: "+91", templateName: "order_update", params: ["Ravi", "SHP-1"] });
    assert.equal(captured.template.name, "order_update");
    assert.deepEqual(captured.template.components, [{ type: "body", parameters: [{ type: "text", text: "Ravi" }, { type: "text", text: "SHP-1" }] }]);
  });

  it("throws WhatsAppSendError on a non-2xx, non-retryable response without crashing", async () => {
    const fetchImpl = (async () => jsonResponse(400, { error: { message: "bad recipient" } })) as typeof fetch;
    const provider = new MetaCloudApiProvider(credentials(), { fetchImpl });
    await assert.rejects(() => provider.sendText({ to: "+91", body: "hi" }), WhatsAppSendError);
  });

  it("throws WhatsAppSendError when the network call itself fails on every attempt", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const provider = new MetaCloudApiProvider(credentials(), { fetchImpl });
    await assert.rejects(() => provider.sendText({ to: "+91", body: "hi" }), WhatsAppSendError);
  });

  it("retries once on a 429/5xx and succeeds if the retry works", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(503, { error: "overloaded" }) : jsonResponse(200, { messages: [{ id: "wamid.RETRY" }] });
    }) as typeof fetch;
    const result = await new MetaCloudApiProvider(credentials(), { fetchImpl }).sendText({ to: "+91", body: "hi" });
    assert.equal(calls, 2);
    assert.equal(result.providerMessageId, "wamid.RETRY");
  });

  it("never includes the access token in a thrown error's message", async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: "invalid token" })) as typeof fetch;
    const provider = new MetaCloudApiProvider(credentials(), { fetchImpl });
    try {
      await provider.sendText({ to: "+91", body: "hi" });
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof WhatsAppSendError);
      assert.doesNotMatch(error.message, /EAA-super-secret-token/);
    }
  });

  it("verifies its webhook with the configured app secret via X-Hub-Signature-256", () => {
    const provider = new MetaCloudApiProvider(credentials());
    const body = Buffer.from(JSON.stringify({ a: 1 }));
    const good = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    assert.equal(provider.verifyWebhook({ rawBody: body, headers: { "x-hub-signature-256": good } }), true);
    assert.equal(provider.verifyWebhook({ rawBody: body, headers: { "x-hub-signature-256": "sha256=wrong" } }), false);
    assert.equal(provider.verifyWebhook({ rawBody: body, headers: {} }), false);
  });

  const metaEnvelope = (value: Record<string, unknown>) => ({ entry: [{ changes: [{ value }] }] });

  it("parses an inbound text message in the Meta Cloud API envelope", () => {
    const provider = new MetaCloudApiProvider(credentials());
    const payload = metaEnvelope({
      metadata: { display_phone_number: "919876500000" },
      messages: [{ id: "wamid.IN1", from: "919876543210", type: "text", text: { body: "Hi there" }, timestamp: "1700000000" }],
    });
    assert.deepEqual(provider.parseIncomingWebhook(payload), [{ providerMessageId: "wamid.IN1", from: "919876543210", to: "919876500000", messageType: "TEXT", text: "Hi there", timestamp: new Date(1700000000 * 1000) }]);
  });

  it("parses a delivery status update, mapping the documented status values", () => {
    const provider = new MetaCloudApiProvider(credentials());
    const payload = metaEnvelope({ statuses: [{ id: "wamid.IN1", status: "read", timestamp: "1700000000" }] });
    assert.deepEqual(provider.parseDeliveryStatusWebhook(payload), [{ providerMessageId: "wamid.IN1", status: "READ", timestamp: new Date(1700000000 * 1000), errorCode: undefined, errorMessage: undefined }]);
  });

  it("returns [] rather than throwing for a shape it does not recognise", () => {
    const provider = new MetaCloudApiProvider(credentials());
    assert.deepEqual(provider.parseIncomingWebhook({ unexpected: true }), []);
    assert.deepEqual(provider.parseIncomingWebhook(null), []);
    assert.deepEqual(provider.parseDeliveryStatusWebhook("not an object"), []);
  });
});

// ==== Webhook handler, wired to a real MetaCloudApiProvider - idempotency/duplicate coverage ====

describe("Meta WhatsApp Cloud API webhook handler", () => {
  const provider = new MetaCloudApiProvider(credentials());
  const sign = (body: string) => `sha256=${createHmac("sha256", "app-secret").update(Buffer.from(body)).digest("hex")}`;
  const BODY = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "sent", timestamp: "1" }] } }] }] });

  const setup = () => {
    const { store, rows } = memoryStore();
    const scheduled: string[] = [];
    const handle = (rawBody: string, headers: Record<string, string> = { "x-hub-signature-256": sign(rawBody) }) =>
      handleWhatsAppWebhook({ rawBody: Buffer.from(rawBody), headers }, { provider, store, schedule: (id) => void scheduled.push(id) });
    return { handle, rows, scheduled };
  };

  it("acknowledges, records, and schedules a validly signed delivery", async () => {
    const { handle, rows, scheduled } = setup();
    const res = await handle(BODY);
    assert.deepEqual(res, { status: 200, message: "Received" });
    assert.equal(rows.length, 1);
    assert.deepEqual(scheduled, ["evt-1"]);
  });

  it("refuses an invalid X-Hub-Signature-256 without recording anything", async () => {
    const { handle, rows } = setup();
    const res = await handle(BODY, { "x-hub-signature-256": "sha256=wrong" });
    assert.equal(res.status, 401);
    assert.equal(rows.length, 0);
  });

  it("never processes the same WhatsApp message/delivery twice - duplicate body is deduplicated", async () => {
    const { handle, rows, scheduled } = setup();
    await handle(BODY);
    const again = await handle(BODY);
    assert.deepEqual(again, { status: 200, message: "Duplicate delivery ignored" });
    assert.equal(rows.length, 1);
    assert.equal(scheduled.length, 1);
  });

  it("persists an incoming message end to end via the real parser", async () => {
    const { store, rows } = memoryStore();
    const incomingBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.IN9", from: "9198", type: "text", text: { body: "hi" }, timestamp: "1" }] } }] }] });
    const { id: eventId } = await store.record({ eventType: "webhook", externalEventId: "x", payload: JSON.parse(incomingBody) });
    const persisted: unknown[] = [];
    const outcome = await processWhatsAppWebhookEvent(eventId, {
      store,
      provider,
      persist: { message: async (m) => void persisted.push(m), status: async () => {} },
    });
    assert.equal(outcome, "processed");
    assert.equal(persisted.length, 1);
    assert.equal(rows[0].status, "PROCESSED");
  });
});

// ==== RBAC: config routes are admin-only ====

describe("WhatsApp Cloud config RBAC", () => {
  const call = (role: Role | null) => {
    const req: any = role ? { user: { id: "u1", role, email: "a@b.com" } } : {};
    let forwarded: any;
    const next = (err?: unknown) => { forwarded = err; };
    requireRole(Role.ADMIN)(req, {} as any, next);
    return forwarded;
  };

  it("rejects a non-admin (or unauthenticated) request with 403", () => {
    assert.ok(call(Role.SALESPERSON) instanceof ApiError);
    assert.equal((call(Role.SALESPERSON) as ApiError).statusCode, 403);
    assert.ok(call(null) instanceof ApiError);
  });

  it("allows an authenticated admin request through", () => {
    assert.equal(call(Role.ADMIN), undefined);
  });
});
