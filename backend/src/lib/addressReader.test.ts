import test from "node:test";
import assert from "node:assert/strict";
import { cleanPincode, cleanPlace, readAddressRecord, unwrapAddress } from "./addressReader.js";

test("reads the CRM shape, the Shopify shape and the Fastrr checkout shape into the same fields", () => {
  const crm = readAddressRecord({ name: "Asha", line1: "Flat 4B, Sunrise", line2: "MG Road", houseNumber: "Flat 4B", building: "Sunrise", area: "Andheri West", street: "MG Road", landmark: "Near Mall", city: "Mumbai", state: "Maharashtra", pincode: "400053", phone: "9000000123", addressType: "WORK" })!;
  assert.deepEqual([crm.houseNumber, crm.building, crm.area, crm.street, crm.landmark, crm.addressType, crm.pincode], ["Flat 4B", "Sunrise", "Andheri West", "MG Road", "Near Mall", "WORK", "400053"]);
  const shopify = readAddressRecord({ name: "Old", address1: "1 Old Rd", address2: "Floor 2", city: "Pune", province: "Maharashtra", zip: "411001", phone: "+919000000000" })!;
  assert.deepEqual([shopify.line1, shopify.line2, shopify.state, shopify.pincode], ["1 Old Rd", "Floor 2", "Maharashtra", "411001"]);
  const fastrr = readAddressRecord({ firstName: "Raj", lastName: "Singh", line1: "12 MG Road", line2: "Flat 4", landmark: "Near station", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", phone: "9769686444" })!;
  assert.deepEqual([fastrr.name, fastrr.landmark, fastrr.country], ["Raj Singh", "Near station", "India"]);
});

test("a provider-nested address is found at any of the usual wrappers, and with other field names", () => {
  for (const wrapper of ["shippingAddress", "shipping_address", "delivery_address", "address"]) {
    const a = readAddressRecord({ customer: "x", [wrapper]: { address_line_1: "7 Lake View", locality: "Powai", postal_code: "400076", city: "Mumbai", state: "Maharashtra" } })!;
    assert.deepEqual([a.line1, a.area, a.pincode], ["7 Lake View", "Powai", "400076"], wrapper);
  }
  assert.equal(unwrapAddress({ a: 1 })?.a, 1);
  const deep = readAddressRecord({ order: { shipping: { address: { addressLine1: "9 Hill Rd", zipcode: "560001", city: "Bengaluru", state: "Karnataka" } } } });
  assert.equal(deep, null, "an unknown outer key is not searched blindly");
  assert.equal(readAddressRecord({ shipping: { address: { addressLine1: "9 Hill Rd", zipcode: "560001", city: "Bengaluru", state: "Karnataka" } } })!.line1, "9 Hill Rd");
});

test("a plain-text address becomes line 1 rather than being dropped", () => {
  assert.equal(readAddressRecord("221B Baker Street")!.line1, "221B Baker Street");
});

test("apartment, landmark and delivery instructions are kept", () => {
  const a = readAddressRecord({ line1: "Tower 3, Flat 904", apartment: "904", landmark: "Opp. metro", delivery_instructions: "Leave with security", city: "Delhi", state: "Delhi", pincode: "110001" })!;
  assert.deepEqual([a.houseNumber, a.landmark, a.deliveryInstructions], ["904", "Opp. metro", "Leave with security"]);
});

test("a place description never lands in the pincode, city or state fields", () => {
  const maps = "Near Phoenix Mall, Lower Parel, Mumbai, Maharashtra 400013, India";
  const a = readAddressRecord({ line1: "Shop 5", pincode: maps, city: maps, state: maps })!;
  assert.deepEqual([a.pincode, a.city, a.state], ["", "", ""]);
  assert.equal(cleanPincode("400 013"), "400013");
  assert.equal(cleanPincode("012345"), "");
  assert.equal(cleanPincode("4000"), "");
  assert.equal(cleanPlace("Navi Mumbai"), "Navi Mumbai");
  assert.equal(cleanPlace("Andheri West, Mumbai"), "");
  assert.equal(cleanPlace("Sector 5"), "");
});

test("an order's separate shippingPincode fills a missing pincode, and nothing usable gives null", () => {
  assert.equal(readAddressRecord({ line1: "1 Road", city: "Pune", state: "Maharashtra" }, "411001")!.pincode, "411001");
  assert.equal(readAddressRecord({}), null);
  assert.equal(readAddressRecord(null), null);
  assert.equal(readAddressRecord({ name: "Only Name", phone: "9000000000" }), null);
});
