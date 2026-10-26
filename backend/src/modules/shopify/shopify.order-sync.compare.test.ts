import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addressDifferences, categoryOf, stateToken } from "./shopify.order-sync.compare.js";

describe("sync comparison rules", () => {
  const crm = { name: "Anil Kumar Verma", line1: "Flat 7, Green Heights", line2: "Baner Road", city: "Pune", state: "Maharashtra", pincode: "411045" };
  const shop = { firstName: "Anil Kumar", lastName: "Verma", line1: "Flat 7, Green Heights", line2: "Baner Road", city: "Pune", provinceCode: "MH", pincode: "411045" };

  it("the same address written two ways is no difference (state name vs province code, full name vs first + last, case and spacing)", () => {
    assert.deepEqual(addressDifferences(crm, shop), []);
    assert.deepEqual(addressDifferences({ ...crm, line1: "  flat 7,  GREEN heights " }, shop), []);
  });

  it("names exactly which parts differ", () => {
    assert.deepEqual(addressDifferences({ ...crm, pincode: "411046", city: "Mumbai" }, shop).sort(), ["PIN code", "city"]);
    assert.deepEqual(addressDifferences({ ...crm, state: "Karnataka" }, shop), ["state"]);
    assert.deepEqual(addressDifferences({ ...crm, name: "Someone Else" }, shop), ["recipient name"]);
    assert.deepEqual(addressDifferences(crm, null), ["no shipping address in Shopify"]);
    assert.deepEqual(addressDifferences(null, shop), [], "no CRM address: nothing to push");
  });

  it("a one-word recipient (stored in Shopify as the last name) matches; a blank CRM line never counts as a difference", () => {
    assert.deepEqual(addressDifferences({ ...crm, name: "Radhe" }, { ...shop, firstName: "", lastName: "Radhe" }), []);
    assert.deepEqual(addressDifferences({ ...crm, line2: "" }, shop), []);
  });

  it("categories: nothing different = SYNCED even for a cancelled / fulfilled order; money outranks everything; restricted states are CONFLICT; clean differences are the safe repairs", () => {
    const base = { money: null, customerIssue: null, reviewReasons: [] as string[], addressDiffers: false };
    assert.equal(categoryOf(base), "SYNCED");
    assert.equal(categoryOf({ ...base, reviewReasons: ["cancelled", "fulfilment: fulfilled"] }), "SYNCED");
    assert.equal(categoryOf({ ...base, money: { kind: "x" }, reviewReasons: ["cancelled"] }), "FINANCIAL");
    assert.equal(categoryOf({ ...base, customerIssue: "NO_CUSTOMER", reviewReasons: ["fulfilment: fulfilled"] }), "CONFLICT");
    assert.equal(categoryOf({ ...base, reviewReasons: ["payment state differs (CRM unpaid, Shopify paid)"] }), "CONFLICT");
    assert.equal(categoryOf({ ...base, customerIssue: "NO_CUSTOMER" }), "SAFE_CUSTOMER");
    assert.equal(categoryOf({ ...base, addressDiffers: true }), "SAFE_ADDRESS");
  });

  it("the state token is stable for the same facts and changes when any compared fact changes", () => {
    const a = { crm: { total: 69900, addr: "x" }, shop: { total: 64900 } };
    assert.equal(stateToken(a), stateToken(JSON.parse(JSON.stringify(a))));
    assert.notEqual(stateToken(a), stateToken({ ...a, shop: { total: 69900 } }));
  });
});
