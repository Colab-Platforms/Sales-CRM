import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEvent, SUPPORTED_TYPES } from "./cashfree.events.js";
import { eventToUpdate } from "./cashfree.webhook.processor.js";
import { resolvePublicBackendUrl } from "./cashfree.config.js";
import { createCashfreeReconciler, loadReconcileMinutes } from "./cashfree.catchup.js";
import { crmDiscountFigures } from "./cashfree.payment-success.js";
import { normalizeShopifyOrderId, shopifyOrderIdVariants } from "../shopify/shopify.money.js";
import { toShopifyOrderGid } from "../shopify/shopify.orders.write.js";

const D = (v: string) => ({ toString: () => v });

describe("notify_url / public backend URL", () => {
  it("accepts only a public https URL", () => {
    assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: "https://crm.example.com/" }), "https://crm.example.com");
    for (const bad of ["http://crm.example.com", "https://localhost:5000", "https://127.0.0.1", "https://192.168.1.4", "https://10.0.0.2", "https://backend", "ftp://x.com", ""]) {
      assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: bad }), null, bad);
    }
  });
  it("prefers PUBLIC_BACKEND_URL, falls back to Render's own URL, never hard-codes one", () => {
    assert.equal(resolvePublicBackendUrl({ PUBLIC_BACKEND_URL: "https://a.example.com", RENDER_EXTERNAL_URL: "https://b.example.com" }), "https://a.example.com");
    assert.equal(resolvePublicBackendUrl({ RENDER_EXTERNAL_URL: "https://b.example.com" }), "https://b.example.com");
    assert.equal(resolvePublicBackendUrl({}), null);
  });
});

describe("Shopify order id canonicalisation", () => {
  it("GID -> numeric and back, old GID rows stay discoverable", () => {
    assert.equal(normalizeShopifyOrderId("gid://shopify/Order/18929899962557"), "18929899962557");
    assert.equal(normalizeShopifyOrderId("18929899962557"), "18929899962557");
    assert.deepEqual(shopifyOrderIdVariants("gid://shopify/Order/18929899962557"), ["18929899962557", "gid://shopify/Order/18929899962557"]);
    assert.deepEqual(shopifyOrderIdVariants("18929899962557"), ["18929899962557", "gid://shopify/Order/18929899962557"]);
    assert.equal(toShopifyOrderGid("18929899962557"), "gid://shopify/Order/18929899962557");
  });
});

describe("CRM discount figures for Shopify", () => {
  const order = (over: Record<string, unknown> = {}) => ({ currency: "INR", subtotal: D("1199"), discountAmount: D("1198"), totalAmount: D("1"), payments: [{ status: "SUCCESS", amount: D("1"), refundedAmount: null }], ...over }) as never;
  it("1199 - 1198 = 1 collected 1", () => {
    assert.deepEqual(crmDiscountFigures(order()), { originalAmount: "1199.00", discountAmount: "1198.00", prepaidAmount: "1.00", currency: "INR" });
  });
  it("refuses to mirror when collected differs from the total, or the total has other adjustments", () => {
    assert.ok("problem" in crmDiscountFigures(order({ payments: [{ status: "SUCCESS", amount: D("0.5"), refundedAmount: null }] })));
    assert.ok("problem" in crmDiscountFigures(order({ totalAmount: D("51") })));
  });
});

describe("Cashfree reconciler", () => {
  const runner = (ids: string[]) => ({ $transaction: async (fn: (tx: unknown) => unknown) => fn({ payment: { findMany: async () => ids.map((id) => ({ id })) } }) }) as never;
  it("reconciles each open payment through the shared path and keeps going after an error", async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const r = createCashfreeReconciler({ runner: runner(["a", "b", "c"]), reconcile: async (id) => { seen.push(id); if (id === "b") throw new Error("boom"); return id === "a" ? "updated" : "unchanged"; }, onError: (e) => errors.push(e) });
    assert.deepEqual(await r.tick(), { checked: 3, updated: 1, errors: 1 });
    assert.deepEqual(seen, ["a", "b", "c"]);
    assert.equal(errors.length, 1);
  });
  it("does not overlap passes; interval config", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = createCashfreeReconciler({ runner: runner(["a"]), reconcile: async () => { await gate; return "unchanged"; } });
    const first = r.tick();
    assert.equal(await r.tick(), null);
    release();
    assert.equal((await first)?.checked, 1);
    assert.equal(loadReconcileMinutes({}), 0); // opt-in
    assert.equal(loadReconcileMinutes({ CASHFREE_RECONCILE_MINUTES: "0" }), 0);
    assert.equal(loadReconcileMinutes({ CASHFREE_RECONCILE_MINUTES: "x" }), 0);
    assert.equal(loadReconcileMinutes({ CASHFREE_RECONCILE_MINUTES: "5" }), 5);
  });
});

describe("refund webhook payload", () => {
  it("is a supported type and parses refund id / order / status / amount (2022-09-01 shape)", () => {
    assert.ok((SUPPORTED_TYPES as readonly string[]).includes("REFUND_STATUS_WEBHOOK"));
    const ev = parseEvent({ type: "REFUND_STATUS_WEBHOOK", data: { refund: { cf_refund_id: 123, refund_id: "rfabc", order_id: "ORD_1", refund_amount: 100, refund_status: "success" } } });
    assert.deepEqual(ev, { kind: "refund", refundId: "rfabc", orderId: "ORD_1", rawStatus: "SUCCESS", amount: "100", cfRefundId: "123" });
    assert.equal(parseEvent({ type: "REFUND_STATUS_WEBHOOK", data: {} }), null);
  });
  it("is never turned into a payment update", () => {
    const ev = parseEvent({ type: "REFUND_STATUS_WEBHOOK", data: { refund: { refund_id: "rfabc", refund_status: "SUCCESS" } } })!;
    assert.equal(eventToUpdate(ev, new Date()), null);
  });
});
