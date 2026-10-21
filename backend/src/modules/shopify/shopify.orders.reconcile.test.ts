import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcilePrepaidUpgrade, ShopifyReconcileError } from "./shopify.orders.reconcile.js";
import { FakeShopifyOrder } from "./shopify.fake-order-editor.js";

const INPUT = { originalAmount: "699", discountAmount: "100.00", prepaidAmount: "599.00", currency: "INR", upgradeReference: "SHP-AWL101294" };
const run = (o: FakeShopifyOrder, over: Partial<typeof INPUT> = {}) => reconcilePrepaidUpgrade(o.client, o.orderId, { ...INPUT, ...over });

describe("reconcilePrepaidUpgrade: 699 original, 100 prepaid discount, 599 collected", () => {
  it("edits the existing order to 599 (the 100 as a line discount), then records exactly 599 - never 699", async () => {
    const o = new FakeShopifyOrder();
    const r = await run(o);
    assert.equal(r.performed, "edit_and_payment");
    assert.deepEqual([o.total, o.received, o.outstanding, o.status], [59900, 59900, 0, "PAID"]);
    assert.deepEqual(o.committedDiscounts, [10000]);
    assert.deepEqual(o.paymentsRecorded.map((p) => p.amount), [59900], "one payment, for 599");
    assert.equal(o.markAsPaidCalls, 0, "the whole-order mark-as-paid (699) is never used");
    assert.ok(!o.paymentsRecorded.some((p) => p.amount === 69900), "699 is never recorded as collected");
    assert.match(o.paymentsRecorded[0]!.method!, /Cashfree/);
    assert.equal(r.received, "599.00");
  });
  it("it is the SAME order: id and name unchanged, no order created", async () => {
    const o = new FakeShopifyOrder();
    const r = await run(o);
    assert.equal(r.shopifyOrderId, "gid://shopify/Order/5551234567");
    assert.equal(o.orderName, "#AWL101294");
    assert.equal(o.ordersCreated, 0);
  });
  it("idempotent: running it again changes nothing (no second discount, no second payment)", async () => {
    const o = new FakeShopifyOrder();
    await run(o);
    const again = await run(o);
    assert.equal(again.performed, "already_reconciled");
    assert.deepEqual([o.committedDiscounts.length, o.paymentsRecorded.length, o.total, o.received], [1, 1, 59900, 59900]);
  });
  it("resumes after a failure at the payment step: the discount is not applied twice, only the payment is recorded", async () => {
    const o = new FakeShopifyOrder();
    o.failNext = "payment";
    await assert.rejects(() => run(o), (e: any) => e instanceof ShopifyReconcileError && e.step === "payment");
    assert.deepEqual([o.total, o.received, o.committedDiscounts.length], [59900, 0, 1], "edited, not yet paid");
    const retry = await run(o);
    assert.equal(retry.performed, "payment_only");
    assert.deepEqual([o.total, o.received, o.committedDiscounts.length, o.paymentsRecorded.length], [59900, 59900, 1, 1]);
  });
  it("a failed edit changes nothing and records no payment; a retry then succeeds", async () => {
    const o = new FakeShopifyOrder();
    o.failNext = "edit_commit";
    await assert.rejects(() => run(o), (e: any) => e.step === "edit_commit");
    assert.deepEqual([o.total, o.received, o.paymentsRecorded.length], [69900, 0, 0]);
    await run(o);
    assert.deepEqual([o.total, o.received], [59900, 59900]);
  });
  it("refuses to commit an edit whose staged total is not exactly the prepaid amount (e.g. tax changes) - nothing is changed", async () => {
    const o = new FakeShopifyOrder();
    o.stagedTotalOverride = 60500;
    await assert.rejects(() => run(o), (e: any) => e.step === "edit_discount" && /not committed/.test(e.message));
    assert.deepEqual([o.total, o.committedDiscounts.length, o.paymentsRecorded.length], [69900, 0, 0]);
  });
  it("refuses when the order already has money on it, is cancelled, or its total matches neither starting point", async () => {
    const paid = new FakeShopifyOrder();
    paid.received = 10000; paid.outstanding = 59900;
    await assert.rejects(() => run(paid), /already has a payment/);
    const cancelled = new FakeShopifyOrder();
    cancelled.cancelled = true;
    await assert.rejects(() => run(cancelled), /cancelled/);
    const odd = new FakeShopifyOrder({ totalCents: 80000 });
    await assert.rejects(() => run(odd), /neither the original/);
    for (const o of [paid, cancelled, odd]) assert.equal(o.committedDiscounts.length + o.paymentsRecorded.length, 0);
  });
  it("the discount goes on one line worth at least the whole discount; fails clearly if none is", async () => {
    const two = new FakeShopifyOrder({ lines: [{ id: "l1", quantity: 1, unit: 3000 }, { id: "l2", quantity: 1, unit: 39900 }, { id: "l3", quantity: 1, unit: 27000 }] });
    await run(two);
    assert.equal(two.total, 59900);
    const small = new FakeShopifyOrder({ lines: [{ id: "a", quantity: 1, unit: 5000 }, { id: "b", quantity: 1, unit: 5000 }], totalCents: 69900 });
    await assert.rejects(() => run(small), /No single line item/);
    assert.equal(small.committedDiscounts.length, 0);
  });
  it("inconsistent amounts are rejected before Shopify is touched", async () => {
    const o = new FakeShopifyOrder();
    await assert.rejects(() => run(o, { prepaidAmount: "600.00" }), (e: any) => e.step === "validate");
    assert.equal(o.calls.length, 0);
  });
});

describe("reconcilePrepaidUpgrade: recording the payment on a shop that has no payment provider configured", () => {
  const NOT_CONFIGURED = "Payment provider is not configured on shop.";

  it("manual payment refused because of the shop's payment setup -> falls back to orderMarkAsPaid, which records exactly the 599 outstanding once; the order reads PAID", async () => {
    const o = new FakeShopifyOrder();
    o.failNext = "payment";
    o.failMessage = NOT_CONFIGURED;
    const r = await run(o);
    assert.deepEqual([r.paymentVia, r.performed, o.total, o.received, o.outstanding, o.status, r.received], ["mark_as_paid", "edit_and_payment", 59900, 59900, 0, "PAID", "599.00"]);
    assert.deepEqual(o.paymentsRecorded, [{ amount: 59900, method: "markAsPaid" }], "one payment, for the collected 599 - never 699");
    assert.equal(o.committedDiscounts.length, 1, "the discount was applied once");
  });

  it("preferMarkAsPaid (an externally collected payment) uses orderMarkAsPaid first and never touches the provider-dependent manual payment", async () => {
    const o = new FakeShopifyOrder();
    const r = await reconcilePrepaidUpgrade(o.client, o.orderId, { ...INPUT, preferMarkAsPaid: true });
    assert.deepEqual([r.paymentVia, o.status, o.received, o.markAsPaidCalls, o.calls.includes("payment")], ["mark_as_paid", "PAID", 59900, 1, false]);
  });

  it("any OTHER refusal is not retried with a different mutation: it stops with Shopify's own reason and records nothing", async () => {
    const o = new FakeShopifyOrder();
    o.failNext = "payment";
    o.failMessage = "Something else went wrong";
    await assert.rejects(() => run(o), (e: unknown) => e instanceof ShopifyReconcileError && e.step === "payment" && /Something else went wrong/.test(e.message));
    assert.deepEqual([o.markAsPaidCalls, o.received, o.status], [0, 0, "PENDING"]);
  });

  it("both documented ways refused: the reason is reported, nothing is recorded, and a later retry records the payment once without re-applying the discount", async () => {
    const o = new FakeShopifyOrder();
    o.failNext = "payment";
    o.failMessage = NOT_CONFIGURED;
    let refuseMark = true;
    const base = o.client as unknown as { query: (d: string, v: Record<string, unknown>) => Promise<unknown> };
    const client = { query: async (doc: string, vars: Record<string, unknown>) => (refuseMark && doc.includes("crmOrderMarkAsPaidAfterReconcile") ? { orderMarkAsPaid: { order: null, userErrors: [{ field: ["id"], message: "Order cannot be marked as paid." }] } } : base.query(doc, vars)) } as unknown as typeof o.client;
    await assert.rejects(() => reconcilePrepaidUpgrade(client, o.orderId, INPUT), (e: unknown) => e instanceof ShopifyReconcileError && /cannot be marked as paid/.test(e.message));
    assert.deepEqual([o.received, o.status, o.committedDiscounts.length], [0, "PENDING", 1], "discount applied, no payment");
    refuseMark = false;
    const retry = await reconcilePrepaidUpgrade(client, o.orderId, INPUT);
    assert.deepEqual([retry.performed, o.received, o.status, o.committedDiscounts.length, o.paymentsRecorded.length], ["payment_only", 59900, "PAID", 1, 1]);
    const again = await reconcilePrepaidUpgrade(client, o.orderId, INPUT);
    assert.deepEqual([again.performed, o.paymentsRecorded.length], ["already_reconciled", 1]);
  });
});
