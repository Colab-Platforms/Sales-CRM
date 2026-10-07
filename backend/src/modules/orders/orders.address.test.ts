import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCreateManualOrder } from "./orders.validators.js";

const LEAD = "0b5a7b6e-3c1d-4d6a-8f21-1c2d3e4f5a6b";
const PRODUCT = "1b5a7b6e-3c1d-4d6a-8f21-1c2d3e4f5a6b";
const body = (shippingAddress?: Record<string, unknown>) => ({
  leadId: LEAD,
  items: [{ productId: PRODUCT, quantity: 1, unitPrice: "1249.00" }],
  paymentMethod: "COD",
  ...(shippingAddress ? { shippingAddress } : {}),
});
const full = {
  name: "Asha Verma", phone: "9000000123",
  line1: "Flat 4B, Sunrise Apartments", line2: "MG Road, Near City Mall",
  houseNumber: "Flat 4B", building: "Sunrise Apartments", area: "Andheri West", street: "MG Road", landmark: "Near City Mall",
  city: "Mumbai", state: "Maharashtra", pincode: "400053", addressType: "HOME",
};
const check = (a?: Record<string, unknown>) => {
  const r = validateCreateManualOrder(body(a));
  return { ...r, error: r.error ?? undefined }; // the validator returns null when valid
};
const messages = (a: Record<string, unknown>) => String(check(a).error?.message ?? "");

describe("create-order structured address validation (server side)", () => {
  it("valid complete address, every address type, optional fields omitted", () => {
    assert.equal(check(full).error, undefined);
    for (const addressType of ["HOME", "WORK", "OTHER"]) assert.equal(check({ ...full, addressType }).error, undefined, addressType);
    const minimal = { line1: "12/A", houseNumber: "12/A", area: "Sector 5", city: "Pune", state: "Maharashtra", pincode: "411001" };
    assert.equal(check(minimal).error, undefined);
  });
  it("legitimate Indian formatting passes: slashes, dashes, commas, numbers", () => {
    assert.equal(check({ ...full, houseNumber: "No. 12/3-B, 2nd Floor", line1: "No. 12/3-B, 2nd Floor", area: "4th Cross, J.P. Nagar 2nd Phase" }).error, undefined);
  });
  it("legacy callers that send only line1/line2/city/state/pincode still work (no structured fields)", () => {
    assert.equal(check({ line1: "123 Main St", line2: "Near Park", city: "Mumbai", state: "Maharashtra", pincode: "400001" }).error, undefined);
  });
  it("no shippingAddress at all still validates (unchanged behaviour)", () => {
    assert.equal(check().error, undefined);
  });
  it("pincode: fewer than 6, more than 6, alphabetic, leading zero are rejected", () => {
    for (const pincode of ["4000", "4000011", "40000A", "ABCDEF", "012345"]) assert.match(messages({ ...full, pincode }), /6-digit/, pincode);
  });
  it("empty house number, locality, city or state are rejected with the field's own message", () => {
    assert.match(messages({ ...full, houseNumber: "", line1: "" }), /House \/ Flat/);
    assert.match(messages({ ...full, area: "" }), /Area \/ Locality/);
    assert.match(messages({ ...full, city: "" }), /City is required/);
    assert.match(messages({ ...full, state: "" }), /State is required/);
  });
  it("whitespace-only and punctuation-only values count as empty", () => {
    assert.match(messages({ ...full, houseNumber: "   ", line1: "  " }), /House \/ Flat/);
    assert.match(messages({ ...full, area: "   " }), /Area \/ Locality/);
    assert.match(messages({ ...full, city: " \t " }), /City is required/);
    assert.match(messages({ ...full, area: "-" }), /Area \/ Locality/);
  });
  it("an unknown address type is rejected", () => {
    assert.match(messages({ ...full, addressType: "OFFICE" }), /HOME, WORK or OTHER/);
  });
  it("surrounding whitespace is trimmed", () => {
    const r = check({ ...full, city: "  Mumbai  ", area: "  Andheri West " });
    assert.equal(r.error, undefined);
    assert.equal(r.value?.shippingAddress?.city, "Mumbai");
    assert.equal(r.value?.shippingAddress?.area, "Andheri West");
  });
});
