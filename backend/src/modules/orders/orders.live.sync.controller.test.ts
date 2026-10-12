// POST /orders/live/:externalId/sync - request handling only (no Shopify, no database). The id the live page carries (digits of the Shopify order GID) must reach
// the sync service untouched; anything that is not exactly such an id must never reach it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import type { AuthRequest } from "@/middlewares/auth.js";
import { isShopifyOrderId, makeSyncLiveOrder } from "./orders.live.controller.js";
import type { LiveOrderSyncResult } from "./orders.live.types.js";

// Ids of the real shape Shopify uses (13-16 digits), including one with a leading digit pattern like the live page's.
const REAL_STYLE_IDS = ["6571234567890", "5834512398765", "1", "10000000000000000000"];

function call(externalId: string | undefined, result: LiveOrderSyncResult | Error = { synced: true, orderId: "crm-1", action: "created" }) {
  const seen: string[] = [];
  const service = { syncLiveOrderToCrm: async (_user: unknown, id: string) => { seen.push(id); if (result instanceof Error) throw result; return result; } };
  const out: { status?: number; body?: any } = {};
  const res = { status: (s: number) => ({ json: (b: unknown) => { out.status = s; out.body = b; } }) } as unknown as Response;
  const req = { params: externalId === undefined ? {} : { externalId }, user: { id: "u1", role: "ADMIN", username: "admin1" } } as unknown as AuthRequest;
  return makeSyncLiveOrder(service as never)(req, res).then(() => ({ seen, ...out }));
}

describe("the live-order sync id check", () => {
  it("accepts exactly the digits of a Shopify order id", () => {
    for (const id of REAL_STYLE_IDS) assert.equal(isShopifyOrderId(id), true, id);
  });
  it("accepts nothing else (no prefixes, GIDs, names, spaces, signs, wildcards or over-long input)", () => {
    for (const id of ["", "shopify:6571234567890", "gid://shopify/Order/6571234567890", "AWL101729", "#AWL101729", "6571234567890 ", " 6571234567890", "-1", "1.5", "12ab", "d", "ddd", "123456789012345678901", "6571234567890\n", "%36571"]) {
      assert.equal(isShopifyOrderId(id), false, JSON.stringify(id));
    }
  });
});

describe("POST /orders/live/:externalId/sync handler", () => {
  it("a numeric Shopify order id (what the live page sends) reaches the sync service exactly as given and succeeds", async () => {
    for (const id of REAL_STYLE_IDS) {
      const r = await call(id);
      assert.deepEqual(r.seen, [id], id);
      assert.equal(r.status, 200, id);
      assert.deepEqual([r.body.success, r.body.data.orderId, r.body.data.action], [true, "crm-1", "created"]);
    }
  });
  it("a malformed id is refused as 'Order not found' WITHOUT reaching the service", async () => {
    for (const id of ["shopify:6571234567890", "gid://shopify/Order/1", "AWL101729", "12ab", undefined]) {
      const r = await call(id);
      assert.deepEqual([r.status, r.body.message, r.seen.length], [404, "Order not found", 0], String(id));
    }
  });
  it("service outcomes map to honest statuses: not-admin 404, Shopify/other problems 400 with the reason, unexpected errors 500", async () => {
    assert.deepEqual(await call("123", { synced: false, reason: "Not found" }).then((r) => [r.status, r.body.message]), [404, "Not found"]);
    assert.deepEqual(await call("123", { synced: false, reason: "Shopify no longer has this order." }).then((r) => [r.status, r.body.message]), [400, "Shopify no longer has this order."]);
    assert.equal((await call("123", new Error("boom"))).status, 500);
  });
});
