// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/discount-section.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscountPricing } from "./discount-section";
import { EditorBody } from "@/components/discounts/discount-editor";
import { choiceFromCoupon, defaultChoice, type CouponOption, type DiscountOptions } from "@/lib/discount";

const coupons: CouponOption[] = [
  { id: "fr-1", code: "FASTRR100", type: "FIXED", value: "100", minCartTotal: null },
  { id: "fr-2", code: "FASTRR10P", type: "PERCENT", value: "10", minCartTotal: null },
];
const fastrr: DiscountOptions["fastrr"] = { available: true, coupons, reason: null };
const unavailable: DiscountOptions["fastrr"] = { available: false, coupons: [], reason: "FASTRR_API_TOKEN is not set" };
const DEFAULT = defaultChoice({ defaultDiscount: { type: "FIXED", value: "50" } });
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const pricing = (choice: Parameters<typeof DiscountPricing>[0]["choice"]) =>
  text(renderToStaticMarkup(<DiscountPricing subtotalCents={49900} shippingCents={0} choice={choice} onChange={() => {}} fastrr={fastrr} isPrepaid={false} />));
const editor = (current = DEFAULT, f = fastrr) => renderToStaticMarkup(<EditorBody onOpenChange={() => {}} current={current} fastrr={f} baseCents={49900} onApply={() => {}} />);

describe("Review Order summary", () => {
  it("default custom ₹50: Subtotal 499, Discount Custom −₹50 Edit, Shipping, Tax, Total 449 - and no SAVE* code", () => {
    const t = pricing(DEFAULT);
    assert.match(t, /Subtotal ₹499\.00/);
    assert.match(t, /Discount Custom −₹50\.00 Edit/);
    assert.match(t, /Shipping ₹0\.00/);
    assert.match(t, /Tax ₹0\.00/);
    assert.match(t, /Total ₹449\.00/);
    assert.doesNotMatch(t, /SAVE\d/);
  });
  it("edited to custom ₹100 REPLACES the default: total 399, never 349", () => {
    const t = pricing({ mode: "CUSTOM", type: "FIXED", value: "100" });
    assert.match(t, /Discount Custom −₹100\.00 Edit/);
    assert.match(t, /Total ₹399\.00/);
    assert.doesNotMatch(t, /₹349/);
  });
  it("custom 10% uses paise rounding; a Fastrr coupon shows 'Fastrr: CODE' and replaces the custom discount", () => {
    assert.match(pricing({ mode: "CUSTOM", type: "PERCENT", value: "10" }), /−₹49\.90/);
    assert.match(pricing(choiceFromCoupon(coupons[0])), /Discount Fastrr: FASTRR100 −₹100\.00 Edit[\s\S]*Total ₹399\.00/);
  });
});

describe("Edit Discount dialog", () => {
  it("offers only Custom Discount and Coupon Code (and No discount); default custom ₹50 is current, with Fixed/Percentage and Cancel/Apply", () => {
    const h = editor();
    const t = text(h);
    assert.match(t, /Current Discount ₹50\.00/);
    assert.match(t, /Custom Discount/);
    assert.match(t, /Coupon Code/);
    assert.match(t, /Fixed ₹/);
    assert.match(t, /Percentage %/);
    assert.match(t, /Cancel/);
    assert.match(t, /Apply/);
    assert.doesNotMatch(t, /SAVE\d/);
    assert.match(h, /value="CUSTOM"[^>]*selected|selected[^>]*value="CUSTOM"/);
  });
  it("Coupon Code lists ONLY the Fastrr coupons it was given", () => {
    const t = text(editor(choiceFromCoupon(coupons[0])));
    assert.match(t, /Select Fastrr Coupon/);
    assert.match(t, /FASTRR100 — ₹100 off/);
    assert.match(t, /FASTRR10P — 10% off/);
    assert.doesNotMatch(t, /SAVE\d/);
  });
  it("when Fastrr is unavailable it says so (with the reason) instead of showing any coupon", () => {
    const t = text(editor(choiceFromCoupon(coupons[0]), unavailable));
    assert.match(t, /Fastrr coupons unavailable — FASTRR_API_TOKEN is not set/);
    assert.doesNotMatch(t, /Select Fastrr Coupon|FASTRR100/);
  });
});
