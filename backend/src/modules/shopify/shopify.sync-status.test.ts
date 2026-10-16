import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSyncError, syncAdvice } from "./shopify.sync-status.js";
import { compareShopifyOrder, type ShopifyOrderCreateInput } from "./shopify.orders.write.js";

test("errors are shown without tokens, URLs or credentials", () => {
  const e = new Error("401 for https://store.myshopify.com/admin/api with token shpat_abc123 and Authorization: Bearer xyz");
  const out = sanitizeSyncError(e);
  assert.ok(!/shpat_|https?:|Bearer xyz/.test(out), out);
  assert.ok(out.length <= 240);
});

test("advice: nothing to do, re-syncable fields, or an administrator's decision", () => {
  assert.equal(syncAdvice([], []), "NONE");
  assert.equal(syncAdvice(["shippingAddress", "tags"], []), "RETRY");
  assert.equal(syncAdvice([], ["customer not associated: ambiguous"]), "ADMIN");
  assert.equal(syncAdvice(["lineItems.requiresShipping"], []), "ADMIN");
});

test("totals are compared to the cent when they are supposed to match", () => {
  const input = { lineItems: [{ variantId: "1", quantity: 1 }], currency: "INR", financialStatus: "PENDING" } as ShopifyOrderCreateInput;
  const base = { id: "x", note: null, tags: [], displayFinancialStatus: "Pending", customer: null, shippingAddress: null, lineItems: { nodes: [] }, metafields: { nodes: [] } };
  assert.deepEqual(compareShopifyOrder(input, { ...base, totalPriceSet: { shopMoney: { amount: "1248.0" } } } as never, "1248.00").missing, []);
  assert.deepEqual(compareShopifyOrder(input, { ...base, totalPriceSet: { shopMoney: { amount: "1298.0" } } } as never, "1248.00").missing, ["totals"]);
  assert.deepEqual(compareShopifyOrder(input, { ...base, totalPriceSet: { shopMoney: { amount: "9" } } } as never).missing, [], "not checked when the totals are not mirrored");
});
