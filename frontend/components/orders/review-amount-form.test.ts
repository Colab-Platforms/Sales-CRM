import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canCorrect, changeSentence, differingRows, failedGates, reviewedText } from "./review-amount-form";
import type { AmountPreview } from "@/lib/api-client/types/orders.types";

const base = (over: Partial<AmountPreview> = {}): AmountPreview => ({
  orderId: "o", orderNumber: "CRM-1", comparable: true, note: null, stateToken: "abcdef123456", lastReviewedAt: null, canExecute: true, canApply: true, blockedReason: null, manualReason: null, courier: null,
  rows: [{ key: "shipping", label: "Shipping", crm: "50.00", shopify: "0.00 (0 lines)", status: "DIFFERENT" }, { key: "tax", label: "Tax", crm: "0.00", shopify: "0.00", status: "SAME" }],
  proposal: { kind: "ADD_SHIPPING_LINE", title: "Shipping", amount: "50.00", currency: "INR", before: { total: "649.00", outstanding: "649.00", shippingLines: 0 }, after: { total: "699.00", outstanding: "699.00", shippingLines: 1 }, reason: "r", risk: "k" },
  gates: [{ key: "courier", label: "Courier amount agrees", ok: true, detail: "ok" }], ...over,
});

describe("review & correct amount dialog rules", () => {
  it("the correction needs every condition: gates, role, tick, the corrected total typed exactly, and nothing running", () => {
    assert.equal(canCorrect(base(), true, "699.00", false), true);
    assert.equal(canCorrect(base(), true, " 699.00 ", false), true);
    assert.equal(canCorrect(base(), false, "699.00", false), false, "no tick");
    assert.equal(canCorrect(base(), true, "649.00", false), false, "wrong total typed");
    assert.equal(canCorrect(base(), true, "699", false), false, "must match the shown total exactly");
    assert.equal(canCorrect(base(), true, "699.00", true), false, "already running");
    assert.equal(canCorrect(base({ canApply: false }), true, "699.00", false), false, "a gate fails (for example the courier amount)");
    assert.equal(canCorrect(base({ canExecute: false }), true, "699.00", false), false, "telecaller");
    assert.equal(canCorrect(base({ proposal: null }), true, "699.00", false), false);
    assert.equal(canCorrect(base({ stateToken: null }), true, "699.00", false), false);
    assert.equal(canCorrect(null, true, "699.00", false), false);
  });
  it("describes the change and lists the failing gates and differing rows", () => {
    assert.equal(changeSentence(base()), "Shopify total 649.00 -> 699.00 (outstanding 649.00 -> 699.00), adding a 50.00 shipping line");
    assert.equal(changeSentence(base({ proposal: null })), null);
    const p = base({ gates: [{ key: "courier", label: "Courier amount agrees", ok: false, detail: "649.00, not 699.00" }, { key: "cod", label: "COD", ok: true, detail: "" }] });
    assert.deepEqual(failedGates(p).map((g) => g.key), ["courier"]);
    assert.deepEqual(differingRows(p).map((r) => r.key), ["shipping"]);
    assert.equal(reviewedText(null, String), "No amount correction recorded");
  });
});
