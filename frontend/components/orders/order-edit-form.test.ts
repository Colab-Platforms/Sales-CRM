import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addressDraft, validateAddressDraft } from "./order-edit-form";

describe("order address edit form", () => {
  it("is pre-filled from the stored address, falling back to the order pincode", () => {
    assert.deepEqual(addressDraft({ shippingAddress: { name: "Meera Rao", line1: "Flat 9", city: "Pune", state: "Maharashtra", pincode: "411045" }, shippingPincode: "411001" }), { name: "Meera Rao", phone: "", line1: "Flat 9", line2: "", city: "Pune", state: "Maharashtra", pincode: "411045" });
    assert.equal(addressDraft({ shippingAddress: null, shippingPincode: "411001" }).pincode, "411001");
  });
  it("requires the same fields the server does", () => {
    const ok = { line1: "Flat 9", city: "Pune", state: "Maharashtra", pincode: "411045" };
    assert.equal(validateAddressDraft(ok), null);
    assert.match(validateAddressDraft({ ...ok, line1: " " }) ?? "", /House/);
    assert.match(validateAddressDraft({ ...ok, city: "" }) ?? "", /City/);
    assert.match(validateAddressDraft({ ...ok, state: "" }) ?? "", /State/);
    assert.match(validateAddressDraft({ ...ok, pincode: "12345" }) ?? "", /6-digit/);
    assert.match(validateAddressDraft({ ...ok, pincode: "012345" }) ?? "", /6-digit/);
  });
});
