// Run with: ../backend/node_modules/.bin/tsx --test components/orders/shopify-sync-status.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AwaitingPaymentNotice, ShopifySyncBody, advice, isAwaitingPayment } from "./shopify-sync-status";
import type { ShopifySyncRecord } from "@/lib/api-client/types/orders.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const rec = (over: Partial<ShopifySyncRecord> = {}): ShopifySyncRecord => ({ status: "partial", missing: ["shippingAddress", "tags"], omitted: ["email: the CRM lead has no e-mail"], repaired: [], customer: "x", attemptedAt: "2026-10-16T06:00:00.000Z", verifiedAt: null, retryAdvice: "RETRY", error: null, ...over });
const view = (sync: ShopifySyncRecord, canResync = true) => renderToStaticMarkup(<ShopifySyncBody sync={sync} canResync={canResync} onResync={() => {}} pending={false} error={null} />);

describe("Shopify sync status on the order page", () => {
  it("complete: verified, no problems listed, no re-sync button", () => {
    const h = view(rec({ status: "complete", missing: [], verifiedAt: "2026-10-16T06:01:00.000Z", retryAdvice: "NONE" }));
    assert.match(text(h), /Complete - verified on Shopify/);
    assert.ok(!h.includes("shopify-sync-missing") && !h.includes("shopify-resync"));
  });
  it("partial: names each missing field in plain words, the last attempt, 'not fully verified', and offers a re-sync to an admin/manager", () => {
    const h = view(rec());
    const t = text(h);
    assert.match(t, /Partial - some details are not on Shopify/);
    assert.ok(t.includes("Shipping address") && t.includes("Tags"));
    assert.match(t, /not fully verified yet/);
    assert.match(t, /Not sent \(1\)/);
    assert.match(h, /data-testid="shopify-resync"/);
  });
  it("other roles see the problem and are told who can fix it, without a button", () => {
    const h = view(rec(), false);
    assert.ok(!h.includes("shopify-resync"));
    assert.match(text(h), /Ask an administrator or manager to re-sync/);
  });
  it("a problem a re-sync cannot fix (customer / shipping-required) says so and offers no button", () => {
    const h = view(rec({ missing: ["lineItems.requiresShipping"], retryAdvice: "ADMIN" }));
    assert.match(text(h), /needs an administrator's decision in Shopify/);
    assert.ok(!h.includes("shopify-resync"));
  });
  it("failed: shows the sanitized error as an alert", () => {
    const h = view(rec({ status: "failed", missing: [], error: "Shopify did not answer in time" }));
    assert.match(h, /role="alert"/);
    assert.match(text(h), /Failed/);
    assert.match(text(h), /Shopify did not answer in time/);
  });
  it("advice helper", () => {
    assert.equal(advice(rec({ status: "complete" }), true), null);
    assert.match(advice(rec(), true)!, /Re-sync to verify and repair/);
  });
  it("awaiting payment: only a prepaid order that is unpaid and not in Shopify; COD and confirmed orders never show it", () => {
    assert.equal(isAwaitingPayment({ status: "PENDING_PAYMENT", paymentMode: "PREPAID", externalNumber: null }), true);
    assert.equal(isAwaitingPayment({ status: "PENDING_PAYMENT", paymentMode: null, externalNumber: null }), true);
    assert.equal(isAwaitingPayment({ status: "PENDING_PAYMENT", paymentMode: "COD", externalNumber: null }), false);
    assert.equal(isAwaitingPayment({ status: "CONFIRMED", paymentMode: "PREPAID", externalNumber: "#1" }), false);
    const t = text(renderToStaticMarkup(<AwaitingPaymentNotice />));
    assert.match(t, /Awaiting payment\. This is a payment request, not a confirmed order/);
    assert.match(t, /does not confirm it/);
  });
});
