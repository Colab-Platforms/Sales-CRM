import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearPincodeCache, lookupPincode, parsePincodeResponse } from "./delivery.pincode.js";
import { checkServiceability, clearPickupCache } from "./delivery.serviceability.js";
import { parseServiceabilityResponse } from "../shiprocket/shiprocket.client.js";
import { ProviderHttpError } from "../integrations/integrations.common.js";
import { ShiprocketConfigError, type ShiprocketConfig } from "../shiprocket/shiprocket.config.js";

const MUMBAI = [{ Message: "Number of pincode(s) found:2", Status: "Success", PostOffice: [{ Name: "Mumbai G.P.O.", District: "MUMBAI", State: "Maharashtra" }, { Name: "Fort", District: "MUMBAI", State: "Maharashtra" }] }];
const NONE = [{ Message: "No records found", Status: "Error", PostOffice: null }];
const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("pincode lookup", () => {
  beforeEach(() => clearPincodeCache());

  it("resolves a real pincode to its city (district) and state", async () => {
    const r = await lookupPincode("400001", { fetchImpl: ok(MUMBAI) });
    assert.deepEqual([r.status, r.city, r.state], ["valid", "Mumbai", "Maharashtra"]);
    assert.deepEqual(r.areas, ["Mumbai G.P.O.", "Fort"]);
  });

  it("says invalid only when the directory definitively has no such pincode", async () => {
    const r = await lookupPincode("999999", { fetchImpl: ok(NONE) });
    assert.equal(r.status, "invalid");
    assert.equal(r.message, "Please enter a valid 6-digit Indian pincode.");
  });

  it("malformed input is invalid without ever calling the directory (letters, 5 digits, leading 0)", async () => {
    let calls = 0;
    const f = (async () => { calls += 1; return new Response("[]"); }) as unknown as typeof fetch;
    for (const bad of ["40000", "4000011", "40000a", "012345", ""]) assert.equal((await lookupPincode(bad, { fetchImpl: f })).status, "invalid");
    assert.equal(calls, 0);
  });

  it("a directory outage is 'unavailable' - never 'invalid' - and is not cached", async () => {
    let calls = 0;
    const down = (async () => { calls += 1; throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    assert.equal((await lookupPincode("400001", { fetchImpl: down })).status, "unavailable");
    assert.equal((await lookupPincode("400001", { fetchImpl: down })).status, "unavailable");
    assert.equal(calls, 2, "retried, not served from cache");
    const http500 = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    assert.equal((await lookupPincode("400002", { fetchImpl: http500 })).status, "unavailable");
  });

  it("caches definitive answers (one upstream request per pincode)", async () => {
    let calls = 0;
    const f = (async () => { calls += 1; return new Response(JSON.stringify(MUMBAI)); }) as unknown as typeof fetch;
    await lookupPincode("400001", { fetchImpl: f });
    await lookupPincode("400001", { fetchImpl: f });
    assert.equal(calls, 1);
  });

  it("picks the most common district/state when offices disagree", () => {
    const r = parsePincodeResponse("110001", [{ PostOffice: [{ Name: "a", District: "New Delhi", State: "Delhi" }, { Name: "b", District: "New Delhi", State: "Delhi" }, { Name: "c", District: "Central Delhi", State: "Delhi" }] }]);
    assert.equal(r.city, "New Delhi");
  });
});

const CONFIG = { baseUrl: "https://apiv2.shiprocket.in/v1/external", email: "e@x.y", pickupLocation: "warehouse" } as ShiprocketConfig;
const client = (over: Partial<{ pickup: string | null; couriers: { rate: number | null; days: number | null }[]; throws: Error }> = {}) => {
  const calls = { pickup: 0, check: [] as Record<string, unknown>[] };
  return {
    calls,
    factory: () => ({
      getPickupPostcode: async () => { calls.pickup += 1; return over.pickup === undefined ? "400069" : over.pickup; },
      checkServiceability: async (i: Record<string, unknown>) => { calls.check.push(i); if (over.throws) throw over.throws; return { couriers: over.couriers ?? [{ rate: 90, days: 4 }, { rate: 70.5, days: 6 }, { rate: null, days: 2 }] }; },
    }),
  };
};
const deps = (c: ReturnType<typeof client>, env: Record<string, string | undefined> = {}) => ({ config: () => CONFIG, client: c.factory, env });

describe("Shiprocket serviceability", () => {
  beforeEach(() => clearPickupCache());

  it("serviceable: courier count, cheapest rate and delivery range; uses the pickup postcode + the COD flag + the weight", async () => {
    const c = client();
    const r = await checkServiceability({ pincode: "400001", cod: true, weightKg: 0.5 }, deps(c));
    assert.deepEqual([r.status, r.couriers, r.cheapestRate, r.minDays, r.maxDays, r.blocksOrder], ["serviceable", 3, 70.5, 2, 6, false]);
    assert.deepEqual(c.calls.check[0], { pickupPostcode: "400069", deliveryPostcode: "400001", cod: true, weightKg: 0.5 });
  });

  it("prepaid is checked with cod=false", async () => {
    const c = client();
    await checkServiceability({ pincode: "400001", cod: false, weightKg: 1 }, deps(c));
    assert.equal(c.calls.check[0]!.cod, false);
  });

  it("not serviceable when no courier is returned - and it blocks the order by default, but not when ORDER_BLOCK_UNSERVICEABLE=false", async () => {
    const none = client({ couriers: [] });
    const blocked = await checkServiceability({ pincode: "999999", cod: true, weightKg: 1 }, deps(none));
    assert.deepEqual([blocked.status, blocked.blocksOrder], ["not_serviceable", true]);
    assert.match(blocked.message ?? "", /not serviceable/);
    const allowed = await checkServiceability({ pincode: "999999", cod: true, weightKg: 1 }, deps(none, { ORDER_BLOCK_UNSERVICEABLE: "false" }));
    assert.deepEqual([allowed.status, allowed.blocksOrder], ["not_serviceable", false]);
  });

  it("Shiprocket's HTTP 404 'no courier' is also not-serviceable, but other failures are 'unavailable' (never a false 'not serviceable')", async () => {
    const r404 = await checkServiceability({ pincode: "999999", cod: true, weightKg: 1 }, deps(client({ throws: new ProviderHttpError("SHIPROCKET", 404, "Sorry, no courier serviceability", false) })));
    assert.equal(r404.status, "not_serviceable");
    const r500 = await checkServiceability({ pincode: "400001", cod: true, weightKg: 1 }, deps(client({ throws: new ProviderHttpError("SHIPROCKET", 503, "down", true) })));
    assert.deepEqual([r500.status, r500.blocksOrder], ["unavailable", false]);
  });

  it("requires a real weight and a valid pincode, and never guesses either", async () => {
    const c = client();
    assert.equal((await checkServiceability({ pincode: "400001", cod: true, weightKg: 0 }, deps(c))).message, "Courier serviceability requires shipment weight.");
    assert.equal((await checkServiceability({ pincode: "40001", cod: true, weightKg: 1 }, deps(c))).status, "unavailable");
    assert.equal(c.calls.check.length, 0);
  });

  it("not configured / no pickup postcode -> 'unavailable' with a safe message (no env names or secrets)", async () => {
    const off = await checkServiceability({ pincode: "400001", cod: true, weightKg: 1 }, { config: () => { throw new ShiprocketConfigError("Shiprocket is not enabled (SHIPROCKET_ENABLED is not true)"); }, env: {} });
    assert.equal(off.status, "unavailable");
    assert.equal(/SHIPROCKET_/.test(off.message ?? ""), false, "no env variable names leak");
    const nopin = await checkServiceability({ pincode: "400001", cod: true, weightKg: 1 }, deps(client({ pickup: null })));
    assert.equal(nopin.status, "unavailable");
    assert.equal(/SHIPROCKET_|password|token/i.test(nopin.message ?? ""), false);
  });

  it("asks Shiprocket for the pickup postcode once, then reuses it", async () => {
    const c = client();
    await checkServiceability({ pincode: "400001", cod: true, weightKg: 1 }, deps(c));
    await checkServiceability({ pincode: "110001", cod: true, weightKg: 1 }, deps(c));
    assert.equal(c.calls.pickup, 1);
    assert.equal(c.calls.check.length, 2);
  });

  it("parses both of Shiprocket's response shapes", () => {
    assert.equal(parseServiceabilityResponse({ status: 200, data: { available_courier_companies: [{ rate: 88, estimated_delivery_days: "3" }] } }).couriers.length, 1);
    assert.deepEqual(parseServiceabilityResponse({ status: 404, message: "no courier" }).couriers, []);
    assert.deepEqual(parseServiceabilityResponse({ data: { available_courier_companies: [{ courier_name: "x" }] } }).couriers, [{ rate: null, days: null }]);
  });
});
