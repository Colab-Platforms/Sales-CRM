// Run with: ../backend/node_modules/.bin/tsx --test components/orders/prepaid-upgrade-link-panel.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GeneratedPanel, dialogMode } from "./prepaid-upgrade-link-panel";
import type { PrepaidUpgradeOffer } from "@/lib/api-client/types/prepaid-upgrade.types";

const LINK = "https://payments.cashfree.com/links/abc123";
const offer = (status: PrepaidUpgradeOffer["status"], over: Partial<PrepaidUpgradeOffer> = {}): PrepaidUpgradeOffer => ({
  id: "o1", status, currency: "INR", originalAmount: "699", discountType: "FIXED", discountValue: "100.00", discountAmount: "100.00", prepaidAmount: "599.00",
  createdById: "u", createdByName: "Tele", createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z", paymentId: "p1", paymentUrl: LINK,
  paidAt: null, upgradedAt: null, lastPaymentFailure: null, note: null, ...over,
});
const render = (o: PrepaidUpgradeOffer, paymentId: string | null = "p1", recon?: "COMPLETED" | "PENDING" | "FAILED" | "NOT_APPLICABLE") =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GeneratedPanel offer={o} paymentId={paymentId} shopifyReconciliation={recon} />
    </QueryClientProvider>,
  );
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("Prepaid Upgrade dialog: generated state (same dialog, no navigation)", () => {
  it("a freshly generated offer shows ₹699 → −₹100 → ₹599, Payment Pending, the real link, Copy Link and Send on WhatsApp", () => {
    const h = render(offer("PAYMENT_PENDING"));
    const t = text(h);
    assert.match(t, /Payment Link Generated/);
    assert.match(t, /Original Amount ₹699\.00/);
    assert.match(t, /Discount −₹100\.00/);
    assert.match(t, /Customer Pays ₹599\.00/);
    assert.match(t, /Status Payment Pending/);
    assert.ok(h.includes(LINK), "the actual generated link is displayed");
    assert.match(t, /Copy Link/);
    assert.match(t, /Send on WhatsApp/);
    assert.match(t, /stays Cash on Delivery until this link is paid/);
  });
  it("it never offers Generate Payment Link again for the same active offer", () => {
    assert.doesNotMatch(render(offer("PAYMENT_PENDING")), /Generate Payment Link/);
  });
  it("no payment id (nothing to send against): Copy Link stays, Send on WhatsApp is not offered", () => {
    const t = text(render(offer("PAYMENT_PENDING"), null));
    assert.match(t, /Copy Link/);
    assert.doesNotMatch(t, /Send on WhatsApp/);
  });
  it("after the verified payment it reads Prepaid Upgraded with the amount paid and no link actions", () => {
    const h = render(offer("UPGRADED", { paymentUrl: null }));
    const t = text(h);
    assert.match(t, /Prepaid Upgraded/);
    assert.match(t, /Paid ₹599\.00/);
    assert.doesNotMatch(t, /Copy Link|Send on WhatsApp/);
  });
  it("after payment it shows Original 699 / Discount 100 / Paid 599, Payment Prepaid, and the Shopify reconciliation state separately from payment received", () => {
    const upgraded = offer("UPGRADED", { paymentUrl: null });
    for (const [state, label] of [["COMPLETED", "Completed"], ["PENDING", "Pending"], ["FAILED", "Failed - an admin needs to retry"]] as const) {
      const t = text(render(upgraded, "p1", state));
      assert.match(t, /Original Amount ₹699\.00/);
      assert.match(t, /Discount −₹100\.00/);
      assert.match(t, /Paid ₹599\.00/);
      assert.match(t, /Payment Prepaid/);
      assert.ok(t.includes(`Shopify reconciliation ${label}`), t);
    }
    assert.doesNotMatch(text(render(upgraded, "p1", "NOT_APPLICABLE")), /Shopify reconciliation/);
    assert.doesNotMatch(text(render(offer("PAYMENT_PENDING"), "p1", "PENDING")), /Shopify reconciliation/, "not shown until the order is actually upgraded");
  });
  it("dialogMode: the form only until a link exists; pending / paid offers show the generated state", () => {
    assert.equal(dialogMode(null), "form");
    assert.equal(dialogMode({ status: "OFFERED" }), "form");
    assert.equal(dialogMode({ status: "DECLINED" }), "form");
    for (const status of ["PAYMENT_PENDING", "UPGRADED", "PAYMENT_RECEIVED"] as const) assert.equal(dialogMode({ status }), "generated");
  });
});
