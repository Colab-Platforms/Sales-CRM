import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import { ORDER_ONLY_VARIABLES, RESOLVABLE_VARIABLES, resolveTemplateVariables, type VariableResolutionContext } from "./whatsapp.variable-resolver.js";

// The Cashfree payment link is delivered through the existing E7.3 template messaging. These check the two variables that
// make that possible: a template can only ever resolve to a real, still-open link - never a dead or invented one.

const URL = "https://payments-test.cashfree.com/links/abc";
const HOUR = 3_600_000;

const ctx = (payments: VariableResolutionContext["order"] extends infer O ? (O extends { payments: infer P } ? P : never) : never): VariableResolutionContext => ({
  lead: { firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "919876500000", email: null },
  order: { orderNumber: "SHP-1001", externalNumber: "#1001", status: "CONFIRMED", currency: "INR", totalAmount: "649.00", payments, latestShipment: null },
});

const link = (over: Record<string, unknown> = {}) => ({ status: PaymentStatus.PENDING, method: PaymentMethod.PAYMENT_LINK, amount: "449.00", refundedAmount: null, paymentUrl: URL, paymentExpiresAt: new Date(Date.now() + HOUR), ...over });

describe("payment link template variables", () => {
  it("are resolvable and order-only", () => {
    assert.ok(RESOLVABLE_VARIABLES.includes("payment_link") && RESOLVABLE_VARIABLES.includes("payment_amount"));
    assert.ok(ORDER_ONLY_VARIABLES.has("payment_link") && ORDER_ONLY_VARIABLES.has("payment_amount"));
  });

  it("resolve to the open link and its exact amount", () => {
    const result = resolveTemplateVariables(["customer_name", "payment_amount", "payment_link"], ctx([link()]));
    assert.deepEqual(result.errors, []);
    assert.equal(result.values.payment_link, URL);
    assert.equal(result.values.payment_amount, "₹449.00");
  });

  it("fail validation - rather than send a dead link - when the link is paid, failed or expired", () => {
    for (const dead of [link({ status: PaymentStatus.SUCCESS }), link({ status: PaymentStatus.FAILED }), link({ paymentExpiresAt: new Date(Date.now() - HOUR) })]) {
      const result = resolveTemplateVariables(["payment_link"], ctx([dead]));
      assert.deepEqual(result.errors, ["Missing value for variable: payment_link"]);
    }
  });

  it("fail validation when the order has no payment link at all, or no order is selected", () => {
    assert.equal(resolveTemplateVariables(["payment_link"], ctx([{ status: PaymentStatus.SUCCESS, method: PaymentMethod.UPI, amount: "649.00", refundedAmount: null }])).errors.length, 1);
    assert.equal(resolveTemplateVariables(["payment_link"], { ...ctx([]), order: null }).errors.length, 1);
  });

  it("pick the open link even when older payments exist, and leave every existing variable untouched", () => {
    const result = resolveTemplateVariables(["order_number", "outstanding_amount", "payment_link"], ctx([link(), { status: PaymentStatus.FAILED, method: PaymentMethod.UPI, amount: "100.00", refundedAmount: null }]));
    assert.deepEqual(result.errors, []);
    assert.equal(result.values.order_number, "SHP-1001");
    assert.equal(result.values.payment_link, URL);
  });
});
