// Run with: ../backend/node_modules/.bin/tsx --test lib/discount.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { choiceCaption, choiceCents, choiceFromCoupon, defaultChoice, previewDiscount, toApiDiscount, type CouponOption } from "./discount";

const f100: CouponOption = { id: "fr-1", code: "FASTRR100", type: "FIXED", value: "100", minCartTotal: null };
const p10: CouponOption = { id: "fr-2", code: "FASTRR10P", type: "PERCENT", value: "10", minCartTotal: null };

describe("discount choice (preview of the server rules)", () => {
  it("the default is a CUSTOM discount from configuration - never a coupon", () => {
    assert.deepEqual(defaultChoice({ defaultDiscount: { type: "FIXED", value: "50" } }), { mode: "CUSTOM", type: "FIXED", value: "50" });
    assert.deepEqual(defaultChoice({ defaultDiscount: { type: "PERCENT", value: "10" } }), { mode: "CUSTOM", type: "PERCENT", value: "10" });
  });
  it("499: default ₹50 -> 449; editing to custom ₹100 REPLACES it -> 399 (not 349); 10% -> 449.10; a Fastrr coupon replaces custom", () => {
    const base = 49900;
    assert.equal(base - choiceCents(base, defaultChoice({ defaultDiscount: { type: "FIXED", value: "50" } })), 44900);
    assert.equal(base - choiceCents(base, { mode: "CUSTOM", type: "FIXED", value: "100" }), 39900);
    assert.equal(base - choiceCents(base, { mode: "CUSTOM", type: "PERCENT", value: "10" }), 44910);
    assert.equal(base - choiceCents(base, choiceFromCoupon(f100)), 39900);
    assert.equal(base - choiceCents(base, choiceFromCoupon(p10)), 44910);
    assert.equal(choiceCents(base, { mode: "NONE" }), 0);
  });
  it("validation messages mirror the server (negative, >100%, over the amount, malformed)", () => {
    assert.deepEqual(previewDiscount(49900, "FIXED", "-1"), { ok: false, error: "Discount cannot be negative" });
    assert.deepEqual(previewDiscount(49900, "PERCENT", "101"), { ok: false, error: "Discount cannot exceed 100%" });
    assert.deepEqual(previewDiscount(49900, "FIXED", "500"), { ok: false, error: "Discount cannot exceed the amount it applies to" });
    assert.deepEqual(previewDiscount(49900, "FIXED", "x"), { ok: false, error: "Enter a valid discount amount" });
    assert.deepEqual(previewDiscount(49900, "PERCENT", "x"), { ok: false, error: "Enter a valid discount percentage" });
    assert.deepEqual(previewDiscount(49900, "FIXED", ""), { ok: false, error: null });
  });
  it("Prepaid Upgrade is strict: the discount must leave something to pay", () => {
    assert.equal((previewDiscount(124900, "FIXED", "1249", true) as { error: string }).error, "Discount cannot be greater than or equal to the order amount.");
    assert.equal((previewDiscount(124900, "FIXED", "0", true) as { error: string }).error, "Discount must be greater than 0");
    assert.deepEqual(previewDiscount(124900, "FIXED", "50", true), { ok: true, cents: 5000 });
    assert.deepEqual(previewDiscount(49900, "FIXED", "499", false), { ok: true, cents: 49900 });
  });
  it("row caption: 'Custom' or 'Fastrr: CODE'; the payload carries only the choice (a code, or type+value), never an amount or total", () => {
    assert.equal(choiceCaption(choiceFromCoupon(f100)), "Fastrr: FASTRR100");
    assert.equal(choiceCaption({ mode: "CUSTOM", type: "FIXED", value: "100" }), "Custom");
    assert.equal(choiceCaption({ mode: "NONE" }), null);
    assert.deepEqual(toApiDiscount(choiceFromCoupon(f100)), { couponCode: "FASTRR100" });
    assert.deepEqual(toApiDiscount({ mode: "CUSTOM", type: "PERCENT", value: " 15 " }), { type: "PERCENT", value: "15" });
    assert.deepEqual(toApiDiscount({ mode: "NONE" }), { none: true });
  });
});
