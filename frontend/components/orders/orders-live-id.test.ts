// Run with: ../backend/node_modules/.bin/tsx --test components/orders/orders-live-id.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLiveOrderId } from "@/lib/api-client/types/orders.types";

describe("parseLiveOrderId: every way of naming a Shopify order resolves to the same numeric id", () => {
  const ID = "18933143797949";
  it("shopify:<id>, its percent-encoded soft-navigation form, a bare numeric id and the full GID", () => {
    assert.equal(parseLiveOrderId(`shopify:${ID}`), ID);
    assert.equal(parseLiveOrderId(`shopify%3A${ID}`), ID);
    assert.equal(parseLiveOrderId(ID), ID);
    assert.equal(parseLiveOrderId(`gid://shopify/Order/${ID}`), ID);
    assert.equal(parseLiveOrderId(encodeURIComponent(`gid://shopify/Order/${ID}`)), ID);
    assert.equal(parseLiveOrderId(`shopify:gid://shopify/Order/${ID}`), ID);
  });
  it("a CRM order id (UUID) is never taken for a Shopify order; malformed input is not a live id", () => {
    assert.equal(parseLiveOrderId("3f2b8c1e-5a4d-4e7b-9c1a-0d2e4f6a8b10"), null);
    assert.equal(parseLiveOrderId("gid://shopify/Product/5"), null);
    assert.equal(parseLiveOrderId("%E0%A4%A"), null);
    assert.equal(parseLiveOrderId(""), null);
  });
});
