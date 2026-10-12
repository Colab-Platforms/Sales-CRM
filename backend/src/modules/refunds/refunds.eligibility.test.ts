import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import { canResolveCashfreeIds, cashfreeOrderIdOf, cashfreePaymentIdOf, COD_REASON, isCashfreePayment, isSupersededPayment, NOT_CASHFREE_REASON, refundIneligibleReason, type EligibilityPayment } from "./refunds.eligibility.js";
import { readFileSync } from "node:fs";
import { environmentMismatch, ShopifyReceiptReader, verifyShopifyCashfreeIds, type ShopifyReceipt } from "./refunds.resolve.js";
import type { CashfreeOrderPayment } from "../cashfree/cashfree.client.js";

// A prepaid CRM payment: a Cashfree payment link, ids recorded from Cashfree.
const crm = (over: Partial<EligibilityPayment> = {}): EligibilityPayment => ({ externalSource: "CASHFREE", provider: "Cashfree", method: PaymentMethod.PAYMENT_LINK, status: PaymentStatus.SUCCESS, providerPaymentId: "1461239734348225536", metadata: { cashfree: { cashfreeOrderId: "CFPay_o1" } }, ...over });
// A prepaid payment synced from Shopify (gateway Cashfree). providerPaymentId is SHOPIFY's payment id ("#AWL1.1"), never a cf_payment_id.
const shopify = (over: Partial<EligibilityPayment> = {}): EligibilityPayment => ({ externalSource: "SHOPIFY", provider: "Cashfree", method: PaymentMethod.OTHER, status: PaymentStatus.SUCCESS, providerPaymentId: "#AWL97845.1", metadata: null, ...over });
const shopifyResolved = (over: Partial<EligibilityPayment> = {}) => shopify({ metadata: { cashfree: { cashfreeOrderId: "ShOrder123", cfPaymentId: "6443901832" } }, ...over });

describe("refund eligibility: every prepaid Cashfree payment, wherever the order came from", () => {
  it("CRM-created prepaid payment with its Cashfree ids -> refundable", () => {
    assert.equal(refundIneligibleReason(crm()), null);
    assert.equal(refundIneligibleReason(crm({ status: PaymentStatus.PARTIALLY_REFUNDED })), null);
    assert.equal(cashfreePaymentIdOf(crm()), "1461239734348225536");
  });

  it("Shopify-originated prepaid payment (Cashfree gateway) with verified ids -> refundable, using the recorded cf_payment_id (NOT Shopify's payment id)", () => {
    assert.equal(refundIneligibleReason(shopifyResolved()), null);
    assert.equal(cashfreePaymentIdOf(shopifyResolved()), "6443901832");
    assert.notEqual(cashfreePaymentIdOf(shopifyResolved()), "#AWL97845.1");
    assert.equal(cashfreeOrderIdOf(shopifyResolved()), "ShOrder123");
    // the real gateway names seen in the data
    for (const provider of ["Cashfree", "1Cashfree Payments(UPI,Cards,Net Banking,Wallets)", "cashfree"]) assert.equal(refundIneligibleReason(shopifyResolved({ provider })), null, provider);
  });

  it("Shopify prepaid payment whose Cashfree ids are not looked up yet -> not executable, but marked resolvable", () => {
    const p = shopify();
    assert.match(refundIneligibleReason(p)!, /has not been verified yet/);
    assert.equal(canResolveCashfreeIds(p), true);
    assert.equal(cashfreePaymentIdOf(p), null, "Shopify's own payment id is never taken as a cf_payment_id");
    // only one of the two ids -> still not refundable
    assert.match(refundIneligibleReason(shopify({ metadata: { cashfree: { cashfreeOrderId: "x" } } }))!, /not been verified/);
  });

  it("COD is never refundable through Cashfree (Shopify or CRM)", () => {
    assert.equal(refundIneligibleReason(shopify({ provider: "Cash on Delivery (COD)", method: PaymentMethod.COD })), COD_REASON);
    assert.equal(refundIneligibleReason(shopify({ method: PaymentMethod.COD })), COD_REASON, "even a Cashfree-named gateway marked COD");
    assert.equal(refundIneligibleReason(crm({ method: PaymentMethod.COD })), COD_REASON);
    assert.equal(canResolveCashfreeIds(shopify({ method: PaymentMethod.COD })), false);
  });

  it("other gateways are not Cashfree and are never refundable here (no fallback provider)", () => {
    for (const provider of ["Phonepe", "PhonePe PG", "shopflo", "manual", "Snapmint", null]) {
      assert.equal(refundIneligibleReason(shopify({ provider: provider as string | null })), NOT_CASHFREE_REASON, String(provider));
      assert.equal(isCashfreePayment(shopify({ provider: provider as string | null })), false);
    }
  });

  it("an unpaid (pending / processing / failed) prepaid payment is not refundable and not resolvable", () => {
    for (const status of [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED]) {
      assert.match(refundIneligibleReason(crm({ status }))!, /Only a successful payment/, status);
      assert.match(refundIneligibleReason(shopifyResolved({ status }))!, /Only a successful payment/, status);
      assert.equal(canResolveCashfreeIds(shopify({ status })), false);
    }
  });

  it("an already fully refunded prepaid payment is not refundable again", () => {
    assert.match(refundIneligibleReason(crm({ status: PaymentStatus.REFUNDED }))!, /already been fully refunded/);
    assert.match(refundIneligibleReason(shopifyResolved({ status: PaymentStatus.REFUNDED }))!, /already been fully refunded/);
    assert.equal(canResolveCashfreeIds(shopify({ status: PaymentStatus.REFUNDED })), false);
  });

  it("a CRM prepaid payment missing its Cashfree identifiers gets a safe, specific unavailable reason", () => {
    assert.match(refundIneligibleReason(crm({ providerPaymentId: null }))!, /payment id is not recorded/);
    assert.match(refundIneligibleReason(crm({ metadata: { cashfree: {} } }))!, /order reference is not recorded/);
    assert.equal(canResolveCashfreeIds(crm({ providerPaymentId: null })), false, "only Shopify-synced payments are looked up");
  });
});

describe("verifying the Cashfree references of a Shopify payment (nothing is guessed)", () => {
  const receipt = (over: Partial<ShopifyReceipt> = {}): ShopifyReceipt => ({ gateway: "Cashfree", receiptPaymentId: "6443901832", authorizationCode: "ShOrder123", kind: "SALE", status: "SUCCESS", test: null, cashfreeTxnId: null, ...over });
  const cf = (over: Partial<CashfreeOrderPayment> = {}): CashfreeOrderPayment => ({ cfPaymentId: "6443901832", paymentStatus: "SUCCESS", paymentAmount: "499", bankReference: "B1", paymentGroup: "upi", paymentTime: null, ...over });

  it("the receipt and Cashfree agree on one successful payment of the same amount -> resolved", () => {
    assert.deepEqual(verifyShopifyCashfreeIds(receipt(), "499.00", [cf()]), { resolved: true, reason: null, cashfreeOrderId: "ShOrder123", cfPaymentId: "6443901832" });
  });
  it("the same payment listed twice by Cashfree is still one payment", () => {
    assert.equal(verifyShopifyCashfreeIds(receipt(), "499.00", [cf(), cf(), cf({ paymentStatus: "FAILED", cfPaymentId: "1" })]).resolved, true);
  });
  it("every disagreement leaves it unresolved, with a reason", () => {
    const no = (r: ReturnType<typeof verifyShopifyCashfreeIds>, re: RegExp) => {
      assert.equal(r.resolved, false);
      assert.match(r.reason!, re);
      assert.deepEqual([r.cashfreeOrderId, r.cfPaymentId], [null, null]);
    };
    no(verifyShopifyCashfreeIds(null, "499", [cf()]), /no record/);
    no(verifyShopifyCashfreeIds(receipt({ gateway: "Phonepe" }), "499", [cf()]), /not made through Cashfree/);
    no(verifyShopifyCashfreeIds(receipt({ kind: "REFUND" }), "499", [cf()]), /not a sale/);
    no(verifyShopifyCashfreeIds(receipt({ status: "FAILURE" }), "499", [cf()]), /not successful/);
    no(verifyShopifyCashfreeIds(receipt({ receiptPaymentId: null }), "499", [cf()]), /does not carry/);
    no(verifyShopifyCashfreeIds(receipt({ authorizationCode: null }), "499", [cf()]), /does not carry/);
    no(verifyShopifyCashfreeIds(receipt(), "499", null), /no order/);
    no(verifyShopifyCashfreeIds(receipt(), "499", []), /no successful payment/);
    no(verifyShopifyCashfreeIds(receipt(), "499", [cf(), cf({ cfPaymentId: "7" })]), /several different successful/);
    no(verifyShopifyCashfreeIds(receipt(), "499", [cf({ cfPaymentId: "9999" })]), /does not match the one in the Shopify receipt/);
    no(verifyShopifyCashfreeIds(receipt(), "499.01", [cf()]), /amount does not match/);
    no(verifyShopifyCashfreeIds(receipt(), "499", [cf({ paymentAmount: null })]), /amount does not match/);
  });
});

// ---- A Shopify order shaped like the real #AWL101729 (Shopify + Fastrr checkout, paid through Cashfree) ----
// The CRM stores Shopify's own transaction id as the payment reference. That id (and Shopify's "#AWL101729.1") is NOT a Cashfree identifier.
const AWL = { shopifyTransactionId: "20808276639933", shopifyPaymentId: "#AWL101729.1", cashfreeOrderRef: "Shrjluie1791354887963", cfPaymentId: "6681442035", amount: "820.00" };
const awlReceipt = (over: Partial<ShopifyReceipt> = {}): ShopifyReceipt => ({ gateway: "Cashfree", receiptPaymentId: AWL.cfPaymentId, authorizationCode: AWL.cashfreeOrderRef, kind: "SALE", status: "SUCCESS", test: false, cashfreeTxnId: AWL.cfPaymentId, ...over });
const awlCashfree = (over: Partial<CashfreeOrderPayment> = {}): CashfreeOrderPayment => ({ cfPaymentId: AWL.cfPaymentId, paymentStatus: "SUCCESS", paymentAmount: "820", bankReference: "B1", paymentGroup: "upi", paymentTime: null, ...over });

describe("#AWL101729-shaped Shopify payment: which identifier is which", () => {
  it("resolves to Cashfree's order reference (the authorization code) and the receipt's payment id - never the Shopify transaction id", () => {
    const r = verifyShopifyCashfreeIds(awlReceipt(), AWL.amount, [awlCashfree()], { environment: "production" });
    assert.deepEqual(r, { resolved: true, reason: null, cashfreeOrderId: AWL.cashfreeOrderRef, cfPaymentId: AWL.cfPaymentId });
    assert.notEqual(r.cashfreeOrderId, AWL.shopifyTransactionId);
    assert.notEqual(r.cashfreeOrderId, AWL.shopifyPaymentId);
    assert.notEqual(r.cfPaymentId, AWL.shopifyTransactionId);
  });

  it("a Shopify receipt that carries no Cashfree order reference is never 'completed' from the transaction id", () => {
    const r = verifyShopifyCashfreeIds(awlReceipt({ authorizationCode: null }), AWL.amount, [awlCashfree()]);
    assert.equal(r.resolved, false);
    assert.deepEqual([r.cashfreeOrderId, r.cfPaymentId], [null, null]);
  });

  it("Cashfree knowing no such order says so, naming the environment asked and the reference tried (and not the Shopify transaction id)", () => {
    const r = verifyShopifyCashfreeIds(awlReceipt(), AWL.amount, null, { environment: "sandbox" });
    assert.equal(r.resolved, false);
    assert.match(r.reason!, /Cashfree \(sandbox\) has no order with the reference from Shopify \(Shrjluie1791354887963\)/);
    assert.match(r.reason!, /same Cashfree account and environment/);
    assert.doesNotMatch(r.reason!, new RegExp(AWL.shopifyTransactionId));
  });

  it("Shopify's own records must agree: the checkout app's Cashfree_txn_id differing from the receipt's payment id leaves it unresolved", () => {
    const r = verifyShopifyCashfreeIds(awlReceipt({ cashfreeTxnId: "9999999999" }), AWL.amount, [awlCashfree()]);
    assert.equal(r.resolved, false);
    assert.match(r.reason!, /Shopify's own records disagree/);
    assert.equal(verifyShopifyCashfreeIds(awlReceipt({ cashfreeTxnId: null }), AWL.amount, [awlCashfree()]).resolved, true, "the attribute is corroboration, not a requirement");
  });

  it("never settles for anything but ONE exact successful payment of the exact amount (no broad match, no amount-only match)", () => {
    const no = (pays: CashfreeOrderPayment[], amount = AWL.amount) => verifyShopifyCashfreeIds(awlReceipt(), amount, pays).resolved;
    assert.equal(no([awlCashfree({ cfPaymentId: "1111111111" })]), false, "a different successful payment on the order");
    assert.equal(no([awlCashfree(), awlCashfree({ cfPaymentId: "2222222222" })]), false, "two different successful payments: ambiguous");
    assert.equal(no([awlCashfree({ paymentAmount: "819" })]), false, "same payment, different amount");
    assert.equal(no([awlCashfree()], "819.00"), false, "the CRM payment's amount is different");
    assert.equal(no([awlCashfree({ paymentStatus: "FAILED" })]), false, "not successful");
    assert.equal(no([]), false);
  });
});

describe("live vs sandbox: a live Shopify payment is never looked up in the sandbox", () => {
  it("decided from Shopify's own test flag, before anything is sent to Cashfree", () => {
    assert.match(environmentMismatch(awlReceipt({ test: false }), "sandbox")!, /live payment, but the CRM is connected to the Cashfree sandbox/);
    assert.match(environmentMismatch(awlReceipt({ test: true }), "production")!, /test payment, but the CRM is connected to live Cashfree/);
    assert.equal(environmentMismatch(awlReceipt({ test: false }), "production"), null);
    assert.equal(environmentMismatch(awlReceipt({ test: true }), "sandbox"), null);
    assert.equal(environmentMismatch(awlReceipt({ test: null }), "sandbox"), null, "unknown stays a normal lookup");
    assert.equal(environmentMismatch(null, "sandbox"), null);
  });
});

describe("reading the Shopify receipt (read-only)", () => {
  it("asks for the exact transaction by its GID and understands the real receipt shape", async () => {
    const asked: Array<{ query: string; id: unknown }> = [];
    const node = { kind: "SALE", status: "SUCCESS", gateway: "Cashfree", authorizationCode: AWL.cashfreeOrderRef, test: false, receiptJson: JSON.stringify({ payment_id: AWL.cfPaymentId }), order: { customAttributes: [{ key: "GATEWAY", value: "CUSTOM Fastrr" }, { key: "Cashfree_txn_id", value: AWL.cfPaymentId }] } };
    const reader = new ShopifyReceiptReader({ query: async (query: string, variables?: Record<string, unknown>) => { asked.push({ query, id: variables?.id }); return { node } as never; } });
    const receipt = await reader.getTransactionReceipt(AWL.shopifyTransactionId);
    assert.deepEqual(asked.map((a) => a.id), [`gid://shopify/OrderTransaction/${AWL.shopifyTransactionId}`]);
    assert.match(asked[0]!.query, /authorizationCode/);
    assert.match(asked[0]!.query, /receiptJson/);
    assert.deepEqual(receipt, { gateway: "Cashfree", receiptPaymentId: AWL.cfPaymentId, authorizationCode: AWL.cashfreeOrderRef, kind: "SALE", status: "SUCCESS", test: false, cashfreeTxnId: AWL.cfPaymentId });
  });
  it("a transaction without a receipt or attributes yields no references (never a guess)", async () => {
    const reader = new ShopifyReceiptReader({ query: async () => ({ node: { kind: "SALE", status: "SUCCESS", gateway: "Cashfree", authorizationCode: null, receiptJson: "not json" } }) as never });
    const receipt = await reader.getTransactionReceipt(AWL.shopifyTransactionId);
    assert.deepEqual([receipt!.receiptPaymentId, receipt!.authorizationCode, receipt!.cashfreeTxnId, receipt!.test], [null, null, null, null]);
    assert.equal(verifyShopifyCashfreeIds(receipt, AWL.amount, [awlCashfree()]).resolved, false);
  });
});

describe("the refund rule: an eligible PAID PREPAID Cashfree payment is refundable - the order's status is not part of it", () => {
  it("eligibility depends on the payment only: no order status is ever consulted (an active order is refundable)", () => {
    assert.equal(refundIneligibleReason(crm()), null);
    assert.equal(refundIneligibleReason(crm({ status: PaymentStatus.PARTIALLY_REFUNDED })), null, "the remaining amount can still be refunded");
    assert.equal(refundIneligibleReason(shopifyResolved()), null);
    assert.equal(refundIneligibleReason.length, 1, "the rule takes the payment only");
  });

  it("COD / unpaid / failed / not Cashfree / fully refunded / not verified payments are still not refundable, with their own reason", () => {
    assert.equal(refundIneligibleReason(crm({ method: PaymentMethod.COD })), COD_REASON);
    assert.equal(refundIneligibleReason(shopify({ provider: "Phonepe" })), NOT_CASHFREE_REASON);
    for (const status of [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED]) assert.match(refundIneligibleReason(crm({ status }))!, /Only a successful payment/, status);
    assert.match(refundIneligibleReason(crm({ status: PaymentStatus.REFUNDED }))!, /already been fully refunded/);
    assert.match(refundIneligibleReason(shopify())!, /has not been verified yet/);
  });

  it("a payment retired by a COD -> Prepaid upgrade is recognised (and so left out of the refund candidates)", () => {
    assert.equal(isSupersededPayment({ retiredByPrepaidUpgrade: { upgradeId: "u1", originalMethod: "COD", at: "2026-10-07T00:00:00Z" } }), true);
    for (const other of [null, undefined, {}, { cashfree: {} }, { retiredByPrepaidUpgrade: {} }, { retiredByPrepaidUpgrade: null }]) assert.equal(isSupersededPayment(other), false, JSON.stringify(other));
  });

  it("the flow is wired as designed: approval cancels the order first and fails closed; execution needs the cancelled order; the old cancelled-only rule is gone", () => {
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
    const service = read("./refunds.service.ts");
    const execution = read("./refunds.execution.ts");
    const eligibility = read("./refunds.eligibility.ts");
    assert.equal(/NOT_CANCELLED_REASON|orderRefundReason|refundIneligibleReasonFor/.test(service + execution + eligibility), false, "no cancelled-only eligibility rule remains");
    assert.match(service, /defaultCancelOrder\)\(user, pre\.orderId/, "approval cancels the order");
    assert.match(service, /the refund was NOT approved/, "and refuses to approve when it can not");
    assert.match(service, /orderCancelledByApproval/);
    assert.match(execution, /req\.order\.status !== OrderStatus\.CANCELLED/, "execution requires the cancelled order");
  });
});
