// Run with: ../backend/node_modules/.bin/tsx --test components/orders/prepaid-upgrade-action.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PrepaidUpgradeActionView, upgradeActionState } from "./prepaid-upgrade-action";
import type { PrepaidUpgradeOffer, PrepaidUpgradeView } from "@/lib/api-client/types/prepaid-upgrade.types";

const offer = (status: PrepaidUpgradeOffer["status"]): PrepaidUpgradeOffer => ({
  id: "o1", status, currency: "INR", originalAmount: "1249", discountType: "FIXED", discountValue: "100.00", discountAmount: "100.00", prepaidAmount: "1149.00",
  createdById: "u", createdByName: "Tele", createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z", paymentId: "p1", paymentUrl: "https://pay.test/x",
  paidAt: null, upgradedAt: null, lastPaymentFailure: null, note: null,
});
const view = (over: Partial<PrepaidUpgradeView>): PrepaidUpgradeView => ({ orderId: "x" as string | null, shopifyReconciliation: "NOT_APPLICABLE" as const, eligible: true, isCod: true, reason: null, orderAmount: "1249", currency: "INR", offer: null, history: [], ...over });
const html = (v: PrepaidUpgradeView | null) => renderToStaticMarkup(<PrepaidUpgradeActionView state={upgradeActionState(v)} onOpen={() => {}} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("header Prepaid Upgrade action (driven only by the backend's eligibility response)", () => {
  it("eligible COD order: the Prepaid Upgrade button is rendered", () => {
    const h = html(view({}));
    assert.match(h, /<button/);
    assert.equal(text(h), "Prepaid Upgrade");
  });
  it("Shopify-synced COD order with an OFFERED/DECLINED offer: button still offered (change / offer again)", () => {
    assert.equal(text(html(view({ offer: offer("OFFERED") }))), "Prepaid Upgrade");
    assert.equal(text(html(view({ offer: offer("DECLINED") }))), "Prepaid Upgrade");
  });
  it("already-prepaid order (not COD, not eligible): nothing is rendered", () => {
    assert.equal(html(view({ eligible: false, isCod: false, reason: "This order is already prepaid." })), "");
  });
  it("no data yet (loading) or a failed lookup: nothing in the header (the panel shows the error)", () => {
    assert.equal(html(null), "");
  });
  it("COD order with a pending offer: the existing offer status is shown (not a second 'create' button)", () => {
    const h = html(view({ offer: offer("PAYMENT_PENDING") }));
    assert.equal(text(h), "Prepaid Upgrade · Payment pending");
    assert.match(h, /<button/);
  });
  it("received-but-not-converted and upgraded offers show their status", () => {
    assert.equal(text(html(view({ eligible: false, isCod: false, offer: offer("UPGRADED") }))), "Prepaid Upgrade · Prepaid upgraded");
    assert.equal(text(html(view({ eligible: false, offer: offer("PAYMENT_RECEIVED") }))), "Prepaid Upgrade · Payment received - review");
  });
  it("ineligible COD order (already paid / cancelled): an 'unavailable' explanation with the reason, and NO button", () => {
    for (const reason of ["This order already has a successful payment.", "A cancelled order can not be upgraded."]) {
      const h = html(view({ eligible: false, isCod: true, reason }));
      assert.doesNotMatch(h, /<button/);
      assert.match(text(h), /Prepaid Upgrade unavailable/);
      assert.ok(text(h).includes(`Reason: ${reason}`));
    }
  });
  it("state decisions", () => {
    assert.equal(upgradeActionState(view({})).kind, "open");
    assert.equal(upgradeActionState(view({ eligible: false, isCod: false })).kind, "none");
    assert.equal(upgradeActionState(view({ eligible: false, isCod: true, reason: "x" })).kind, "unavailable");
    assert.equal(upgradeActionState(view({ offer: offer("PAYMENT_PENDING") })).kind, "track");
  });
  it("Shopify-only COD order NOT in the CRM (orderId null, eligible by its own data): the Prepaid Upgrade button IS rendered", () => {
    const h = html(view({ orderId: null, eligible: true, isCod: true, orderAmount: "699" }));
    assert.match(h, /<button/);
    assert.equal(text(h), "Prepaid Upgrade");
  });
  it("Shopify-only order that is not COD renders nothing; COD but cancelled/refunded renders the reason, no button", () => {
    assert.equal(html(view({ orderId: null, eligible: false, isCod: false, reason: "Only Cash on Delivery orders can be upgraded to prepaid." })), "");
    const h = html(view({ orderId: null, eligible: false, isCod: true, reason: "A cancelled order can not be upgraded." }));
    assert.doesNotMatch(h, /<button/);
    assert.match(text(h), /Reason: A cancelled order can not be upgraded\./);
  });
});
