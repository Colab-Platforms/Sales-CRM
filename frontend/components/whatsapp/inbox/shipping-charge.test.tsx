// The order's shipping charge = the selected courier's Shiprocket charge, verbatim. Run with:
// ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/shipping-charge.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { chargeText, courierKey, selectedCourier, shippingChargeState } from "@/lib/shipping-charge";
import { CourierTable } from "./courier-rates";
import { ShippingSection } from "./create-order-sections";
import type { ServiceabilityResult } from "@/lib/api-client/types/delivery.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const opt = (name: string, rate: number | null) => ({ name, rate, days: 3, codCharge: null, tax: null, etd: null });
const result = (options: ReturnType<typeof opt>[], status: ServiceabilityResult["status"] = "serviceable"): ServiceabilityResult => ({ status, couriers: options.length, cheapestRate: null, minDays: null, maxDays: null, courierOptions: options, blocksOrder: false, message: null });
const A = opt("Courier A", 58);
const B = opt("Courier B", 72);
const C = opt("Courier C", 91);
const base = { requested: true, calculating: false, failed: false, pickKey: null as string | null };

describe("shipping charge comes straight from Shiprocket's rates", () => {
  it("A: Shiprocket returns A=58, B=72, C=91 (any order) -> default is the cheapest, charge is exactly 58", () => {
    const s = shippingChargeState({ ...base, result: result([C, A, B]) });
    assert.deepEqual(s, { kind: "rate", amount: 58, courier: "Courier A" });
    assert.equal(chargeText(s), "58");
  });

  it("A: the charge is the returned value verbatim - not scaled or rounded by the CRM (58.5 stays 58.5)", () => {
    assert.equal(chargeText(shippingChargeState({ ...base, result: result([opt("X", 58.5)]) })), "58.5");
  });

  it("B: choosing Courier B changes the charge to 72; a pick that is no longer offered falls back to the cheapest", () => {
    assert.deepEqual(shippingChargeState({ ...base, result: result([A, B, C]), pickKey: courierKey(B) }), { kind: "rate", amount: 72, courier: "Courier B" });
    assert.equal(selectedCourier([A, B, C], courierKey(opt("Gone", 10)))?.name, "Courier A");
  });

  it("a courier Shiprocket gave no charge for can never be selected (no invented amount)", () => {
    const none = opt("Unpriced", null);
    assert.equal(selectedCourier([none, B], courierKey(none))?.name, "Courier B");
    assert.deepEqual(shippingChargeState({ ...base, result: result([none]) }), { kind: "unavailable" });
  });

  it("C: before Shiprocket has answered there is NO charge (not 0): calculating, or not requested yet", () => {
    const calculating = shippingChargeState({ ...base, calculating: true, result: undefined });
    assert.deepEqual(calculating, { kind: "calculating" });
    assert.equal(chargeText(calculating), "");
    assert.deepEqual(shippingChargeState({ ...base, requested: false, result: undefined }), { kind: "idle" });
    assert.equal(chargeText({ kind: "idle" }), "");
  });

  it("D: a Shiprocket failure, a non-serviceable lane or an empty courier list is 'unavailable' - never 0", () => {
    for (const s of [shippingChargeState({ ...base, failed: true, result: undefined }), shippingChargeState({ ...base, result: result([], "not_serviceable") }), shippingChargeState({ ...base, result: result([], "unavailable") }), shippingChargeState({ ...base, result: result([]) })]) {
      assert.deepEqual(s, { kind: "unavailable" });
      assert.equal(chargeText(s), "");
    }
  });

  it("E: only an explicit Shiprocket ₹0 is shown as 0", () => {
    const s = shippingChargeState({ ...base, result: result([opt("Free", 0), B]) });
    assert.deepEqual(s, { kind: "rate", amount: 0, courier: "Free" });
    assert.equal(chargeText(s), "0");
  });

  it("F/G: while a changed package/pincode is recalculated the old charge is gone, and the new one comes from the new response only", () => {
    const old = shippingChargeState({ ...base, result: result([A, B]) });
    assert.equal(chargeText(old), "58");
    // an input changed: the hook reports calculating and no result - the previous 58 must not survive
    const during = shippingChargeState({ ...base, calculating: true, result: undefined });
    assert.equal(chargeText(during), "");
    // even if a stale result object were still around, calculating wins
    assert.equal(chargeText(shippingChargeState({ ...base, calculating: true, result: result([A, B]) })), "");
    const next = shippingChargeState({ ...base, result: result([opt("Courier A", 64), opt("Courier B", 80)]) });
    assert.equal(chargeText(next), "64");
  });
});

describe("rendered: the Shipping charge field and the selectable courier table", () => {
  const section = (shippingStatus: Parameters<typeof ShippingSection>[0]["shippingStatus"], shippingAmount: string) =>
    renderToStaticMarkup(
      <ShippingSection
        address={{ name: "", phone: "", houseNumber: "", building: "", area: "", street: "", landmark: "", addressType: "HOME", pincode: "400001", city: "", state: "" } as never}
        onChange={() => {}}
        weight="0.12"
        onWeightChange={() => {}}
        shippingAmount={shippingAmount}
        shippingStatus={shippingStatus}
        onShippingAmountChange={() => {}}
        prefilledFromLastOrder={false}
        pincodeState="valid"
        lookup={undefined}
        cityMismatch={false}
        onUseResolved={() => {}}
        serviceability={null}
      />,
    );
  const field = (h: string) => /<input[^>]*id="ship-amount"[^>]*>/.exec(h)?.[0] ?? "";

  it("rate: shows the Shiprocket value, read-only, naming the courier - never the old default 0", () => {
    const h = section({ kind: "rate", amount: 58, courier: "Courier A" }, "58");
    assert.match(field(h), /value="58"/);
    assert.match(field(h), /readOnly=""/);
    assert.match(text(h), /Shiprocket(&#x27;|')s charge for Courier A/);
  });
  it("calculating: empty, read-only, 'Calculating shipping rates...' - not 0", () => {
    const h = section({ kind: "calculating" }, "");
    assert.match(field(h), /value=""/);
    assert.doesNotMatch(field(h), /value="0"/);
    assert.match(text(h), /Calculating shipping rates\.\.\./);
  });
  it("unavailable: 'Not available' placeholder, editable, explained; idle: 'Not calculated'", () => {
    const u = section({ kind: "unavailable" }, "");
    assert.match(field(u), /placeholder="Not available"/);
    assert.doesNotMatch(field(u), /readOnly/);
    assert.match(text(u), /Shiprocket returned no usable rate/);
    assert.match(field(section({ kind: "idle" }, "")), /placeholder="Not calculated"/);
  });
  it("explicit ₹0 from Shiprocket is displayed as 0", () => {
    assert.match(field(section({ kind: "rate", amount: 0, courier: "Free" }, "0")), /value="0"/);
  });

  it("the courier table lets the operator pick a courier; the selected row is marked, a courier without a charge is disabled", () => {
    const h = renderToStaticMarkup(<CourierTable options={[A, B, opt("Unpriced", null)]} selectedKey={courierKey(A)} onSelect={() => {}} />);
    assert.match(h, /aria-label="Select Courier A"[^>]*checked=""|checked=""[^>]*aria-label="Select Courier A"/);
    assert.doesNotMatch(h, /aria-label="Select Courier B"[^>]*checked=""/);
    assert.match(h, /aria-label="Select Unpriced"[^>]*disabled=""|disabled=""[^>]*aria-label="Select Unpriced"/);
    assert.match(h, /data-selected="true"/);
  });
});
