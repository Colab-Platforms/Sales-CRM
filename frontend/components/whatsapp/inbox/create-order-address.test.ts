// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/create-order-address.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAddressDraft, composeLines, formatAddress, structuredFromSaved, validateAddress, type StructuredAddress } from "./create-order-address";

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

describe("structuredFromSaved - a saved address never loses a part", () => {
  it("a legacy line1/line2 address (e.g. a checkout address) carries over, and its landmark is kept", () => {
    assert.deepEqual(structuredFromSaved({ line1: "12 MG Road", line2: "Near Station", landmark: "Opp. metro" }), { houseNumber: "12 MG Road", building: "", area: "Near Station", street: "", landmark: "Opp. metro", addressType: "HOME" });
  });
  it("a partly structured address keeps its fields and falls back to the composed lines for the rest", () => {
    const r = structuredFromSaved({ houseNumber: "Flat 7", building: "Green Heights", line1: "Flat 7, Green Heights", line2: "Baner Road, Baner" });
    assert.deepEqual([r.houseNumber, r.building, r.area], ["Flat 7", "Green Heights", "Baner Road, Baner"]);
  });
  it("a fully structured address maps field for field", () => {
    const r = structuredFromSaved({ houseNumber: "Flat 7", building: "B", area: "Baner", street: "Baner Road", landmark: "Garden", addressType: "WORK", line1: "x", line2: "y" });
    assert.deepEqual(r, { houseNumber: "Flat 7", building: "B", area: "Baner", street: "Baner Road", landmark: "Garden", addressType: "WORK" });
  });
});

describe("buildAddressDraft - what is shown, and that typing is never overwritten", () => {
  const saved = { name: "Asha Rao", phone: "9811700001", line1: "12 MG Road", line2: "Near Station", city: "Pune", state: "Maharashtra", pincode: "411001", landmark: "Opp. metro", deliveryInstructions: "Call first" };
  const base = { customerName: "Selected Customer", customerMobile: "9000000000", resolvedCity: null, resolvedState: null };

  it("prefills every field from the selected customer's saved address", () => {
    const d = buildAddressDraft({ ...base, saved, edits: {} });
    assert.deepEqual([d.name, d.phone, d.houseNumber, d.area, d.landmark, d.city, d.state, d.pincode, d.deliveryInstructions], ["Asha Rao", "9811700001", "12 MG Road", "Near Station", "Opp. metro", "Pune", "Maharashtra", "411001", "Call first"]);
  });
  it("manually edited fields stay exactly as typed - even cleared ones - and the rest stay prefilled", () => {
    const d = buildAddressDraft({ ...base, saved, edits: { houseNumber: "Flat 9", landmark: "", city: "Mumbai" } });
    assert.deepEqual([d.houseNumber, d.landmark, d.city], ["Flat 9", "", "Mumbai"]);
    assert.deepEqual([d.area, d.state, d.pincode], ["Near Station", "Maharashtra", "411001"]);
  });
  it("changing the pincode re-resolves city/state from the pincode but keeps typed lines", () => {
    const d = buildAddressDraft({ ...base, saved, edits: { pincode: "400053", houseNumber: "Flat 9" }, resolvedCity: "Mumbai", resolvedState: "Maharashtra" });
    assert.deepEqual([d.city, d.state, d.houseNumber, d.area], ["Mumbai", "Maharashtra", "Flat 9", "Near Station"]);
  });
  it("a saved address with a blank city uses the pincode's own city, and a blank name/phone uses the selected customer's", () => {
    const d = buildAddressDraft({ ...base, saved: { ...saved, name: "", phone: "", city: "" }, edits: {}, resolvedCity: "Pune", resolvedState: "Maharashtra" });
    assert.deepEqual([d.city, d.name, d.phone], ["Pune", "Selected Customer", "9000000000"]);
  });
  it("with nothing saved, the form is empty apart from the customer's own name and phone", () => {
    const d = buildAddressDraft({ ...base, saved: null, edits: {} });
    assert.deepEqual([d.name, d.phone, d.houseNumber, d.pincode, d.city], ["Selected Customer", "9000000000", "", "", ""]);
  });
  it("a prefilled address that is incomplete reports exactly which fields are missing", () => {
    const d = buildAddressDraft({ ...base, saved: { ...saved, line2: "", pincode: "" }, edits: {} });
    assert.deepEqual(Object.keys(validateAddress(d)).sort(), ["area", "pincode"]);
  });
});
