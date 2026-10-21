import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canMarkPaymentReceived, EXTERNAL_PAYMENT_HELP, EXTERNAL_PAYMENT_LABEL, externalPaymentFields, externalPaymentOutcome } from "./external-payment";

describe("'Payment already received' option", () => {
  it("uses the required label and helper text", () => {
    assert.equal(EXTERNAL_PAYMENT_LABEL, "Payment already received");
    assert.equal(EXTERNAL_PAYMENT_HELP, "Select this if the customer has already paid through a personal/company UPI QR code or another payment method.");
  });
  it("is offered on prepaid orders to admin / manager / salesperson only - never on COD, never to HR / recruiters", () => {
    for (const role of ["ADMIN", "MANAGER", "SALESPERSON"]) assert.equal(canMarkPaymentReceived("PAYMENT_LINK", role), true, role);
    assert.equal(canMarkPaymentReceived("COD", "ADMIN"), false);
    for (const role of ["HR", "RECRUITER", undefined]) assert.equal(canMarkPaymentReceived("PAYMENT_LINK", role), false, String(role));
  });
  it("unticked (or COD) sends NOTHING extra, so the existing flow is byte-for-byte unchanged", () => {
    assert.deepEqual(externalPaymentFields("PAYMENT_LINK", false, "UTR 1"), {});
    assert.deepEqual(externalPaymentFields("COD", true, "UTR 1"), {});
  });
  it("ticked sends the flag; the reference is optional, trimmed, capped, and omitted when blank", () => {
    assert.deepEqual(externalPaymentFields("PAYMENT_LINK", true, ""), { paymentAlreadyReceived: true });
    assert.deepEqual(externalPaymentFields("PAYMENT_LINK", true, "   "), { paymentAlreadyReceived: true });
    assert.deepEqual(externalPaymentFields("PAYMENT_LINK", true, "  UTR 4455  "), { paymentAlreadyReceived: true, paymentReference: "UTR 4455" });
    assert.equal(externalPaymentFields("PAYMENT_LINK", true, "x".repeat(300)).paymentReference?.length, 100);
    assert.ok(!("sendPaymentLinkViaWhatsApp" in externalPaymentFields("PAYMENT_LINK", true, "")), "no payment-link WhatsApp send is requested");
  });
  it("the result says 'confirmed by you outside Cashfree' and flags a Shopify problem instead of reporting full success", () => {
    const ok = externalPaymentOutcome({ shopify: { status: "created" }, manualPayment: { verification: "MANUAL_EXTERNAL", paymentId: "p", amount: "599", reference: "UTR 1", confirmedAt: null, shopifyPayment: "synced" } });
    assert.deepEqual([ok?.warn, /outside Cashfree/.test(ok!.text), /UTR 1/.test(ok!.text), /Not a Cashfree-verified/.test(ok!.text)], [false, true, true, true]);
    const failed = externalPaymentOutcome({ shopify: { status: "failed", reason: "Shopify is down" }, manualPayment: { verification: "MANUAL_EXTERNAL", paymentId: "p", amount: "599", reference: null, confirmedAt: null, shopifyPayment: "pending" } });
    assert.deepEqual([failed?.warn, /Shopify is down/.test(failed!.text), /Retry the Shopify sync/.test(failed!.text)], [true, true, true]);
    const unpaid = externalPaymentOutcome({ shopify: { status: "created" }, manualPayment: { verification: "MANUAL_EXTERNAL", paymentId: "p", amount: "599", reference: null, confirmedAt: null, shopifyPayment: "failed", shopifyReason: "not configured" } });
    assert.equal(unpaid?.warn, true);
    assert.equal(externalPaymentOutcome({ shopify: { status: "created" } }), null, "an ordinary order shows nothing");
  });
});
