import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { paymentFigures } from "./payment-figures";

type Input = Parameters<typeof paymentFigures>[0];
const pay = (status: string, amount: string): Input["payments"][number] => ({ id: `p-${status}-${amount}`, status, method: null, amount, currency: "INR", provider: null, providerPaymentId: null, transactionReference: null, paidAt: null, failedAt: null, refundedAt: null, refundedAmount: null, failureReason: null, createdAt: "2026-10-07T00:00:00Z", source: null, paymentUrl: null, paymentExpiresAt: null }) as never;
const order = (over: Partial<Input> = {}): Input => ({ status: "CANCELLED", totalAmount: "100", paidAmount: "100.00", refundedAmount: "0.00", outstandingAmount: "0.00", payments: [pay("SUCCESS", "100")], refunds: { payments: [{ paymentId: "p", method: null, status: "SUCCESS", currency: "INR", amount: "100.00", refundedAmount: "0.00", reservedAmount: "0.00", refundableAmount: "100.00", shopifyRefundableAmount: null, limitedByShopify: false, eligible: true, canResolve: false, ineligibleReason: null }], requests: [] } as never, ...over }) as Input;

describe("payment figures: Original paid / Refunded / Net paid (held) / Refundable now", () => {
  it("paid and cancelled, nothing refunded yet: original 100, refunded 0, net 100, refundable 100", () => {
    assert.deepEqual(paymentFigures(order()), { orderAmount: "100.00", originalPaid: "100.00", refunded: "0.00", netPaid: "100.00", refundableNow: "100.00", outstanding: "0.00" });
  });

  it("after a FULL refund the original paid amount stays visible while net held and refundable become 0 (why 'Paid' used to read 0.00)", () => {
    const f = paymentFigures(order({ paidAmount: "0.00", refundedAmount: "100.00", payments: [pay("REFUNDED", "100")], refunds: { payments: [{ amount: "100.00", refundableAmount: "0.00", eligible: false }], requests: [] } as never }));
    assert.deepEqual([f.originalPaid, f.refunded, f.netPaid, f.refundableNow], ["100.00", "100.00", "0.00", "0.00"]);
  });

  it("after a PARTIAL refund: original 100, refunded 40, net 60, refundable 60", () => {
    const f = paymentFigures(order({ paidAmount: "60.00", refundedAmount: "40.00", payments: [pay("PARTIALLY_REFUNDED", "100")], refunds: { payments: [{ amount: "100.00", refundableAmount: "60.00", eligible: true }], requests: [] } as never }));
    assert.deepEqual([f.originalPaid, f.refunded, f.netPaid, f.refundableNow], ["100.00", "40.00", "60.00", "60.00"]);
  });

  it("an ACTIVE (not cancelled) paid order already shows its refundable amount - the order status does not hide it", () => {
    assert.equal(paymentFigures(order({ status: "CONFIRMED" })).refundableNow, "100.00");
    assert.equal(paymentFigures(order({ status: "DELIVERED" })).refundableNow, "100.00");
  });

  it("only paid payments count as 'paid': pending, failed and retired COD rows are ignored (original paid is not inflated)", () => {
    const f = paymentFigures(order({ totalAmount: "101", payments: [pay("SUCCESS", "100"), pay("FAILED", "101"), pay("PENDING", "50")] }));
    assert.equal(f.originalPaid, "100.00");
    assert.equal(paymentFigures(order({ payments: [pay("PENDING", "100")], paidAmount: "0.00", refunds: { payments: [{ amount: "100.00", refundableAmount: "0.00", eligible: false }], requests: [] } as never })).refundableNow, "0.00");
  });

  it("a cancelled order whose payment is not refundable shows refundable 0.00 (COD / unpaid)", () => {
    const f = paymentFigures(order({ paidAmount: "0.00", payments: [pay("PENDING", "100")], refunds: { payments: [{ amount: "100.00", refundableAmount: "100.00", eligible: false }], requests: [] } as never }));
    assert.deepEqual([f.originalPaid, f.refundableNow], ["0.00", "0.00"]);
  });
});
