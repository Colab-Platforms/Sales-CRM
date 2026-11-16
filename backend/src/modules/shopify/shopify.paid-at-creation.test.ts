// A prepaid CRM order whose payment is ALREADY verified is created in Shopify PAID, with the payment transaction, so Shiprocket (which reads the order when Shopify creates it) sees a prepaid
// order. Everything else (COD, pending link, failed payment, figures that do not add up) is unchanged. All external calls are mocked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildShopifyOrderPayload, type CrmOrderForShopify } from "./shopify.order-mapping.js";
import { createShopifyOrder } from "./shopify.orders.write.js";
import type { ShopifyClient } from "./shopify.client.js";

const crm = (over: Partial<CrmOrderForShopify> = {}): CrmOrderForShopify => ({
  orderNumber: "CRM-TEST-PAID", currency: "INR", subtotal: "1699.00", discountAmount: "450.00", discountReason: "Custom discount", shippingAmount: "0.00", taxAmount: "0.00", totalAmount: "1249.00",
  shippingAddress: { name: "Test Customer", line1: "1 Test Road", city: "Pune", state: "Maharashtra", pincode: "411001", phone: "9000000000" }, shippingPincode: "411001",
  metadata: { createdVia: "WHATSAPP_INBOX", paymentMode: "PREPAID", createdBy: { id: "u1", name: "Rep", role: "SALESPERSON" } }, paymentMethod: "OTHER", paymentSucceeded: true, settleAfterCreate: true, paymentProvider: "MANUAL", fromAiConversation: false,
  lead: { firstName: "Test", lastName: null, leadNumber: "LEAD-1", email: null, normalizedMobile: "+919000000000", mobile: "9000000000" },
  items: [{ quantity: 1, unitPrice: "1699.00", productName: "Item", variantName: null, sku: "S1", shopifyVariantId: "111", physical: true }],
  ...over,
});
const build = (o: CrmOrderForShopify, figuresAddUp = true) => buildShopifyOrderPayload(o, { figuresMirror: true, figuresAddUp, customer: null }).input;

describe("paid at creation (prepaid, payment already verified)", () => {
  it("1. verified prepaid -> PAID with a SALE transaction for exactly the CRM total", () => {
    const input = build(crm());
    assert.equal(input.financialStatus, "PAID");
    assert.deepEqual(input.transactions, [{ gateway: "manual", amount: "1249.00" }]);
    assert.equal(build(crm({ paymentProvider: "Cashfree" })).transactions![0]!.gateway, "Cashfree");
  });

  it("2. COD stays PENDING with no transaction", () => {
    const input = build(crm({ metadata: { paymentMode: "COD" }, settleAfterCreate: false, paymentSucceeded: false, paymentMethod: "COD" }));
    assert.equal(input.financialStatus, "PENDING");
    assert.equal(input.transactions, undefined);
  });

  it("6. a pending or failed payment is never created paid", () => {
    for (const over of [{ paymentSucceeded: false }, { paymentSucceeded: false, paymentMethod: "PAYMENT_LINK" }]) {
      const input = build(crm(over));
      assert.equal(input.financialStatus, "PENDING");
      assert.equal(input.transactions, undefined);
    }
  });

  it("figures that do not add up keep the old behaviour (created unpaid, settled by the verified-payment step)", () => {
    const input = build(crm(), false);
    assert.equal(input.financialStatus, "PENDING");
    assert.equal(input.transactions, undefined);
  });

  it("a non-prepaid order that is already paid keeps its existing behaviour (PAID, no transaction added)", () => {
    const input = build(crm({ settleAfterCreate: false }));
    assert.equal(input.financialStatus, "PAID");
    assert.equal(input.transactions, undefined);
  });

  it("the orderCreate request carries the transaction in Shopify's documented shape; an unpaid one carries none", async () => {
    let captured: { order: Record<string, unknown> } | undefined;
    const client = { query: async (_d: string, vars: unknown) => { captured = vars as never; return { orderCreate: { order: { id: "gid://shopify/Order/1", name: "#T1" }, userErrors: [] } }; } } as unknown as ShopifyClient;
    await createShopifyOrder(client, { ...build(crm()), lineItems: [{ title: "x", quantity: 1, priceAmount: "1.00" }] });
    assert.equal(captured!.order.financialStatus, "PAID");
    assert.deepEqual(captured!.order.transactions, [{ kind: "SALE", status: "SUCCESS", gateway: "manual", amountSet: { shopMoney: { amount: "1249.00", currencyCode: "INR" } } }]);
    await createShopifyOrder(client, { ...build(crm({ paymentSucceeded: false })), lineItems: [{ title: "x", quantity: 1, priceAmount: "1.00" }] });
    assert.equal(captured!.order.financialStatus, "PENDING");
    assert.equal("transactions" in captured!.order, false);
  });
});
