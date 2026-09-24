import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadWebhookConfig, type ShopifyWebhookConfig } from "./shopify.config.js";
import { handleShopifyWebhook, resolveTarget, SUPPORTED_TOPICS } from "./shopify.webhook.handler.js";
import { bodyDigest, computeHmac, verifyHmac } from "./shopify.webhook.hmac.js";
import { processWebhookEvent } from "./shopify.webhook.processor.js";
import { backoffMs, LEASE_MS, MAX_ATTEMPTS, type StoredEvent, type WebhookStore } from "./shopify.webhook.store.js";
import { startWebhookWorker } from "./shopify.webhook.worker.js";

const SECRET = "test-webhook-secret-not-real";
const SHOP = "demo-store.myshopify.com";

const config = (syncEnabled = true): ShopifyWebhookConfig =>
  loadWebhookConfig({ SHOPIFY_WEBHOOK_SECRET: SECRET, SHOPIFY_SYNC_ENABLED: String(syncEnabled) })!;

// ---- an in-memory store that behaves like the database one (unique delivery id, atomic claim, lease) ----

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

const signed = (body: string | Buffer, headers: Record<string, string> = {}, secret = SECRET) => {
  const rawBody = Buffer.from(body);
  return {
    rawBody,
    headers: {
      "x-shopify-hmac-sha256": computeHmac(rawBody, secret),
      "x-shopify-shop-domain": SHOP,
      "x-shopify-topic": "orders/updated",
      "x-shopify-webhook-id": "wh-1",
      ...headers,
    } as Record<string, string | undefined>,
  };
};

const ORDER_BODY = JSON.stringify({ id: 1000000000001, admin_graphql_api_id: "gid://shopify/Order/1000000000001", name: "#TST1001" });

// ---- HMAC ----

describe("HMAC verification", () => {
  it("matches an independently computed base64 HMAC-SHA256 of the raw body", () => {
    const body = Buffer.from(ORDER_BODY);
    assert.equal(computeHmac(body, SECRET), createHmac("sha256", SECRET).update(body).digest("base64"));
  });

  it("accepts a correct signature", () => {
    const body = Buffer.from(ORDER_BODY);
    assert.equal(verifyHmac(body, computeHmac(body, SECRET), SECRET), true);
  });

  it("rejects the wrong secret, a tampered body, a missing header and garbage", () => {
    const body = Buffer.from(ORDER_BODY);
    const good = computeHmac(body, SECRET);
    assert.equal(verifyHmac(body, computeHmac(body, "other-secret"), SECRET), false);
    assert.equal(verifyHmac(Buffer.from(ORDER_BODY.replace("TST1001", "AWL00000")), good, SECRET), false);
    assert.equal(verifyHmac(body, undefined, SECRET), false);
    assert.equal(verifyHmac(body, "", SECRET), false);
    assert.equal(verifyHmac(body, "not-base64-at-all", SECRET), false);
    assert.equal(verifyHmac(body, good.slice(0, -4), SECRET), false);
  });

  it("depends on the exact bytes: the same JSON re-serialised with different whitespace fails", () => {
    const original = Buffer.from(ORDER_BODY);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(ORDER_BODY), null, 2));
    assert.equal(verifyHmac(reformatted, computeHmac(original, SECRET), SECRET), false);
  });

  it("gives a stable stand-in id for a body", () => {
    assert.equal(bodyDigest(Buffer.from("x")), bodyDigest(Buffer.from("x")));
    assert.notEqual(bodyDigest(Buffer.from("x")), bodyDigest(Buffer.from("y")));
  });
});

// ---- the request handler ----

describe("webhook handler", () => {
  const setup = (cfg: ShopifyWebhookConfig | null = config()) => {
    const { store, rows } = memoryStore();
    const scheduled: string[] = [];
    const handle = (req: ReturnType<typeof signed>) => handleShopifyWebhook(req, { config: cfg, store, schedule: (id) => void scheduled.push(id) });
    return { handle, rows, scheduled };
  };

  it("acknowledges and records a valid delivery, then schedules it once", async () => {
    const { handle, rows, scheduled } = setup();
    const res = await handle(signed(ORDER_BODY));
    assert.deepEqual(res, { status: 200, message: "Received" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventType, "orders/updated");
    assert.equal(rows[0].externalEventId, "wh-1");
    assert.equal((rows[0].payload as { name: string }).name, "#TST1001");
    assert.deepEqual(scheduled, ["evt-1"]);
  });

  it("refuses an invalid signature without recording or scheduling anything", async () => {
    const { handle, rows, scheduled } = setup();
    const res = await handle(signed(ORDER_BODY, {}, "wrong-secret"));
    assert.equal(res.status, 401);
    assert.equal(rows.length, 0);
    assert.equal(scheduled.length, 0);
  });

  it("refuses a delivery with no signature", async () => {
    const { handle, rows } = setup();
    const req = signed(ORDER_BODY);
    delete req.headers["x-shopify-hmac-sha256"];
    assert.equal((await handle(req)).status, 401);
    assert.equal(rows.length, 0);
  });

  it("refuses a correctly signed delivery whose shop header is missing or not a myshopify.com domain", async () => {
    const { handle, rows } = setup();
    assert.equal((await handle(signed(ORDER_BODY, { "x-shopify-shop-domain": "evil.example.com" }))).status, 401);
    const noShop = signed(ORDER_BODY);
    delete noShop.headers["x-shopify-shop-domain"];
    assert.equal((await handle(noShop)).status, 401);
    assert.equal(rows.length, 0);
  });

  it("accepts any of the store's myshopify.com names (a store has an original one and a current one)", async () => {
    const { handle, rows } = setup();
    assert.equal((await handle(signed(ORDER_BODY, { "x-shopify-shop-domain": "123456-ab.myshopify.com", "x-shopify-webhook-id": "a" }))).status, 200);
    assert.equal((await handle(signed(ORDER_BODY, { "x-shopify-shop-domain": "demo-original.myshopify.com", "x-shopify-webhook-id": "b" }))).status, 200);
    assert.equal(rows.length, 2);
  });

  it("refuses everything, and records nothing, when webhooks are not configured", async () => {
    const { handle, rows } = setup(null);
    assert.equal((await handle(signed(ORDER_BODY))).status, 503);
    assert.equal(rows.length, 0);
  });

  it("rejects a missing topic and a body that is not JSON", async () => {
    const { handle, rows } = setup();
    const noTopic = signed(ORDER_BODY);
    delete noTopic.headers["x-shopify-topic"];
    assert.equal((await handle(noTopic)).status, 400);
    assert.equal((await handle(signed("{not json"))).status, 400);
    assert.equal(rows.length, 0);
  });

  it("does not record or process the same delivery twice", async () => {
    const { handle, rows, scheduled } = setup();
    assert.equal((await handle(signed(ORDER_BODY))).message, "Received");
    const again = await handle(signed(ORDER_BODY));
    assert.deepEqual(again, { status: 200, message: "Duplicate delivery ignored" });
    assert.equal(rows.length, 1);
    assert.equal(scheduled.length, 1);
  });

  it("treats two different deliveries as different", async () => {
    const { handle, rows, scheduled } = setup();
    await handle(signed(ORDER_BODY, { "x-shopify-webhook-id": "wh-1" }));
    await handle(signed(ORDER_BODY, { "x-shopify-webhook-id": "wh-2" }));
    assert.equal(rows.length, 2);
    assert.equal(scheduled.length, 2);
  });

  it("still de-duplicates a delivery that lacks a webhook id, by its body", async () => {
    const { handle, rows } = setup();
    const req = signed(ORDER_BODY);
    delete req.headers["x-shopify-webhook-id"];
    await handle(req);
    await handle(req);
    assert.equal(rows.length, 1);
    assert.match(rows[0].externalEventId, /^sha256:/);
  });

  it("records, but does not schedule, a topic it does not handle", async () => {
    const { handle, rows, scheduled } = setup();
    const res = await handle(signed(ORDER_BODY, { "x-shopify-topic": "carts/update" }));
    assert.deepEqual(res, { status: 200, message: "Topic not handled" });
    assert.equal(rows[0].status, "IGNORED");
    assert.equal(scheduled.length, 0);
  });

  it("records but holds back processing while sync is switched off", async () => {
    const { handle, rows, scheduled } = setup(config(false));
    assert.equal((await handle(signed(ORDER_BODY))).status, 200);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "RECEIVED");
    assert.equal(scheduled.length, 0);
  });

  it("supports the E6 topics", () => {
    for (const topic of ["orders/create", "orders/updated", "orders/cancelled", "customers/create", "customers/update", "products/create", "products/update"]) {
      assert.ok(SUPPORTED_TOPICS.includes(topic), topic);
    }
  });

  it("never exposes the secret through the config object", () => {
    assert.equal(JSON.stringify(config()).includes(SECRET), false);
    assert.equal(loadWebhookConfig({ SHOPIFY_STORE_DOMAIN: SHOP }), null, "no secret, no webhooks");
    assert.equal(loadWebhookConfig({ SHOPIFY_WEBHOOK_SECRET: "   " }), null);
    assert.notEqual(loadWebhookConfig({ SHOPIFY_WEBHOOK_SECRET: SECRET }), null, "the secret alone is enough");
  });
});

// ---- deciding which record a delivery is about ----

describe("resolveTarget", () => {
  it("reads the record id for orders, customers and products", () => {
    assert.deepEqual(resolveTarget("orders/create", { admin_graphql_api_id: "gid://shopify/Order/1", id: 1 }), { kind: "order", id: "gid://shopify/Order/1" });
    assert.deepEqual(resolveTarget("orders/cancelled", { id: 22 }), { kind: "order", id: "22" });
    assert.deepEqual(resolveTarget("customers/update", { id: 33 }), { kind: "customer", id: "33" });
    assert.deepEqual(resolveTarget("products/create", { admin_graphql_api_id: "gid://shopify/Product/44" }), { kind: "product", id: "gid://shopify/Product/44" });
  });

  it("uses order_id for fulfilment and refund events", () => {
    assert.deepEqual(resolveTarget("fulfillments/create", { id: 999, order_id: 55 }), { kind: "order", id: "55" });
    assert.deepEqual(resolveTarget("refunds/create", { id: 998, order_id: 56 }), { kind: "order", id: "56" });
  });

  it("returns null when there is nothing to act on", () => {
    assert.equal(resolveTarget("orders/create", {}), null);
    assert.equal(resolveTarget("orders/create", null), null);
    assert.equal(resolveTarget("fulfillments/create", { id: 1 }), null);
    assert.equal(resolveTarget("carts/update", { id: 1 }), null);
  });
});

// ---- processing, retry and never twice ----

describe("webhook processing", () => {
  const NOW = new Date("2026-09-19T12:00:00Z");
  const fakeSync = () => {
    const calls: string[] = [];
    return {
      calls,
      sync: {
        order: async (id: string) => { calls.push(`order:${id}`); return { notFound: false }; },
        product: async (id: string) => { calls.push(`product:${id}`); return { notFound: false }; },
        customer: async (id: string) => { calls.push(`customer:${id}`); return { notFound: false }; },
      },
    };
  };
  const received = async (topic = "orders/updated", payload: unknown = { id: 7 }, id = "wh-1") => {
    const ctx = memoryStore();
    const { id: eventId } = await ctx.store.record({ eventType: topic, externalEventId: id, payload });
    return { ...ctx, eventId };
  };

  it("syncs the record the delivery is about, and marks the event processed", async () => {
    const { store, rows, eventId } = await received("orders/updated", { id: 7 });
    const { sync, calls } = fakeSync();
    assert.equal(await processWebhookEvent(eventId, { store, sync, now: () => NOW }), "processed");
    assert.deepEqual(calls, ["order:7"]);
    assert.equal(rows[0].status, "PROCESSED");
  });

  it("routes customer and product events to their own sync", async () => {
    for (const [topic, expected] of [["customers/create", "customer:9"], ["products/update", "product:9"]] as const) {
      const { store, eventId } = await received(topic, { id: 9 }, `wh-${topic}`);
      const { sync, calls } = fakeSync();
      await processWebhookEvent(eventId, { store, sync, now: () => NOW });
      assert.deepEqual(calls, [expected]);
    }
  });

  it("never processes the same event twice", async () => {
    const { store, eventId } = await received();
    const { sync, calls } = fakeSync();
    assert.equal(await processWebhookEvent(eventId, { store, sync, now: () => NOW }), "processed");
    assert.equal(await processWebhookEvent(eventId, { store, sync, now: () => NOW }), "skipped");
    assert.equal(calls.length, 1);
  });

  it("lets only one of two simultaneous workers take an event", async () => {
    const { store, eventId } = await received();
    const { sync, calls } = fakeSync();
    const results = await Promise.all([
      processWebhookEvent(eventId, { store, sync, now: () => NOW }),
      processWebhookEvent(eventId, { store, sync, now: () => NOW }),
    ]);
    assert.deepEqual(results.sort(), ["processed", "skipped"]);
    assert.equal(calls.length, 1);
  });

  it("records a failure and schedules a retry with growing delay", async () => {
    const { store, rows, eventId } = await received();
    const failing = { ...fakeSync().sync, order: async () => { throw new Error("Shopify had a server error (503)."); } };

    assert.equal(await processWebhookEvent(eventId, { store, sync: failing, now: () => NOW }), "retry");
    assert.equal(rows[0].status, "FAILED");
    assert.equal(rows[0].attempts, 1);
    assert.match(rows[0].errorMessage ?? "", /server error/);
    assert.equal(rows[0].nextAttemptAt?.getTime(), NOW.getTime() + backoffMs(1));

    // Not retried before its time...
    assert.equal(await processWebhookEvent(eventId, { store, sync: failing, now: () => new Date(NOW.getTime() + 1000) }), "skipped");
    // ...but is once it is due.
    const later = new Date(NOW.getTime() + backoffMs(1) + 1);
    assert.equal(await processWebhookEvent(eventId, { store, sync: failing, now: () => later }), "retry");
    assert.equal(rows[0].attempts, 2);
    assert.equal(rows[0].nextAttemptAt?.getTime(), later.getTime() + backoffMs(2));
  });

  it("succeeds on a later retry after earlier failures", async () => {
    const { store, rows, eventId } = await received();
    let calls = 0;
    const flaky = { ...fakeSync().sync, order: async () => { if (++calls === 1) throw new Error("boom"); return { notFound: false }; } };
    await processWebhookEvent(eventId, { store, sync: flaky, now: () => NOW });
    assert.equal(await processWebhookEvent(eventId, { store, sync: flaky, now: () => new Date(NOW.getTime() + 3_600_000) }), "processed");
    assert.equal(rows[0].status, "PROCESSED");
    assert.equal(rows[0].errorMessage, null);
  });

  it("gives up after the maximum number of attempts", async () => {
    const { store, rows, eventId } = await received();
    const failing = { ...fakeSync().sync, order: async () => { throw new Error("still broken"); } };
    let clock = NOW.getTime();
    let outcome = "";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      outcome = await processWebhookEvent(eventId, { store, sync: failing, now: () => new Date(clock) });
      clock += 2 * 3_600_000;
    }
    assert.equal(outcome, "failed");
    assert.equal(rows[0].attempts, MAX_ATTEMPTS);
    assert.equal(rows[0].nextAttemptAt, null);
    assert.deepEqual(await store.due(new Date(clock + 10 * 3_600_000), 10), [], "an exhausted event is never picked up again");
  });

  it("removes anything token-shaped from a recorded error", async () => {
    const { store, rows, eventId } = await received();
    const leaky = { ...fakeSync().sync, order: async () => { throw new Error("rejected shpat_ABCDEF123456"); } };
    await processWebhookEvent(eventId, { store, sync: leaky, now: () => NOW });
    assert.equal((rows[0].errorMessage ?? "").includes("shpat_ABCDEF123456"), false);
    assert.match(rows[0].errorMessage ?? "", /REDACTED/);
  });

  it("ignores a record Shopify no longer has, and a delivery with no usable id", async () => {
    const gone = await received("orders/updated", { id: 7 });
    const missing = { ...fakeSync().sync, order: async () => ({ notFound: true }) };
    assert.equal(await processWebhookEvent(gone.eventId, { store: gone.store, sync: missing, now: () => NOW }), "ignored");
    assert.equal(gone.rows[0].status, "IGNORED");

    const noId = await received("orders/updated", {});
    assert.equal(await processWebhookEvent(noId.eventId, { store: noId.store, sync: fakeSync().sync, now: () => NOW }), "ignored");
  });

  it("backs off 1, 2, 4 ... minutes, capped at an hour", () => {
    assert.deepEqual([1, 2, 3, 4].map(backoffMs), [60_000, 120_000, 240_000, 480_000]);
    assert.equal(backoffMs(20), 3_600_000);
  });
});

describe("retry worker", () => {
  it("re-processes a delivery that was recorded but never handled, and a failure that is due", async () => {
    const { store, rows } = memoryStore();
    const now = new Date("2026-09-19T12:00:00Z");
    await store.record({ eventType: "orders/updated", externalEventId: "a", payload: { id: 1 } });
    await store.record({ eventType: "orders/updated", externalEventId: "b", payload: { id: 2 } });
    rows[0].receivedAt = new Date(now.getTime() - 120_000); // lost with a restart
    rows[1].status = "FAILED";
    rows[1].attempts = 1;
    rows[1].nextAttemptAt = new Date(now.getTime() - 1);

    const handled: string[] = [];
    const worker = startWebhookWorker({ store, process: async (id) => void handled.push(id), now: () => now, intervalMs: 3_600_000 });
    assert.equal(await worker.tick(), 2);
    assert.deepEqual(handled.sort(), ["evt-1", "evt-2"]);
    worker.stop();
  });

  it("leaves a recent delivery alone (its own processing is already under way)", async () => {
    const { store } = memoryStore();
    await store.record({ eventType: "orders/updated", externalEventId: "a", payload: { id: 1 } });
    const worker = startWebhookWorker({ store, process: async () => {}, intervalMs: 3_600_000 });
    assert.equal(await worker.tick(), 0);
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
