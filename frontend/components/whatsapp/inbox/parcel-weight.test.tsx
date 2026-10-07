// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/parcel-weight.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CourierTable, ItemCard, ServiceabilityLine } from "./create-order-sections";
import { parseParcelDimensions, rateInputsOrMissing, rateKey } from "@/lib/package-dimensions";
import { formatKg, lineProductWeightKg, parseParcelWeight, unitWeightKg } from "@/lib/parcel-weight";
import type { ProductListItem } from "@/lib/api-client/types/products.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("parcel weight parsing: entered by a person, never defaulted", () => {
  it("accepts a real positive number and returns it unchanged", () => {
    for (const [raw, kg] of [["0.5", 0.5], ["0.25", 0.25], ["1", 1], [" 1.5 ", 1.5], ["0.75", 0.75]] as const) assert.deepEqual(parseParcelWeight(raw), { ok: true, kg });
  });
  it("empty means 'not entered' (no message, no default); 0, negative, junk and absurd values are rejected", () => {
    assert.deepEqual(parseParcelWeight(""), { ok: false, error: null });
    assert.deepEqual(parseParcelWeight("   "), { ok: false, error: null });
    assert.match((parseParcelWeight("0") as { error: string }).error, /greater than 0/);
    assert.match((parseParcelWeight("0.0") as { error: string }).error, /greater than 0/);
    assert.match((parseParcelWeight("-0.5") as { error: string }).error, /cannot be negative/);
    assert.match((parseParcelWeight("abc") as { error: string }).error, /must be a number/);
    assert.match((parseParcelWeight("1e3") as { error: string }).error, /must be a number/);
    assert.match((parseParcelWeight("101") as { error: string }).error, /100 kg or less/);
  });
  it("formats for display only", () => {
    assert.equal(formatKg(0.5), "0.50 kg");
    assert.equal(formatKg("0.250"), "0.25 kg");
    assert.equal(formatKg(1), "1.00 kg");
    assert.equal(formatKg(0.62), "0.62 kg");
    assert.equal(formatKg(0.125), "0.125 kg");
    assert.equal(formatKg(null), null);
    assert.equal(formatKg(undefined), null);
    assert.equal(formatKg(""), null);
  });
});

describe("product weight is only what was recorded", () => {
  it("variant weight wins, else the product's, else nothing - never a guess", () => {
    assert.equal(unitWeightKg({ weightKg: "0.5" }, { weightKg: "0.25" }), 0.25);
    assert.equal(unitWeightKg({ weightKg: "0.5" }, { weightKg: null }), 0.5);
    assert.equal(unitWeightKg({ weightKg: null }, { weightKg: null }), null);
    assert.equal(unitWeightKg({}, {}), null);
    assert.equal(unitWeightKg(null, null), null);
    assert.equal(unitWeightKg({ weightKg: "0" }, null), null);
  });
  it("quantity x unit weight only when a unit weight exists", () => {
    assert.equal(lineProductWeightKg(0.25, 2), 0.5);
    assert.equal(lineProductWeightKg(0.25, 3), 0.75);
    assert.equal(lineProductWeightKg(null, 2), null);
    assert.equal(lineProductWeightKg(0.25, 0), null);
  });
});

const product = (over: Partial<ProductListItem>): ProductListItem => ({ id: "p1", name: "Brain Fuel Capsules", sku: "BF", basePrice: "499.00", weightKg: null, variants: [{ id: "v1", name: "Pack Of 1", sku: "AW-BF-CAP-1", price: "499.00", weightKg: "0.25" }, { id: "v3", name: "Pack Of 3", sku: "AW-BF-CAP-3", price: "1299.00", weightKg: null }], ...over });
const card = (variantId: string, quantity: string, products = [product({})]) =>
  renderToStaticMarkup(<ItemCard item={{ key: "k", productId: "p1", variantId, quantity, unitPrice: "499.00" }} index={0} products={products} productsLoading={false} canRemove={false} onChange={() => {}} onProductChange={() => {}} onVariantChange={() => {}} onRemove={() => {}} />);

describe("Create Order item: product weight display", () => {
  it("shows the recorded weight (and the quantity total, labelled as an estimate) - never as the parcel weight", () => {
    const one = text(card("v1", "1"));
    assert.match(one, /Weight: 0\.25 kg/);
    assert.doesNotMatch(one, /Product weight:/, "no total for a single unit");
    const two = text(card("v1", "2"));
    assert.match(two, /Weight: 0\.25 kg/);
    assert.match(two, /Product weight: 0\.50 kg \(estimate - not the parcel weight\)/);
  });
  it("a variant with NO recorded weight shows no weight at all (nothing is assumed)", () => {
    const t = text(card("v3", "2"));
    assert.doesNotMatch(t, /Weight:|Product weight/);
  });
  it("a product sold without variants uses its own recorded weight", () => {
    const t = text(card("", "3", [product({ weightKg: "1.5", variants: [] })]));
    assert.match(t, /Weight: 1\.50 kg/);
    assert.match(t, /Product weight: 4\.50 kg/);
  });
});

describe("shipping rates are Shiprocket's, shown as returned", () => {
  const result = { status: "serviceable" as const, couriers: 3, cheapestRate: 78, minDays: 2, maxDays: 5, blocksOrder: false, message: null, courierOptions: [{ name: "Ecom Express", rate: 78, days: 5 }, { name: "Delhivery", rate: 91.25, days: 4 }, { name: "Blue Dart", rate: 130, days: 2 }] };
  const dims = { length: 20, breadth: 15, height: 2 };
  const line = (over: Partial<React.ComponentProps<typeof ServiceabilityLine>> = {}) => renderToStaticMarkup(<ServiceabilityLine pincodeState="valid" missing={null} calculating={false} result={result} parcelWeightKg={0.5} dimensions={dims} {...over} />);

  it("without a parcel weight: nothing is requested, and it says what is needed", () => {
    const t = text(line({ missing: "weight", result: undefined }));
    assert.match(t, /Courier serviceability requires shipment weight — enter the parcel weight below\./);
    assert.match(t, /Enter parcel weight to check courier availability\./);
    assert.doesNotMatch(t, /Courier\s+Shipping Charge/);
  });
  it("without packed dimensions: nothing is requested, and it says what is needed", () => {
    const t = text(line({ missing: "dimensions", result: undefined }));
    assert.match(t, /Enter the packed parcel dimensions \(cm\) to calculate shipping rates\./);
    assert.doesNotMatch(t, /Courier\s+Shipping Charge/);
  });
  it("while calculating: 'Calculating shipping rates...' and NO courier table (a previous result is never shown)", () => {
    const t = text(line({ calculating: true, result: undefined }));
    assert.match(t, /Calculating shipping rates\.\.\./);
    assert.doesNotMatch(t, /Available Couriers|Ecom Express/);
  });
  it("with 0.5 kg and 20 x 15 x 2: 'Parcel Weight: 0.50 kg', the dimensions, and each courier with the charge Shiprocket returned", () => {
    const t = text(line());
    assert.match(t, /Available Couriers/);
    assert.match(t, /Parcel Weight: 0\.50 kg · Dimensions: 20 × 15 × 2 cm/);
    assert.match(t, /Courier Shipping Charge ETA/);
    assert.match(t, /Ecom Express ₹78\.00 5 days/);
    assert.match(t, /Delhivery ₹91\.25 4 days/);
    assert.match(t, /Blue Dart ₹130\.00 2 days/);
    assert.doesNotMatch(t, /COD Charge|Tax/, "Shiprocket returned only a total, so only the total is shown");
  });
  it("COD charge, tax and ETA are shown exactly as Shiprocket returned them, when it returned them", () => {
    const t = text(line({ result: { ...result, courierOptions: [{ name: "Delhivery", rate: 85, days: 3, codCharge: 40, tax: 12.5, etd: "Oct 12, 2026" }, { name: "Xpress", rate: 60, days: 5, codCharge: null, tax: null, etd: null }] } }));
    assert.match(t, /Courier Shipping Charge COD Charge Tax ETA/);
    assert.match(t, /Xpress ₹60\.00 — — 5 days/);
    assert.match(t, /Delhivery ₹85\.00 ₹40\.00 ₹12\.50 Oct 12, 2026/);
    assert.ok(t.indexOf("Xpress") < t.indexOf("Delhivery"), "cheapest first");
  });
  it("a courier Shiprocket gave no charge for shows a dash, not an invented amount", () => {
    const t = text(renderToStaticMarkup(<CourierTable weightKg={1} options={[{ name: "Unpriced", rate: null, days: null }]} />));
    assert.match(t, /Unpriced — —/);
  });
  it("no couriers: no table", () => {
    assert.equal(renderToStaticMarkup(<CourierTable weightKg={1} options={[]} />), "");
  });
  it("a failed request says so, keeps the order creatable and offers a manual re-check", () => {
    const t = text(line({ failed: true, result: undefined, onRefresh: () => {} }));
    assert.match(t, /Could not calculate shipping rates right now\. You can still continue\./);
    assert.match(t, /Check Courier Availability/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Suggestion from product weights, and the operator's typed value being authoritative.
import { estimateProductWeight, resolveParcelWeight, sortCouriers, weightHint } from "@/lib/parcel-weight";

describe("estimated product weight = sum(unit weight x quantity); only complete estimates are suggested", () => {
  const est = (lines: { unitKg: number | null; quantity: number }[]) => estimateProductWeight(lines);
  it("0.25 kg x 2 = 0.5 kg", () => assert.deepEqual(est([{ unitKg: 0.25, quantity: 2 }]), { knownKg: 0.5, lineCount: 1, knownCount: 1, complete: true }));
  it("0.25 x 2 + 0.10 x 1 = 0.6 kg", () => assert.equal(est([{ unitKg: 0.25, quantity: 2 }, { unitKg: 0.1, quantity: 1 }]).knownKg, 0.6));
  it("a product with no recorded weight makes the estimate incomplete (and a lone one has no estimate at all)", () => {
    assert.deepEqual(est([{ unitKg: null, quantity: 2 }]), { knownKg: null, lineCount: 1, knownCount: 0, complete: false });
    const partial = est([{ unitKg: 0.25, quantity: 2 }, { unitKg: null, quantity: 1 }]);
    assert.deepEqual([partial.knownKg, partial.complete], [0.5, false]);
  });
  it("no products selected: nothing", () => assert.deepEqual(est([]), { knownKg: null, lineCount: 0, knownCount: 0, complete: false }));
});

describe("parcel weight field: suggested vs manual", () => {
  const complete = (kg: number) => estimateProductWeight([{ unitKg: kg, quantity: 1 }]);
  it("untouched + complete estimate: the estimate is suggested, and follows quantity changes", () => {
    assert.deepEqual(resolveParcelWeight(null, estimateProductWeight([{ unitKg: 0.25, quantity: 1 }])), { text: "0.25", source: "suggested" });
    assert.deepEqual(resolveParcelWeight(null, estimateProductWeight([{ unitKg: 0.25, quantity: 2 }])), { text: "0.5", source: "suggested" });
  });
  it("a typed value is NEVER overwritten when the estimate changes (0.25 -> operator types 0.5 -> quantity 2)", () => {
    assert.deepEqual(resolveParcelWeight("0.5", estimateProductWeight([{ unitKg: 0.25, quantity: 1 }])), { text: "0.5", source: "manual" });
    assert.deepEqual(resolveParcelWeight("0.5", estimateProductWeight([{ unitKg: 0.25, quantity: 2 }])), { text: "0.5", source: "manual" });
    assert.deepEqual(resolveParcelWeight("0.5", estimateProductWeight([{ unitKg: 0.25, quantity: 7 }])), { text: "0.5", source: "manual" });
    assert.equal(resolveParcelWeight("", complete(1)).text, "", "even a cleared field stays what the operator made it");
  });
  it("incomplete or unknown weights: the field stays EMPTY - nothing is invented", () => {
    assert.deepEqual(resolveParcelWeight(null, estimateProductWeight([{ unitKg: null, quantity: 1 }])), { text: "", source: "none" });
    assert.deepEqual(resolveParcelWeight(null, estimateProductWeight([{ unitKg: 0.25, quantity: 1 }, { unitKg: null, quantity: 1 }])), { text: "", source: "none" });
    assert.deepEqual(resolveParcelWeight(null, estimateProductWeight([])), { text: "", source: "none" });
  });
  it("hints say where the value comes from", () => {
    assert.equal(weightHint("suggested", complete(1)), "Suggested from product weights. Adjust for packaging and actual parcel weight.");
    assert.equal(weightHint("none", estimateProductWeight([{ unitKg: null, quantity: 1 }])), "Parcel weight not available — enter the actual parcel weight.");
    assert.equal(weightHint("none", estimateProductWeight([{ unitKg: 0.2, quantity: 1 }, { unitKg: null, quantity: 1 }])), "Some product weights are not recorded. Enter parcel weight manually.");
    assert.equal(weightHint("manual", complete(1)), "Estimated — used only to check courier availability.");
  });
  it("couriers are shown cheapest first; a courier without a charge goes last", () => {
    assert.deepEqual(sortCouriers([{ n: "B", rate: 130 }, { n: "N", rate: null }, { n: "A", rate: 78 }]).map((c) => c.n), ["A", "B", "N"]);
  });
});

describe("rate results belong to the exact inputs they were requested for", () => {
  const base = { pincodeValid: true, pincode: "400001", cod: false, weight: { ok: true as const, kg: 0.62 }, dims: parseParcelDimensions({ length: "20", breadth: "15", height: "2" }), value: 899 };
  const keyOf = (over: Partial<typeof base> = {}) => {
    const r = rateInputsOrMissing({ ...base, ...over });
    assert.ok(r.ok);
    return rateKey(r.inputs);
  };
  it("every meaningful input changes the key - so earlier rates are discarded and fresh ones requested", () => {
    const k = keyOf();
    for (const changed of [{ weight: { ok: true as const, kg: 0.75 } }, { pincode: "560001" }, { cod: true }, { value: 999 }, { dims: parseParcelDimensions({ length: "20", breadth: "15", height: "3" }) }]) {
      assert.notEqual(keyOf(changed), k, JSON.stringify(changed));
    }
    assert.equal(keyOf(), k, "same inputs, same key");
  });
  it("nothing is requested until pincode, weight, dimensions and order value are all valid", () => {
    assert.deepEqual(rateInputsOrMissing({ ...base, pincodeValid: false }), { ok: false, missing: "pincode" });
    assert.deepEqual(rateInputsOrMissing({ ...base, weight: { ok: false } }), { ok: false, missing: "weight" });
    assert.deepEqual(rateInputsOrMissing({ ...base, dims: parseParcelDimensions({ length: "20", breadth: "", height: "2" }) }), { ok: false, missing: "dimensions" });
    assert.deepEqual(rateInputsOrMissing({ ...base, value: 0 }), { ok: false, missing: "value" });
    assert.equal(rateInputsOrMissing(base).ok, true);
  });
  it("the request carries exactly the entered parcel weight and dimensions", () => {
    const r = rateInputsOrMissing({ ...base, weight: { ok: true, kg: 0.75 } });
    assert.ok(r.ok);
    assert.deepEqual(r.inputs, { pincode: "400001", cod: false, weightKg: 0.75, dims: { length: 20, breadth: 15, height: 2 }, value: 899 });
  });
});

import { shipmentDialogWeight } from "@/lib/parcel-weight";

describe("existing order -> shipment dialog weight", () => {
  const est = (unitKg: number | null, quantity = 1) => estimateProductWeight([{ unitKg, quantity }]);
  it("a weight recorded on the order wins over any suggestion and is never overwritten", () => {
    assert.deepEqual(shipmentDialogWeight(null, "0.5", est(0.25, 4)), { text: "0.5", source: "recorded" });
  });
  it("no recorded weight: a complete product-weight estimate is suggested, an unknown one leaves the field empty", () => {
    assert.deepEqual(shipmentDialogWeight(null, null, est(0.25, 2)), { text: "0.5", source: "suggested" });
    assert.deepEqual(shipmentDialogWeight(null, null, est(null)), { text: "", source: "none" });
  });
  it("what the operator types always wins", () => {
    assert.deepEqual(shipmentDialogWeight("0.75", "0.5", est(0.25, 2)), { text: "0.75", source: "manual" });
  });
});
