import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { creatorOf, creatorTagFor, isCreatorTag } from "./orders.creator-tag.js";

describe("creator tag naming", () => {
  it("'Order Created by <name>', commas and extra spaces cleaned, capped at Shopify's 40 characters", () => {
    assert.equal(creatorTagFor("Vini"), "Order Created by Vini");
    assert.equal(creatorTagFor("  Rahul,   Sharma "), "Order Created by Rahul Sharma");
    assert.ok(creatorTagFor("A".repeat(80)).length <= 40);
    assert.ok(isCreatorTag("order created by Vini"));
    assert.ok(!isCreatorTag("CRM Confirmed by Vini"));
  });
  it("creatorOf reads only a well-formed snapshot: nothing is guessed when the creator was not stored", () => {
    assert.deepEqual(creatorOf({ createdBy: { id: "u1", name: "Vini", role: "SALESPERSON" } }), { id: "u1", name: "Vini", role: "SALESPERSON" });
    assert.equal(creatorOf(null), null);
    assert.equal(creatorOf({}), null);
    assert.equal(creatorOf({ createdBy: { id: "u1", name: "  " } }), null);
    assert.equal(creatorOf({ createdBy: { name: "Vini" } }), null);
  });
});
