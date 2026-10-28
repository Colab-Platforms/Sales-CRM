import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSameCheckoutReentry } from "./shiprocket.abandonment.processor.js";
import { cartItemsKey } from "../../lib/checkoutCartKey.js";

const line = (name: string, quantity = 1) => ({ name, quantity, variantId: `v-${name}`, sku: `sku-${name}`, productId: `p-${name}` });
const cart = (names: string[], cartValue: unknown, quantities: number[] = []) => ({ items: names.map((n, i) => line(n, quantities[i] ?? 1)), itemNames: names.slice(0, 3), itemCount: names.length, cartValue });

describe("same checkout entered again (new cart id, same customer): full item list", () => {
  it("same items and value match, whatever the order or number formatting", () => {
    assert.equal(isSameCheckoutReentry(cart(["Paan"], 499), cart(["Paan"], "499")), true);
    assert.equal(isSameCheckoutReentry(cart(["A", "B"], 998), cart(["B", "A"], "998.00")), true);
  });
  it("REGRESSION: two carts sharing their first three products and the total value but with different fourth products are separate", () => {
    const a = cart(["P1", "P2", "P3", "P4-Paan"], 1996);
    const b = cart(["P1", "P2", "P3", "P4-Gutka"], 1996);
    assert.deepEqual(a.itemNames, b.itemNames, "the 3-name display field is identical");
    assert.equal(isSameCheckoutReentry(a, b), false);
    assert.equal(isSameCheckoutReentry(a, cart(["P1", "P2", "P3", "P4-Paan"], 1996)), true, "while the identical 4-product cart still matches");
  });
  it("a different product, value or quantity is a separate checkout", () => {
    assert.equal(isSameCheckoutReentry(cart(["Paan"], 499), cart(["Gutka"], 499)), false);
    assert.equal(isSameCheckoutReentry(cart(["Paan"], 499), cart(["Paan"], 998)), false);
    assert.equal(isSameCheckoutReentry(cart(["Paan"], 499, [1]), cart(["Paan"], 499, [2])), false);
  });
  it("missing items, missing value, or display names that may be truncated are never merged", () => {
    assert.equal(isSameCheckoutReentry({ items: [], itemNames: [], itemCount: 0, cartValue: 499 }, { items: [], itemNames: [], itemCount: 0, cartValue: 499 }), false);
    assert.equal(isSameCheckoutReentry(cart(["A"], null), cart(["A"], null)), false);
    assert.equal(isSameCheckoutReentry(undefined, cart(["A"], 1)), false);
    // no full list saved and 4 items but only 3 names shown: contents cannot be compared
    const truncated = { itemNames: ["P1", "P2", "P3"], itemCount: 4, cartValue: 1996 };
    assert.equal(cartItemsKey(truncated), null);
    assert.equal(isSameCheckoutReentry(truncated, truncated), false);
    // complete names without the full list are fine
    assert.notEqual(cartItemsKey({ itemNames: ["P1"], itemCount: 1 }), null);
  });
});
