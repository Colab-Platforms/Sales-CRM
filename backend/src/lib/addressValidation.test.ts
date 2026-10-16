import test from "node:test";
import assert from "node:assert/strict";
import { interpretVerdict, validateAddress } from "./addressValidation.js";

const good = { result: { verdict: { addressComplete: true, validationGranularity: "PREMISE" }, address: { formattedAddress: "4B, MG Rd, Mumbai 400053", postalAddress: { postalCode: "400053" } }, geocode: { location: { latitude: 19.1, longitude: 72.8 } } } };

test("complete premise-level address is VERIFIED and carries the geocode", () => {
  const r = interpretVerdict(good, "400053");
  assert.equal(r.status, "VERIFIED");
  assert.deepEqual([r.lat, r.lng], [19.1, 72.8]);
});

test("pincode that differs from Google's is UNCONFIRMED with a suggestion", () => {
  const r = interpretVerdict(good, "110001");
  assert.equal(r.status, "UNCONFIRMED");
  assert.equal(r.suggestedPincode, "400053");
});

test("street-level only is UNCONFIRMED; granularity OTHER is INVALID", () => {
  const route = { result: { ...good.result, verdict: { addressComplete: false, validationGranularity: "ROUTE" } } };
  assert.equal(interpretVerdict(route, "400053").status, "UNCONFIRMED");
  const other = { result: { verdict: { validationGranularity: "OTHER" }, address: {} } };
  assert.equal(interpretVerdict(other, "400053").status, "INVALID");
});

test("no key, HTTP error or network failure is SKIPPED - never throws", async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  assert.equal((await validateAddress({ line1: "x" })).status, "SKIPPED");
  process.env.GOOGLE_MAPS_API_KEY = "k";
  assert.equal((await validateAddress({ line1: "x" }, (async () => new Response("", { status: 500 })) as typeof fetch)).status, "SKIPPED");
  assert.equal((await validateAddress({ line1: "x" }, (async () => { throw new Error("down"); }) as typeof fetch)).status, "SKIPPED");
  delete process.env.GOOGLE_MAPS_API_KEY;
});

test("postal_code listed as unconfirmed but present in Google's address for the typed pincode does not downgrade", () => {
  const res = { result: { ...good.result, verdict: { addressComplete: true, hasUnconfirmedComponents: true, validationGranularity: "PREMISE" }, address: { ...good.result.address, unconfirmedComponentTypes: ["postal_code"] } } };
  assert.equal(interpretVerdict(res, "400053").status, "VERIFIED");
  assert.equal(interpretVerdict(res, "110001").status, "UNCONFIRMED");
});
