import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentStatus } from "../../../generated/prisma/enums.js";
import { getRefundablePaymentAmount } from "../orders/orders.filters.js";
import { cashfreeOrderIdOf, refundIneligibleReason } from "./refunds.eligibility.js";
import { validateCreateBody, validateListQuery, validateRejectBody } from "./refunds.validators.js";

const PID = "11111111-1111-4111-8111-111111111111";
const ok = { externalSource: "CASHFREE", status: PaymentStatus.SUCCESS, providerPaymentId: "cf_1", metadata: { cashfree: { cashfreeOrderId: "o_1" } } };

describe("getRefundablePaymentAmount (integer cents)", () => {
  it("amount - refunded - reserved, null refunded = 0, never below 0", () => {
    assert.deepEqual(getRefundablePaymentAmount({ amount: "1000.00", refundedAmount: null }, []), { originalCents: 100000, refundedCents: 0, reservedCents: 0, refundableCents: 100000 });
    assert.equal(getRefundablePaymentAmount({ amount: "1000.00", refundedAmount: "300.00" }, [{ amount: "400.10" }, { amount: "99.90" }]).refundableCents, 20000);
    assert.equal(getRefundablePaymentAmount({ amount: "10.00", refundedAmount: "10.00" }, [{ amount: "5" }]).refundableCents, 0);
    assert.equal(getRefundablePaymentAmount({ amount: "0.30", refundedAmount: null }, [{ amount: "0.10" }, { amount: "0.20" }]).refundableCents, 0, "no floating point drift");
  });
});

describe("refund eligibility", () => {
  it("Cashfree SUCCESS / PARTIALLY_REFUNDED with both ids is eligible", () => {
    assert.equal(refundIneligibleReason(ok), null);
    assert.equal(refundIneligibleReason({ ...ok, status: PaymentStatus.PARTIALLY_REFUNDED }), null);
    assert.equal(cashfreeOrderIdOf(ok), "o_1");
  });
  it("everything else is not", () => {
    assert.match(refundIneligibleReason({ ...ok, externalSource: "SHOPIFY" })!, /not collected through Cashfree/);
    assert.match(refundIneligibleReason({ ...ok, externalSource: null })!, /not collected through Cashfree/);
    assert.match(refundIneligibleReason({ ...ok, status: PaymentStatus.FAILED })!, /successful/);
    assert.match(refundIneligibleReason({ ...ok, providerPaymentId: " " })!, /payment id/);
    assert.match(refundIneligibleReason({ ...ok, metadata: null })!, /order reference/);
    assert.match(refundIneligibleReason({ ...ok, metadata: { cashfree: { cashfreeOrderId: 5 } } })!, /order reference/);
  });
});

describe("refund request validation", () => {
  it("accepts a payment id, a money amount and a reason (trimmed)", () => {
    const r = validateCreateBody({ paymentId: PID, amount: "250.5", reason: "  Damaged  " });
    assert.equal(r.error, null);
    assert.deepEqual([r.value.amount, r.value.reason], ["250.5", "Damaged"]);
    assert.equal(validateCreateBody({ paymentId: PID, amount: 99, reason: "x" }).value.amount, "99");
  });
  it("rejects missing/blank reason, zero, negative, too many decimals, non-numbers, bad payment id", () => {
    for (const bad of [{ amount: "10", reason: "" }, { amount: "10", reason: "   " }, { amount: "10" }, { amount: "0", reason: "x" }, { amount: "0.00", reason: "x" }, { amount: "-5", reason: "x" }, { amount: "1.234", reason: "x" }, { amount: "abc", reason: "x" }, { amount: "", reason: "x" }]) {
      assert.ok(validateCreateBody({ paymentId: PID, ...bad }).error, JSON.stringify(bad));
    }
    assert.ok(validateCreateBody({ paymentId: "nope", amount: "5", reason: "x" }).error);
    assert.ok(validateCreateBody({ paymentId: PID, amount: "5", reason: "x".repeat(1001) }).error);
  });
  it("a rejection needs a note; the queue defaults to PENDING", () => {
    assert.ok(validateRejectBody({ note: "  " }).error);
    assert.ok(validateRejectBody({}).error);
    assert.equal(validateRejectBody({ note: " no " }).value.note, "no");
    assert.equal(validateListQuery({}).value.status, "PENDING");
    assert.equal(validateListQuery({ status: "ALL" }).value.status, "ALL");
    assert.ok(validateListQuery({ status: "REFUNDED" }).error);
  });
});
