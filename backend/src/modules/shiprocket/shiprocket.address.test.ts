// Run with: npx tsx --test src/modules/shiprocket/shiprocket.address.test.ts   (no database, no Shiprocket)
// Regression: an address saved by the CRM's own forms (line1 / line2 / state / pincode) was reported as "missing: shipping address line, state, 6-digit pincode", because the Shiprocket mapping
// only read the Shopify names (address1 / province / zip). These tests pin the real saved shapes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePincode, readShipToAddress } from "./shiprocket.address.js";
import { buildShiprocketOrder } from "./shiprocket.shipments.service.js";
import { ORDER } from "./shiprocket.testutil.js";

const DIMS = { weight: 0.5, length: 10, breadth: 10, height: 5 };
// exactly what the order address editor saves for the address in the bug report
const EDITED = { line1: "Flat 101, Sunshine Apartments", line2: "Link Road, Near City Mall", city: "Mumbai", state: "Maharashtra", pincode: "400017" };
const build = (shippingAddress: unknown, shippingPincode: string | null = null) =>
  buildShiprocketOrder({ ...ORDER, shippingAddress, shippingPincode, placedAt: ORDER.placedAt, items: ORDER.items } as never, DIMS, "warehouse", ORDER.orderNumber).request;
const missingOf = (shippingAddress: unknown, shippingPincode: string | null = null): string => {
  try { build(shippingAddress, shippingPincode); } catch (e) { return (e as Error).message; }
  return "";
};

describe("the address the CRM order editor saves reaches Shiprocket", () => {
  it("the exact address from the bug report passes validation and is mapped field for field", () => {
    const r = build({ name: "Priya Shah", phone: "9876500000", ...EDITED });
    assert.equal(r.billing_address, "Flat 101, Sunshine Apartments");
    assert.equal(r.billing_address_2, "Link Road, Near City Mall");
    assert.equal(r.billing_city, "Mumbai");
    assert.equal(r.billing_state, "Maharashtra");
    assert.equal(r.billing_pincode, "400017");
    assert.equal(typeof r.billing_pincode, "string");
    assert.equal(r.billing_country, "India");
    assert.equal(r.shipping_is_billing, true);
  });

  it("address line 2 is optional and is simply left out when there is none", () => {
    const r = build({ ...EDITED, line2: "" });
    assert.equal("billing_address_2" in r, false);
  });

  it("the Shopify-synced shape (address1 / province / zip) still works exactly as before", () => {
    const r = build({ address1: "12 MG Road", address2: "Near park", city: "Pune", province: "Maharashtra", zip: "411001" });
    assert.deepEqual([r.billing_address, r.billing_address_2, r.billing_city, r.billing_state, r.billing_pincode], ["12 MG Road", "Near park", "Pune", "Maharashtra", "411001"]);
  });

  it("a provider-wrapped address is read too", () => {
    assert.equal(build({ shippingAddress: EDITED }).billing_pincode, "400017");
  });
});

describe("missing parts are rejected and named exactly - no dummy values", () => {
  it("each of address line, city, state and pincode on its own", () => {
    assert.match(missingOf({ ...EDITED, line1: "" }), /missing: shipping address line 1(?!.*(city|state|pincode))/);
    assert.match(missingOf({ ...EDITED, city: "" }), /missing: city(?!.*(address line|state|pincode))/);
    assert.match(missingOf({ ...EDITED, state: "" }), /missing: state(?!.*(address line|city|pincode))/);
    assert.match(missingOf({ ...EDITED, pincode: "" }), /missing: 6-digit pincode(?!.*(address line|city|state))/);
  });

  it("all of them together, and an empty or absent address", () => {
    for (const empty of [{}, null, undefined, "", { line1: "   ", city: " " }]) {
      const m = missingOf(empty);
      for (const part of ["shipping address line 1", "city", "state", "6-digit pincode"]) assert.ok(m.includes(part), `${JSON.stringify(empty)} -> ${m}`);
    }
  });

  it("a malformed pincode is reported with the saved value, never fixed up", () => {
    assert.match(missingOf({ ...EDITED, pincode: "4000" }), /6-digit pincode \(the saved value "4000" is not 6 digits\)/);
    assert.match(missingOf({ ...EDITED, pincode: "abcdef" }), /not 6 digits/);
    assert.match(missingOf({ ...EDITED, pincode: 40001 }), /not 6 digits/, "a number that lost its leading digits is rejected, not zero-padded");
  });

  it("the order's saved pincode column is a fallback only when the address carries no pincode at all", () => {
    assert.equal(build({ ...EDITED, pincode: undefined }, "400017").billing_pincode, "400017");
    assert.match(missingOf({ ...EDITED, pincode: "4000" }, "400017"), /not 6 digits/);
  });
});

describe("pincode is always a six-digit string", () => {
  it("keeps a leading zero, tolerates spaces and dashes, rejects anything that is not six digits", () => {
    assert.equal(normalizePincode("011001"), "011001");
    assert.equal(normalizePincode("400 017"), "400017");
    assert.equal(normalizePincode("400-017"), "400017");
    assert.equal(normalizePincode(400017), "400017");
    for (const bad of ["", "4000", "4000170", "40001a", null, undefined, 11001, 4000.5]) assert.equal(normalizePincode(bad), "", String(bad));
    assert.equal(build({ ...EDITED, pincode: "011001" }).billing_pincode, "011001");
  });
});

describe("older shapes and the structured parts", () => {
  it("an order with no line 1 but saved house number / building / street / area uses those saved parts", () => {
    const r = readShipToAddress({ houseNumber: "Flat 101", building: "Sunshine Apartments", area: "Dadar", city: "Mumbai", state: "Maharashtra", pincode: "400017" }, null);
    assert.ok(r.ok && r.address.line1 === "Flat 101, Sunshine Apartments, Dadar");
  });
  it("a plain string address is a line 1 (the other parts are still required)", () => {
    const r = readShipToAddress("Flat 101, Sunshine Apartments", null);
    assert.ok(!r.ok && !r.missing.includes("shipping address line 1") && r.missing.includes("city"));
  });
});
