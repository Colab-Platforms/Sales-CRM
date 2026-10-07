// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/create-order-address.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeLines, formatAddress, structuredFromSaved, validateAddress, type StructuredAddress } from "./create-order-address";

const ok: StructuredAddress = { pincode: "400053", houseNumber: "Flat 4B", building: "Sunrise Apartments", area: "Andheri West", street: "MG Road", landmark: "Near City Mall", city: "Mumbai", state: "Maharashtra", addressType: "HOME" };
const errs = (patch: Partial<StructuredAddress>) => validateAddress({ ...ok, ...patch });

describe("validateAddress", () => {
  it("accepts a complete address, with optional fields omitted, and every address type", () => {
    assert.deepEqual(validateAddress(ok), {});
    assert.deepEqual(errs({ building: "", street: "", landmark: "" }), {});
    for (const addressType of ["HOME", "WORK", "OTHER"] as const) assert.deepEqual(errs({ addressType }), {});
  });
  it("accepts legitimate Indian formatting (numbers, /, -, commas)", () => {
    assert.deepEqual(errs({ houseNumber: "No. 12/3-B, 2nd Floor", area: "4th Cross, J.P. Nagar 2nd Phase" }), {});
  });
  it("rejects a pincode that is short, long, alphabetic or empty", () => {
    for (const pincode of ["4000", "4000011", "40000A", "ABCDEF", "012345"]) assert.ok(errs({ pincode }).pincode, pincode);
    assert.equal(errs({ pincode: "" }).pincode, "Pincode is required");
  });
  it("rejects empty house number, locality, city and state", () => {
    assert.ok(errs({ houseNumber: "" }).houseNumber);
    assert.ok(errs({ area: "" }).area);
    assert.ok(errs({ city: "" }).city);
    assert.ok(errs({ state: "" }).state);
  });
  it("whitespace-only and punctuation-only values count as empty", () => {
    for (const v of ["   ", "\t", "-", "..."]) {
      assert.ok(errs({ houseNumber: v }).houseNumber, JSON.stringify(v));
      assert.ok(errs({ area: v }).area);
      assert.ok(errs({ city: v }).city);
      assert.ok(errs({ state: v }).state);
    }
  });
});

describe("composeLines / formatAddress", () => {
  it("builds line1/line2 that integrations already read, skipping empty parts", () => {
    assert.deepEqual(composeLines(ok), { line1: "Flat 4B, Sunrise Apartments", line2: "MG Road, Andheri West, Near City Mall" });
    assert.deepEqual(composeLines({ ...ok, building: "", street: "", landmark: "" }), { line1: "Flat 4B", line2: "Andheri West" });
    assert.equal(formatAddress({ ...ok, building: "", street: "", landmark: "" }), "Flat 4B, Andheri West, Mumbai, Maharashtra, 400053");
  });
  it("trims stray whitespace and preserves unusual formatting", () => {
    assert.equal(composeLines({ ...ok, houseNumber: "  12/A-3 ", building: "" }).line1, "12/A-3");
  });
});

describe("structuredFromSaved (existing data compatibility)", () => {
  it("a legacy free-text address is carried over without loss: line1 -> house, line2 -> area", () => {
    const s = structuredFromSaved({ line1: "12 MG Road", line2: "Near Park" });
    assert.deepEqual(s, { houseNumber: "12 MG Road", building: "", area: "Near Park", street: "", landmark: "", addressType: "HOME" });
  });
  it("a structured address maps field for field, including its address type", () => {
    const s = structuredFromSaved({ line1: "x", line2: "y", houseNumber: "Flat 4B", building: "Sunrise", area: "Andheri", street: "MG Road", landmark: "Mall", addressType: "WORK" });
    assert.deepEqual(s, { houseNumber: "Flat 4B", building: "Sunrise", area: "Andheri", street: "MG Road", landmark: "Mall", addressType: "WORK" });
  });
  it("no saved address, or an unknown type, falls back safely", () => {
    assert.equal(structuredFromSaved(null).houseNumber, "");
    assert.equal(structuredFromSaved({ line1: "a", addressType: "OFFICE" }).addressType, "HOME");
  });
});
