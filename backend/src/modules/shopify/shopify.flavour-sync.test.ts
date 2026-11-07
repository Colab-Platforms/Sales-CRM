// Run with: npx tsx --test src/modules/shopify/shopify.flavour-sync.test.ts
// What the Shopify -> CRM sync (mapOrder) sees AFTER a CRM flavour change, as Shopify returns it: the removed old line stays with its original quantity and currentQuantity 0, the new variant line
// is at the CURRENT catalogue price, and the agreed price is kept by a line discount when the catalogue is higher. A LOWER catalogue price is refused by the CRM before any edit (an extra "Price adjustment" line would reach Shiprocket as a phantom item).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { money, normalized, orderNode, rawLineItem } from "./shopify.fixtures.js";
import { mapOrder } from "./shopify.mapper.js";

const OLD = { id: "gid://shopify/LineItem/1", quantity: 2, currentQuantity: 0, variant: { id: "gid://shopify/ProductVariant/OLD" }, sku: "OLD-SKU", variantTitle: "Gutka Flavour", originalUnitPriceSet: money("649.0") };
const NEW = (price: string, extra: Record<string, unknown> = {}) => ({ id: "gid://shopify/LineItem/2", quantity: 2, currentQuantity: 2, variant: { id: "gid://shopify/ProductVariant/NEW" }, sku: "NEW-SKU", variantTitle: "Paan Masala Flavour", originalUnitPriceSet: money(price), ...extra });
const order = (nodes: unknown[], over: Record<string, unknown> = {}) =>
  mapOrder(normalized(orderNode({ subtotalPriceSet: money("1298.0"), totalPriceSet: money("1298.0"), totalDiscountsSet: money("0.0"), lineItems: { pageInfo: { hasNextPage: false }, nodes: nodes.map((n) => rawLineItem(n as never)) }, ...over })));

describe("the CRM refresh after a flavour change", () => {
  it("equal price: the removed old flavour is NOT brought back; the new flavour/SKU are what the CRM shows; totals reconcile", () => {
    const m = order([OLD, NEW("649.0")]);
    assert.deepEqual(m.items.map((i) => [i.sku, i.quantity, i.unitPrice]), [["NEW-SKU", 2, "649.00"]]);
    assert.deepEqual([m.subtotal, m.discountAmount, m.totalAmount], ["1298.00", "0.00", "1298.00"]);
    assert.equal(m.warnings.some((w) => /do not reconcile/.test(w)), false);
  });

  it("catalogue HIGHER (799): the line shows the catalogue price with the kept-price discount; the order total is unchanged and still reconciles", () => {
    const m = order([OLD, NEW("799.0", { discountAllocations: [{ allocatedAmountSet: money("300.0") }] })], { totalDiscountsSet: money("300.0") });
    assert.deepEqual(m.items.map((i) => [i.sku, i.quantity, i.unitPrice, i.discountAmount, i.totalPrice]), [["NEW-SKU", 2, "799.00", "300.00", "1298.00"]]);
    assert.equal(m.totalAmount, "1298.00");
    assert.equal(m.warnings.some((w) => /do not reconcile/.test(w)), false);
    // LIMITATION (documented): the CRM order now shows subtotal 1598 and discount 300 - the total is right, the split is Shopify's.
    assert.deepEqual([m.subtotal, m.discountAmount], ["1598.00", "300.00"]);
  });

  it("a refunded order keeps every line exactly as before (a removed and a refunded unit look the same, so nothing is dropped there)", () => {
    const m = order([OLD, NEW("649.0")], { totalRefundedSet: money("100.0") });
    assert.equal(m.items.length, 2);
  });

  it("a payload without currentQuantity (older shape) is read exactly as before", () => {
    const { currentQuantity: _a, ...old } = OLD;
    const { currentQuantity: _b, ...fresh } = NEW("649.0");
    assert.equal(order([old, fresh]).items.length, 2);
  });
});
