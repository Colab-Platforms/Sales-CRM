import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyOrder, explainMoney, type AuditCrmOrder, type AuditShopifyOrder } from "./shopify.order-audit.js";

// The audit's rules, with the exact production case first: order #AWL105195 - CRM 649 item + 50 shipping = 699, Shopify 649 with no shipping line.

const crm = (over: Partial<AuditCrmOrder> = {}): AuditCrmOrder => ({
  id: "c1", orderNumber: "CRM-1", externalId: "100", externalNumber: "#AWL1", status: "CONFIRMED", currency: "INR", totalCents: 69900, shippingCents: 5000, discountCents: 0, taxCents: 0,
  paymentStatuses: ["PENDING"], paymentMode: "COD", shipmentCount: 0, refundRequestCount: 0,
  lead: { id: "l1", firstName: "Meera", lastName: "Rao", normalizedMobile: "+919811900001", email: null }, ...over,
});
const shop = (over: Partial<AuditShopifyOrder> = {}): AuditShopifyOrder => ({
  id: "100", name: "#AWL1", cancelledAt: null, financialStatus: "PENDING", fulfillmentStatus: "UNFULFILLED", currency: "INR", totalCents: 69900, currentTotalCents: 69900, shippingCents: 5000, discountsCents: 0, taxCents: 0, refundedCents: 0,
  customer: { id: "gid://shopify/Customer/1", firstName: "Meera", lastName: "Rao", phone: "+919811900001" }, ...over,
});

describe("order audit - money", () => {
  it("the production case: CRM 649 + 50 shipping = 699, Shopify 649 with no shipping line -> a SHIPPING difference of exactly 50.00, never repaired automatically", () => {
    const r = classifyOrder(crm(), shop({ totalCents: 64900, currentTotalCents: 64900, shippingCents: 0, customer: null }));
    assert.equal(r.differenceCents, 5000);
    assert.equal(r.money?.kind, "SHIPPING_MISSING_IN_SHOPIFY");
    assert.match(r.money!.reason, /shipping 50\.00/);
    assert.equal(r.customerIssue, "NO_CUSTOMER");
    assert.equal(r.repair, "MANUAL_REVIEW", "a money mismatch blocks the automatic customer repair as well");
    assert.ok(r.reviewReasons.some((x) => x.startsWith("money")));
  });

  it("quantity 2: 2 x 649 + 50 shipping = 1348 vs Shopify 1298 is the same shipping case", () => {
    const m = explainMoney(crm({ totalCents: 134800 }), shop({ totalCents: 129800, currentTotalCents: 129800, shippingCents: 0 }));
    assert.equal(m?.kind, "SHIPPING_MISSING_IN_SHOPIFY");
  });

  it("a CRM discount missing in Shopify (CRM lower than Shopify by exactly the discount)", () => {
    const m = explainMoney(crm({ totalCents: 124800, shippingCents: 0, discountCents: 5000 }), shop({ totalCents: 129800, currentTotalCents: 129800, shippingCents: 0, discountsCents: 0 }));
    assert.equal(m?.kind, "DISCOUNT_NOT_IN_SHOPIFY");
  });

  it("a tax difference is named as tax; an unexplained difference (the sort of gap no shipping / discount / tax figure covers) is a line or price difference", () => {
    assert.equal(explainMoney(crm({ totalCents: 64900, shippingCents: 0, taxCents: 0 }), shop({ totalCents: 65900, currentTotalCents: 65900, shippingCents: 0, taxCents: 1000 }))?.kind, "TAX_DIFFERENCE");
    const odd = explainMoney(crm({ totalCents: 69900, shippingCents: 5000 }), shop({ totalCents: 44900, currentTotalCents: 44900, shippingCents: 5000 }));
    assert.equal(odd?.kind, "LINE_OR_PRICE_DIFFERENCE");
    assert.match(odd!.reason, /250\.00/);
  });

  it("equal totals are no discrepancy; neither is an order Shopify edited afterwards whose CURRENT total equals the CRM total", () => {
    assert.equal(explainMoney(crm(), shop()), null);
    assert.equal(explainMoney(crm({ totalCents: 59900 }), shop({ totalCents: 69900, currentTotalCents: 59900 })), null);
  });
});

describe("order audit - customer and repair eligibility", () => {
  it("no Shopify customer but the CRM has a name: LINK_OR_CREATE_CUSTOMER when the order is otherwise clean (COD or prepaid)", () => {
    assert.equal(classifyOrder(crm(), shop({ customer: null })).repair, "LINK_OR_CREATE_CUSTOMER");
    const prepaid = classifyOrder(crm({ paymentStatuses: ["SUCCESS"], paymentMode: "PREPAID" }), shop({ customer: null, financialStatus: "PAID" }));
    assert.equal(prepaid.repair, "LINK_OR_CREATE_CUSTOMER");
  });

  it("a linked customer with no name -> FILL_CUSTOMER_NAME; a named one, or a CRM lead with only the checkout placeholder name, is not an issue", () => {
    assert.equal(classifyOrder(crm(), shop({ customer: { id: "x", firstName: null, lastName: " ", phone: null } })).repair, "FILL_CUSTOMER_NAME");
    assert.equal(classifyOrder(crm(), shop()).repair, "NONE");
    const placeholder = classifyOrder(crm({ lead: { id: "l", firstName: "Shiprocket Checkout Lead", lastName: null, normalizedMobile: "+919811900001", email: null } }), shop({ customer: null }));
    assert.equal(placeholder.customerIssue, null);
    assert.equal(placeholder.repair, "NONE");
  });

  it("cancelled, fulfilled, partly fulfilled, refunded, shipment, payment-state difference: all need manual review, never an automatic repair", () => {
    const base = { customer: null };
    const cases: [string, ReturnType<typeof classifyOrder>][] = [
      ["cancelled (Shopify)", classifyOrder(crm(), shop({ ...base, cancelledAt: "2026-10-20T00:00:00Z" }))],
      ["cancelled (CRM)", classifyOrder(crm({ status: "CANCELLED" }), shop(base))],
      ["fulfilled", classifyOrder(crm(), shop({ ...base, fulfillmentStatus: "FULFILLED" }))],
      ["partly fulfilled", classifyOrder(crm(), shop({ ...base, fulfillmentStatus: "PARTIALLY_FULFILLED" }))],
      ["refund in Shopify", classifyOrder(crm(), shop({ ...base, refundedCents: 100 }))],
      ["refund request", classifyOrder(crm({ refundRequestCount: 1 }), shop(base))],
      ["shipment", classifyOrder(crm({ shipmentCount: 1 }), shop(base))],
      ["CRM unpaid but Shopify paid", classifyOrder(crm(), shop({ ...base, financialStatus: "PAID" }))],
      ["CRM paid but Shopify pending", classifyOrder(crm({ paymentStatuses: ["SUCCESS"] }), shop(base))],
    ];
    for (const [label, r] of cases) {
      assert.equal(r.repair, "MANUAL_REVIEW", label);
      assert.ok(r.reviewReasons.length > 0, label);
    }
  });
});
