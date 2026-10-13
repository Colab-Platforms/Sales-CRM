// Pure tests: what the Fastrr "Abandon Cart" parser keeps for the Create Order prefill. No database, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAbandonmentEvent, parseAddress } from "../shiprocket/shiprocket.abandonment.mapper.js";
import { readCaptured } from "./abandonment.order-prefill.js";
import { buildCartSnapshot } from "../shiprocket/shiprocket.abandonment.processor.js";

const live = {
  cart_id: "c-1", phone_number: "9000000123", email: "a@b.invalid", first_name: "Priya", last_name: "Shah", total_price: 1398, currency: "INR", shipping_price: 49, tax: 0, total_discount: 10,
  discount_codes: ["WELCOME10"], source_name: "fastrr", updated_at: "2026-10-12 10:00:00",
  items: [{ product_id: 111, variant_id: 1001, sku: "TEA-100", name: "Herbal Tea", title: "100g", price: 449, quantity: 2, img_url: "https://i.example.invalid/t.png" }, { name: "No Price", quantity: 1 }],
  shipping_address: { first_name: "Priya", last_name: "Shah", phone: "9000000123", address1: "12 Rose Villa", address2: "MG Road", landmark: "Near Park", city: "Pune", state: "Maharashtra", zip: "411001", country: "India" },
  billing_address: null,
};

describe("checkout lines, totals and addresses", () => {
  it("keeps every line with ids, SKU, variant label, picture, quantity and unit price; numbers become decimal strings; a missing price is null", () => {
    const p = parseAbandonmentEvent(live)!;
    assert.deepEqual(p.lines[0], { productId: "111", variantId: "1001", sku: "TEA-100", name: "Herbal Tea", variantTitle: "100g", imageUrl: "https://i.example.invalid/t.png", quantity: 2, unitPrice: "449" });
    assert.equal(p.lines[1]!.unitPrice, null);
    assert.equal(p.lines[1]!.productId, null);
  });

  it("totals: cart total, shipping, tax, discount and codes", () => {
    assert.deepEqual(parseAbandonmentEvent(live)!.totals, { total: "1398", shipping: "49", tax: "0", discount: "10", discountCodes: ["WELCOME10"] });
  });

  it("the address maps Fastrr's keys (address1/address2/zip) onto line1/line2/pincode, and keeps only what was supplied", () => {
    assert.deepEqual(parseAbandonmentEvent(live)!.shippingAddress, { firstName: "Priya", lastName: "Shah", name: null, phone: "9000000123", line1: "12 Rose Villa", line2: "MG Road", landmark: "Near Park", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", company: null });
    assert.deepEqual(parseAddress({ city: "Pune" }), { firstName: null, lastName: null, name: null, phone: null, line1: null, line2: null, landmark: null, city: "Pune", state: null, pincode: null, country: null, company: null });
    assert.equal(parseAddress({}), null);
    assert.equal(parseAddress(null), null);
    assert.equal(parseAddress("nonsense"), null);
  });

  it("partial checkouts: email but no address; phone and an address but no email; neither is invented", () => {
    const emailOnly = parseAbandonmentEvent({ email: "a@b.invalid", cart_id: "c2", items: [{ name: "Tea", quantity: 1 }] })!;
    assert.equal(emailOnly.shippingAddress, null);
    assert.equal(emailOnly.billingAddress, null);
    assert.equal(emailOnly.lines.length, 1);
    const addrNoEmail = parseAbandonmentEvent({ phone_number: "9000000123", cart_id: "c3", shipping_address: { city: "Pune", zip: "411001" } })!;
    assert.equal(addrNoEmail.email, null);
    assert.equal(addrNoEmail.shippingAddress?.pincode, "411001");
    assert.deepEqual(addrNoEmail.lines, []);
  });

  it("the existing items / itemNames contract the Items filter uses is unchanged", () => {
    const p = parseAbandonmentEvent(live)!;
    assert.deepEqual(p.items[0], { productId: "111", variantId: "1001", sku: "TEA-100", name: "Herbal Tea", quantity: 2 });
    assert.deepEqual(p.itemNames, ["Herbal Tea", "No Price"]);
  });

  it("what is saved on the abandonment reads back identically, and a malformed JSON column reads as 'nothing captured' (never throws)", () => {
    const saved = JSON.parse(JSON.stringify(buildCartSnapshot(parseAbandonmentEvent(live)!)));
    const back = readCaptured(saved);
    assert.equal(back.lines.length, 2);
    assert.equal(back.shippingAddress?.pincode, "411001");
    assert.equal(back.totals.shipping, "49");
    assert.equal(back.customer.phone, "9000000123");
    for (const junk of [null, undefined, 5, "x", [], { lines: "no", shippingAddress: 3, totals: [] }]) {
      const r = readCaptured(junk);
      assert.deepEqual([r.lines.length, r.shippingAddress, r.billingAddress], [0, null, null]);
    }
  });
});

describe("hardening: malformed input, bounds, ordering", () => {
  it("never throws on junk: wrong types everywhere still give null or a safe value", () => {
    const junk: unknown[] = [null, undefined, 0, "x", [], [1, 2], { items: "no" }, { items: { a: 1 }, phone_number: "9000000123" }, { phone_number: ["9"], email: {} }, { phone_number: "9000000123", items: [null, 1, "a", [], { name: {} }, { name: "ok", quantity: {}, price: [] }], shipping_address: "street", billing_address: [1], total_price: {}, shipping_price: [], discount_codes: "WELCOME" }];
    for (const j of junk) assert.doesNotThrow(() => parseAbandonmentEvent(j));
    const odd = parseAbandonmentEvent({ phone_number: "9000000123", items: [null, 1, { name: "ok", quantity: {}, price: [] }], shipping_address: "street", billing_address: [1], total_price: {}, discount_codes: "WELCOME" })!;
    assert.equal(odd.lines.length, 1);
    assert.equal(odd.lines[0]!.unitPrice, null);
    assert.equal(odd.lines[0]!.quantity, null);
    assert.equal(odd.shippingAddress, null);
    assert.equal(odd.billingAddress, null);
    assert.equal(odd.totals.total, null);
    assert.deepEqual(odd.totals.discountCodes, []);
  });

  it("unit prices must be plain decimals and quantities whole numbers; hostile values are dropped, not stored", () => {
    const p = parseAbandonmentEvent({ phone_number: "9000000123", items: [{ name: "a", price: "1e3", quantity: 2.5 }, { name: "b", price: "-5", quantity: -1 }, { name: "c", price: "12.50", quantity: "3" }, { name: "d", price: "<script>", quantity: 99999999 }] })!;
    assert.deepEqual(p.lines.map((l) => [l.unitPrice, l.quantity]), [[null, null], [null, null], ["12.50", 3], [null, null]]);
  });

  it("a cart is bounded: at most 100 lines are kept", () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ name: `Item ${i}`, quantity: 1, price: "1" }));
    const p = parseAbandonmentEvent({ phone_number: "9000000123", items })!;
    assert.equal(p.lines.length, 100);
    assert.equal(p.items.length, 100);
  });

  it("a delivery with a blank, missing or non-string phone AND email is not usable (null), and one usable contact is enough", () => {
    assert.equal(parseAbandonmentEvent({ phone_number: "   ", email: "", items: [{ name: "a" }] }), null);
    assert.equal(parseAbandonmentEvent({ phone_number: null, email: null }), null);
    assert.equal(parseAbandonmentEvent({ phone_number: ["9000000123"], email: { a: 1 } }), null);
    assert.ok(parseAbandonmentEvent({ phone_number: "  ", email: "a@b.invalid" }));
    assert.ok(parseAbandonmentEvent({ phone_number: "9000000123" }));
  });

  it("an OLDER delivery never overwrites a newer saved snapshot; it only fills what is missing", () => {
    const newer = buildCartSnapshot(parseAbandonmentEvent({ ...live, cart_id: "o1", updated_at: "2026-10-12 12:00:00", shipping_address: { ...live.shipping_address, city: "Nagpur" } })!);
    const olderFull = parseAbandonmentEvent({ ...live, cart_id: "o1", updated_at: "2026-10-12 09:00:00", items: [{ name: "Old Item", quantity: 9, price: "1" }], shipping_address: { ...live.shipping_address, city: "Pune" }, total_price: "9" })!;
    const merged = buildCartSnapshot(olderFull, newer) as any;
    assert.equal(merged.shippingAddress.city, "Nagpur", "newer address kept");
    assert.deepEqual(merged.lines.map((l: any) => l.name), ["Herbal Tea", "No Price"], "newer lines kept");
    assert.equal(merged.cartValue, newer.cartValue, "top-level cart fields not regressed");
    assert.equal(merged.capturedAt, newer.capturedAt);
    // but an older delivery DOES fill in something the newer one never had
    const noAddr = buildCartSnapshot(parseAbandonmentEvent({ ...live, cart_id: "o2", updated_at: "2026-10-12 12:00:00", shipping_address: null, billing_address: null })!);
    const filled = buildCartSnapshot(olderFull, noAddr) as any;
    assert.equal(filled.shippingAddress.city, "Pune");
  });

  it("replaying the same delivery twice leaves the snapshot identical (lines are replaced, never appended)", () => {
    const once = buildCartSnapshot(parseAbandonmentEvent(live)!);
    const twice = buildCartSnapshot(parseAbandonmentEvent(live)!, once) as any;
    assert.equal(twice.lines.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)));
  });
});
