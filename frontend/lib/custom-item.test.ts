import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_ITEM_DEFAULTS, customDraftFromForm, customItemFlags, customItemRequest, customUnitWeightKg, isCustomLineValid, validateCustomItem } from "./custom-item";

const ok = { name: "Gift wrapping", price: "99.00", quantity: "2", physical: true, weight: "", weightUnit: "KG" as const };

describe("custom item form rules", () => {
  it("defaults are visible and sensible: not taxable (the CRM adds no tax), physical, kg, quantity 1", () => {
    assert.deepEqual(CUSTOM_ITEM_DEFAULTS, { name: "", price: "", quantity: "1", taxable: false, physical: true, weight: "", weightUnit: "KG" });
  });
  it("a valid item has no errors; a zero price is allowed; weight is optional", () => {
    assert.deepEqual(validateCustomItem(ok), {});
    assert.deepEqual(validateCustomItem({ ...ok, price: "0" }), {});
    assert.deepEqual(validateCustomItem({ ...ok, weight: "0.25" }), {});
  });
  it("each rule gives an understandable message: empty name, bad price, bad / excessive quantity, bad weight", () => {
    assert.match(validateCustomItem({ ...ok, name: "   " }).name!, /Enter the item name/);
    assert.match(validateCustomItem({ ...ok, name: "x".repeat(201) }).name!, /at most 200/);
    for (const p of ["", "-5", "abc", "1.234"]) assert.ok(validateCustomItem({ ...ok, price: p }).price, p);
    for (const q of ["", "0", "-1", "1.5", "abc"]) assert.match(validateCustomItem({ ...ok, quantity: q }).quantity!, /whole number of 1 or more/, q);
    assert.match(validateCustomItem({ ...ok, quantity: "1000" }).quantity!, /at most 999/);
    for (const w of ["abc", "0", "-2", "1.2345"]) assert.match(validateCustomItem({ ...ok, weight: w }).weight!, /Weight must be/, w);
    assert.match(validateCustomItem({ ...ok, weight: "2000000", weightUnit: "G" }).weight!, /too large/);
  });
  it("a non-physical item ignores any typed weight (it can never add to the parcel)", () => {
    assert.deepEqual(validateCustomItem({ ...ok, physical: false, weight: "abc" }), {});
    const draft = customDraftFromForm({ ...CUSTOM_ITEM_DEFAULTS, name: " Installation ", price: "300", physical: false, weight: "5" });
    assert.deepEqual([draft.name, draft.weight], ["Installation", ""]);
    assert.equal(customUnitWeightKg({ physical: false, weight: "5", weightUnit: "KG" }), null);
  });
  it("the request line has the custom type and fields, no product / variant, no computed totals", () => {
    const line = customItemRequest({ quantity: "3", unitPrice: " 199.50 ", custom: { name: "Gift", taxable: true, physical: true, weight: "250", weightUnit: "G" } });
    assert.deepEqual(line, { itemType: "CUSTOM", customName: "Gift", quantity: 3, unitPrice: "199.50", taxable: true, requiresShipping: true, weight: "250", weightUnit: "G" });
    assert.ok(!("productId" in line) && !("variantId" in line) && !("totalPrice" in line));
    assert.ok(!("weight" in customItemRequest({ quantity: "1", unitPrice: "1", custom: { name: "S", taxable: false, physical: false, weight: "", weightUnit: "KG" } })));
  });
  it("unit weight for the parcel estimate is normalised to kg; a missing weight is null, never a guess", () => {
    assert.equal(customUnitWeightKg({ physical: true, weight: "250", weightUnit: "G" }), 0.25);
    assert.equal(customUnitWeightKg({ physical: true, weight: "1.5", weightUnit: "KG" }), 1.5);
    assert.equal(customUnitWeightKg({ physical: true, weight: "", weightUnit: "KG" }), null);
  });
  it("a draft line is valid only when its own price / quantity pass; flags read well in lists", () => {
    const custom = { name: "Gift", taxable: false, physical: true, weight: "", weightUnit: "KG" as const };
    assert.equal(isCustomLineValid({ quantity: "2", unitPrice: "10", custom }), true);
    assert.equal(isCustomLineValid({ quantity: "0", unitPrice: "10", custom }), false);
    assert.equal(isCustomLineValid({ quantity: "2", unitPrice: "", custom }), false);
    assert.equal(customItemFlags({ taxable: true, requiresShipping: true, weightGrams: "250" }), "Custom item · Taxable · Physical · 250 g");
    assert.equal(customItemFlags({ taxable: false, requiresShipping: false, weightGrams: null }), "Custom item · Non-taxable · Not physical");
    assert.equal(customItemFlags({ taxable: false, requiresShipping: true, weightGrams: "1500" }), "Custom item · Non-taxable · Physical · 1.5 kg");
  });
});
