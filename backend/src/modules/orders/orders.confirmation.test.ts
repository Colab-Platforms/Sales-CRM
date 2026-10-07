import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIRMATION_TAG_PREFIX, confirmationTagFor, isConfirmationTag, planTagChange } from "./orders.confirmation.js";
import { isCodOrder } from "../shopify/shopify.mapper.js";

describe("tag format", () => {
  it("is exactly 'CRM Confirmed by <name>'", () => {
    assert.equal(CONFIRMATION_TAG_PREFIX, "CRM Confirmed by ");
    assert.equal(confirmationTagFor("Vini"), "CRM Confirmed by Vini");
    assert.equal(confirmationTagFor("  Rahul   Sharma "), "CRM Confirmed by Rahul Sharma");
  });
  it("is a valid Shopify tag: no commas, at most 40 characters (Shopify rejects longer tags - verified live)", () => {
    assert.equal(confirmationTagFor("Sharma, Rahul"), "CRM Confirmed by Sharma Rahul");
    assert.ok(confirmationTagFor("x".repeat(400)).length <= 40);
    assert.equal(confirmationTagFor("Priya Venkataraghavan Iyer").length, 40);
    assert.equal(confirmationTagFor("Rahul Sharma"), "CRM Confirmed by Rahul Sharma", "normal names are untouched");
    assert.ok(confirmationTagFor("Name With Trailing Gap Xyz   ").endsWith("Xyz") || !confirmationTagFor("Name With Trailing Gap Xyz   ").endsWith(" "));
  });
  it("recognises only its own tags", () => {
    assert.ok(isConfirmationTag("CRM Confirmed by Vini") && isConfirmationTag("crm confirmed by rahul"));
    for (const other of ["VIP", "COD", "Campaign-Diwali", "Confirmed", "Vini Confirmed", "CRM-Vini", "confirmed_by_vini"]) assert.equal(isConfirmationTag(other), false, other);
  });
});

describe("planTagChange never disturbs other tags", () => {
  const T = "CRM Confirmed by Vini";
  it("adds the tag next to the existing ones; removes nothing", () => {
    assert.deepEqual(planTagChange(["VIP", "COD", "Campaign-Diwali"], T), { add: [T], remove: [] });
    assert.deepEqual(planTagChange([], T), { add: [T], remove: [] });
  });
  it("already present (any case) -> nothing to do, so a re-run can never duplicate it", () => {
    assert.deepEqual(planTagChange(["VIP", T], T), { add: [], remove: [] });
    assert.deepEqual(planTagChange(["crm confirmed by vini"], T), { add: [], remove: [] });
  });
  it("a different confirmer replaces ONLY the old CRM tag", () => {
    assert.deepEqual(planTagChange(["VIP", "CRM Confirmed by Vini", "COD"], "CRM Confirmed by Rahul"), { add: ["CRM Confirmed by Rahul"], remove: ["CRM Confirmed by Vini"] });
    assert.deepEqual(planTagChange(["CRM Confirmed by Vini", "CRM Confirmed by Priya"], "CRM Confirmed by Rahul").remove, ["CRM Confirmed by Vini", "CRM Confirmed by Priya"]);
  });
});

describe("Shopify re-sync is not fooled by the CRM tag", () => {
  it("a telecaller called 'Cod' does not make an order look cash-on-delivery", () => {
    const base = { paymentGateways: ["razorpay"], transactions: [] } as never;
    assert.equal(isCodOrder({ ...(base as object), tags: ["CRM Confirmed by Cod"] } as never), false);
    assert.equal(isCodOrder({ ...(base as object), tags: ["COD"] } as never), true);
  });
});
