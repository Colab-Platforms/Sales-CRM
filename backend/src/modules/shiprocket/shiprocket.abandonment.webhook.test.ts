import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { handleAbandonmentWebhook } from "./shiprocket.abandonment.webhook.handler.js";

const SECRET = "test-secret";
const headers = { "x-webhook-secret": SECRET };
const body = (over: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ cart_id: "cart-1", phone_number: "9876543210", first_name: "Ram", ...over }));

describe("abandon-cart webhook delivery idempotency", () => {
  it("an identical retried delivery is acknowledged but scheduled for processing only once", async () => {
    const store = memoryStore();
    const scheduled: string[] = [];
    const deps = { config: { secret: SECRET }, store: store.store, schedule: (id: string) => void scheduled.push(id) };

    const first = await handleAbandonmentWebhook({ rawBody: body(), headers }, deps);
    const retry = await handleAbandonmentWebhook({ rawBody: body(), headers }, deps);

    assert.equal(first.message, "Received");
    assert.equal(retry.message, "Duplicate delivery ignored");
    assert.equal(retry.status, 200, "still a 2xx so the sender stops retrying");
    assert.equal(scheduled.length, 1);
  });

  it("a delivery with a changed body (e.g. a later cart stage) is a new event - the cart-id dedupe in the processor handles it", async () => {
    const store = memoryStore();
    const scheduled: string[] = [];
    const deps = { config: { secret: SECRET }, store: store.store, schedule: (id: string) => void scheduled.push(id) };

    await handleAbandonmentWebhook({ rawBody: body({ stage: "address" }), headers }, deps);
    await handleAbandonmentWebhook({ rawBody: body({ stage: "payment" }), headers }, deps);

    assert.equal(scheduled.length, 2);
  });

  it("an unauthenticated delivery records nothing", async () => {
    const store = memoryStore();
    const scheduled: string[] = [];
    const res = await handleAbandonmentWebhook({ rawBody: body(), headers: {} }, { config: { secret: SECRET }, store: store.store, schedule: (id) => void scheduled.push(id) });
    assert.equal(res.status, 401);
    assert.equal(scheduled.length, 0);
  });
});
