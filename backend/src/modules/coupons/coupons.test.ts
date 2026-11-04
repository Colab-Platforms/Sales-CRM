// Run with: npx tsx --test src/modules/coupons/coupons.test.ts   (no database)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCoupon, validateCouponInput, type CouponRow } from "./coupons.service.js";

const d = (v: string) => ({ toString: () => v }) as never;
const coupon = (over: Partial<CouponRow> = {}): CouponRow => ({ id: "c1", code: "X", discountType: "FIXED", discountValue: d("500.00"), eligibleCustomerType: null, minOrderValue: null, maxDiscount: null, isActive: true, deletedAt: null, ...over });
const DIST = coupon({ code: "DISTRIBUTOR500", eligibleCustomerType: "DISTRIBUTOR" });

describe("evaluateCoupon", () => {
  it("DISTRIBUTOR500 is exactly Rs 500 for a distributor", () => {
    assert.deepEqual(evaluateCoupon(DIST, "DISTRIBUTOR", 119_900), { ok: true, amountCents: 50_000 });
    assert.deepEqual(evaluateCoupon(DIST, "DISTRIBUTOR", 50_000), { ok: true, amountCents: 50_000 }, "exactly the subtotal is fine");
  });
  it("is refused for anyone who is not a distributor, with the reason", () => {
    const r = evaluateCoupon(DIST, "REGULAR", 119_900);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /Only for distributors/);
  });
  it("never exceeds the subtotal", () => {
    const r = evaluateCoupon(DIST, "DISTRIBUTOR", 49_999);
    assert.deepEqual(r, { ok: false, reason: "The discount is more than the order amount" });
  });
  it("inactive and deleted coupons are refused", () => {
    assert.match((evaluateCoupon(coupon({ isActive: false }), "REGULAR", 10_000) as { reason: string }).reason, /not active/);
    assert.match((evaluateCoupon(coupon({ deletedAt: new Date() }), "REGULAR", 10_000) as { reason: string }).reason, /no longer available/);
  });
  it("minimum order value", () => {
    const c = coupon({ minOrderValue: d("1000.00"), discountValue: d("100.00") });
    assert.equal(evaluateCoupon(c, "REGULAR", 99_999).ok, false);
    assert.deepEqual(evaluateCoupon(c, "REGULAR", 100_000), { ok: true, amountCents: 10_000 });
  });
  it("percentage with and without a maximum", () => {
    const pct = coupon({ discountType: "PERCENT", discountValue: d("10.00") });
    assert.deepEqual(evaluateCoupon(pct, "REGULAR", 123_450), { ok: true, amountCents: 12_345 });
    assert.deepEqual(evaluateCoupon({ ...pct, maxDiscount: d("100.00") }, "REGULAR", 123_450), { ok: true, amountCents: 10_000 });
  });
  it("an all-customers coupon works for both types", () => {
    for (const t of ["REGULAR", "DISTRIBUTOR"] as const) assert.equal(evaluateCoupon(coupon(), t, 100_000).ok, true);
  });
});

describe("validateCouponInput", () => {
  const ok = { code: " distributor500 ", discountType: "FIXED" as const, discountValue: "500", eligibility: "DISTRIBUTOR" as const };
  it("upper-cases the code and reads eligibility", () => {
    const v = validateCouponInput(ok);
    assert.equal(v.code, "DISTRIBUTOR500");
    assert.equal(v.eligibleCustomerType, "DISTRIBUTOR");
    assert.equal(validateCouponInput({ ...ok, eligibility: "ALL" }).eligibleCustomerType, null);
  });
  it("rejects bad codes, values, percentages, maximums on a fixed coupon", () => {
    for (const [patch, re] of [
      [{ code: "a b" }, /Coupon code/], [{ code: "ab" }, /Coupon code/],
      [{ discountValue: "0" }, /greater than 0/], [{ discountValue: "-5" }, /greater than 0/], [{ discountValue: "abc" }, /greater than 0/], [{ discountValue: "1.234" }, /greater than 0/],
      [{ discountType: "PERCENT" as const, discountValue: "101" }, /exceed 100/],
      [{ maxDiscount: "100" }, /only applies to percentage/],
      [{ minOrderValue: "-1" }, /Minimum order value/],
    ] as const) assert.throws(() => validateCouponInput({ ...ok, ...patch }), re, JSON.stringify(patch));
    assert.doesNotThrow(() => validateCouponInput({ ...ok, discountType: "PERCENT", discountValue: "10", maxDiscount: "200", minOrderValue: "999" }));
  });
});
