import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPaymentMismatch } from "./shiprocket.payment-mismatch.js";

const base = { crmMode: "COD", crmPaid: false, crmStatus: "CONFIRMED", srMode: "COD", srTotal: "549.00", srStatus: "NEW" };

describe("payment mismatch classification", () => {
  it("the live 25: a CANCELLED CRM COD order shown by Shiprocket as Prepaid with a 0.00 total is a cancellation artefact, not a payment error", () => {
    assert.equal(classifyPaymentMismatch({ ...base, crmStatus: "CANCELLED", srMode: "prepaid", srTotal: "0.00", srStatus: "CANCELED" }), "CANCELLED_ZERO_TOTAL");
    assert.equal(classifyPaymentMismatch({ ...base, crmStatus: "CONFIRMED", srMode: "PREPAID", srTotal: 0, srStatus: "CANCELED" }), "CANCELLED_ZERO_TOTAL", "cancelled on the Shiprocket side too");
  });
  it("a LIVE COD order shown as Prepaid with a real amount is a genuine mismatch", () => {
    assert.equal(classifyPaymentMismatch({ ...base, srMode: "PREPAID", srTotal: "549.00" }), "COD_AS_PREPAID");
    assert.equal(classifyPaymentMismatch({ ...base, crmStatus: "CANCELLED", srMode: "PREPAID", srTotal: "549.00", srStatus: "CANCELED" }), "COD_AS_PREPAID", "cancelled but still carrying an amount is not the zero-total artefact");
  });
  it("a verified CRM prepaid order imported as COD is the known race", () => {
    assert.equal(classifyPaymentMismatch({ crmMode: "PREPAID", crmPaid: true, crmStatus: "CONFIRMED", srMode: "COD", srTotal: "1249.00", srStatus: "DELIVERED" }), "PREPAID_AS_COD");
  });
  it("matching modes, and an unpaid prepaid order, are not mismatches", () => {
    assert.equal(classifyPaymentMismatch(base), null);
    assert.equal(classifyPaymentMismatch({ crmMode: "PREPAID", crmPaid: true, crmStatus: "CONFIRMED", srMode: "PREPAID", srTotal: "599.00", srStatus: "NEW" }), null);
    assert.equal(classifyPaymentMismatch({ crmMode: "PREPAID", crmPaid: false, crmStatus: "CONFIRMED", srMode: "COD", srTotal: "599.00", srStatus: "NEW" }), null, "never reported as a payment error when the CRM holds no verified payment");
  });
});
