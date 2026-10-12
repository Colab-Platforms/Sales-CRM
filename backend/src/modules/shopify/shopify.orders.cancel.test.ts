// Pure unit tests for cancelShopifyOrder: the "client" is a fake, so no real Shopify order is ever cancelled by this file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";
import { cancelShopifyOrder, ShopifyOrderCancelError } from "./shopify.orders.write.js";

const NUMERIC = "18929899962557";
const GID = `gid://shopify/Order/${NUMERIC}`;

interface Call { document: string; variables: Record<string, unknown> }
function fake(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = { query: async (document: string, variables: Record<string, unknown>) => { const call = { document, variables }; calls.push(call); return answer(call); } } as unknown as ShopifyClient;
  return { client, calls, mutations: () => calls.filter((c) => /orderCancel\(/.test(c.document)) };
}
const open = (c: Call) => (/crmOrderCancelState/.test(c.document) ? { order: { id: GID, cancelledAt: null } } : { orderCancel: { job: { id: "j", done: true }, orderCancelUserErrors: [] } });

describe("cancelShopifyOrder: the id sent to orderCancel($orderId: ID!)", () => {
  it("a NUMERIC id (what the CRM stores) is sent as the GID - never the bare number that made Shopify answer INVALID_VARIABLE", async () => {
    const f = fake(open);
    await cancelShopifyOrder(f.client, NUMERIC);
    assert.equal(f.mutations().length, 1);
    assert.equal(f.mutations()[0]!.variables.orderId, GID);
  });
  it("a GID (legacy rows) is sent unchanged, never double-prefixed", async () => {
    const f = fake(open);
    await cancelShopifyOrder(f.client, GID);
    assert.equal(f.mutations()[0]!.variables.orderId, GID);
  });
  it("surrounding whitespace is tolerated; junk or another GID type is refused before Shopify is called", async () => {
    const f = fake(open);
    await cancelShopifyOrder(f.client, `  ${NUMERIC} `);
    assert.equal(f.mutations()[0]!.variables.orderId, GID);
    for (const bad of ["", "abc", "gid://shopify/Product/1", "gid://shopify/Order/gid://shopify/Order/1"]) {
      const g = fake(open);
      await assert.rejects(cancelShopifyOrder(g.client, bad), ShopifyOrderCancelError, bad);
      assert.equal(g.calls.length, 0, `Shopify must not be called for "${bad}"`);
    }
  });
});

describe("cancelShopifyOrder: retry safety", () => {
  it("Shopify already shows the order cancelled -> success without sending the mutation (idempotent)", async () => {
    const f = fake((c) => (/crmOrderCancelState/.test(c.document) ? { order: { id: GID, cancelledAt: "2026-10-08T10:00:00Z" } } : (() => { throw new Error("must not cancel twice"); })()));
    const r = await cancelShopifyOrder(f.client, NUMERIC);
    assert.equal(r.cancelledAt, "2026-10-08T10:00:00Z");
    assert.equal(f.mutations().length, 0);
  });
  it("only cancels - never refunds, restocks or emails", async () => {
    const f = fake(open);
    await cancelShopifyOrder(f.client, NUMERIC);
    assert.deepEqual([f.mutations()[0]!.variables.refund, f.mutations()[0]!.variables.restock, f.mutations()[0]!.variables.notifyCustomer], [false, false, false]);
  });
  it("a genuine Shopify error is preserved unchanged (user errors and GraphQL errors)", async () => {
    const userErr = fake((c) => (/crmOrderCancelState/.test(c.document) ? { order: { id: GID, cancelledAt: null } } : { orderCancel: { job: null, orderCancelUserErrors: [{ field: ["orderId"], message: "Cannot cancel a fulfilled order" }] } }));
    await assert.rejects(cancelShopifyOrder(userErr.client, NUMERIC), /Cannot cancel a fulfilled order/);
    const gqlErr = fake((c) => { if (/crmOrderCancelState/.test(c.document)) return { order: null }; throw new ShopifyGraphQLError("Shopify GraphQL error: access denied", []); });
    await assert.rejects(cancelShopifyOrder(gqlErr.client, NUMERIC), /access denied/);
  });
  it("a failing state read never blocks the cancellation", async () => {
    const f = fake((c) => { if (/crmOrderCancelState/.test(c.document)) throw new Error("read failed"); return { orderCancel: { job: { id: "j", done: true }, orderCancelUserErrors: [] } }; });
    await cancelShopifyOrder(f.client, NUMERIC);
    assert.equal(f.mutations().length, 1);
  });
});
