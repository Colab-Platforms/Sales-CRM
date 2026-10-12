import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refundBalance, SHOPIFY_CURRENCY_REASON, SHOPIFY_UNCONFIRMED_REASON } from "./refunds.balance.js";
import { cashfreeVerificationOf, shopifyRefundableOf, shopifyUnverifiedReason } from "./refunds.eligibility.js";

// The rule: a payment's refundable balance is the CRM's own (amount - refunded - held by open requests); for a SHOPIFY payment it is never more than Shopify's
// own remaining refundable amount (what Shopify reports, minus what open requests already hold). Nothing here knows any particular figure.
const pay = (over: Partial<{ amount: string; refundedAmount: string | null; currency: string; externalSource: string | null }> = {}) => ({ amount: "820.00", refundedAmount: null, currency: "INR", externalSource: "SHOPIFY", ...over });
const meta = (amount: string | null, currency = "INR") => (amount === null ? {} : { shopifyRefundable: { amount, currency } });
const held = (...amounts: string[]) => amounts.map((amount) => ({ amount }));

describe("refund balance with Shopify's refundable amount", () => {
  it("never exceeds Shopify's amount, whatever it is (the CRM balance alone would allow the original payment)", () => {
    for (const [shopify, expected] of [["584.10", 58410], ["300.00", 30000], ["820.00", 82000], ["1000.00", 82000], ["0.00", 0], ["0.01", 1]] as const) {
      const b = refundBalance(pay(), [], meta(shopify));
      assert.equal(b.refundableCents, expected, shopify);
      assert.equal(b.blockedReason, null);
    }
    assert.equal(refundBalance(pay(), [], meta("584.10")).limitedByShopify, true);
    assert.equal(refundBalance(pay(), [], meta("1000.00")).limitedByShopify, false, "the CRM's own balance is the lower one");
  });

  it("is the lower of the two when both limit: Shopify's remaining after open requests, and the CRM's after refunds", () => {
    assert.equal(refundBalance(pay(), held("300.00"), meta("584.10")).refundableCents, 28410);
    assert.equal(refundBalance(pay({ refundedAmount: "235.90" }), [], meta("584.10")).refundableCents, 58410);
    assert.equal(refundBalance(pay({ refundedAmount: "700.00" }), [], meta("584.10")).refundableCents, 12000, "CRM balance (120) is lower than Shopify's 584.10");
    assert.equal(refundBalance(pay(), held("600.00"), meta("584.10")).refundableCents, 0);
  });

  it("an unknown, malformed or other-currency Shopify amount blocks a Shopify payment (unknown is never 'no limit')", () => {
    assert.deepEqual([refundBalance(pay(), [], meta(null)).refundableCents, refundBalance(pay(), [], meta(null)).blockedReason], [0, SHOPIFY_UNCONFIRMED_REASON]);
    assert.equal(refundBalance(pay(), [], null).blockedReason, SHOPIFY_UNCONFIRMED_REASON);
    assert.equal(refundBalance(pay(), [], meta("abc")).blockedReason, SHOPIFY_UNCONFIRMED_REASON);
    assert.equal(refundBalance(pay(), [], meta("-5.00")).blockedReason, SHOPIFY_UNCONFIRMED_REASON);
    const usd = refundBalance(pay(), [], meta("584.10", "USD"));
    assert.deepEqual([usd.refundableCents, usd.blockedReason], [0, SHOPIFY_CURRENCY_REASON]);
  });

  it("a CRM-created (Cashfree link) payment is not affected by any Shopify figure", () => {
    for (const source of ["CASHFREE", null]) {
      const b = refundBalance(pay({ externalSource: source }), held("20.00"), meta("1.00"));
      assert.deepEqual([b.refundableCents, b.shopifyCents, b.limitedByShopify, b.blockedReason], [80000, null, false, null]);
    }
  });
});

describe("what is stored from Shopify and from the verification", () => {
  it("reads Shopify's amount only when it is a proper amount in a currency", () => {
    assert.deepEqual(shopifyRefundableOf({ shopifyRefundable: { amount: "584.10", currency: "INR" } }), { amount: "584.10", currency: "INR" });
    assert.deepEqual(shopifyRefundableOf({ shopifyRefundable: { amount: "0", currency: "INR" } }), { amount: "0", currency: "INR" });
    for (const bad of [null, {}, { shopifyRefundable: {} }, { shopifyRefundable: { amount: "584.123", currency: "INR" } }, { shopifyRefundable: { amount: "1", currency: "" } }, { shopifyRefundable: { amount: 5, currency: "INR" } }]) {
      assert.equal(shopifyRefundableOf(bad), null, JSON.stringify(bad));
    }
  });
  it("explains a Shopify payment that is not verified: the recorded failure, or that verification has not happened yet", () => {
    assert.match(shopifyUnverifiedReason(null), /has not been verified yet/);
    assert.equal(shopifyUnverifiedReason({ cashfreeVerification: { status: "FAILED", reason: "Cashfree has no order. ", checkedAt: "2026-10-08T00:00:00Z" } }), "Cashfree verification failed: Cashfree has no order.");
    assert.match(shopifyUnverifiedReason({ cashfreeVerification: { status: "FAILED" } }), /^Cashfree verification failed: the payment could not be matched at Cashfree\.$/);
    assert.deepEqual(cashfreeVerificationOf({ cashfreeVerification: { status: "VERIFIED", checkedAt: "x" } }), { status: "VERIFIED", reason: null, checkedAt: "x" });
    assert.equal(cashfreeVerificationOf({ cashfreeVerification: { status: "MAYBE" } }), null);
  });
});
