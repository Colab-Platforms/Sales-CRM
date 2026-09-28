import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOrderConfirmationMessage, buildPaymentLinkMessage, formatMoneyForMessage, summarizeItems } from "./whatsapp.order-message.js";
import { resolveTemplateVariables, type VariableResolutionContext } from "./whatsapp.variable-resolver.js";

const URL = "https://payments.cashfree.com/links/hb2gn0rmhusg_AAAAAAAL7HI";

describe("payment-link WhatsApp message", () => {
  const message = buildPaymentLinkMessage({
    customerName: "Vishwaa Reddy",
    orderNumber: "CRM-MUGTXF0Y-3GIP",
    items: [{ name: "Skin, Hair & Nail Gummies with Glutathione & Hyaluronic Acid", variant: "1 Jar", quantity: 1 }, { name: "Brain Fuel Capsules", variant: null, quantity: 2 }],
    amount: "749.00",
    currency: "INR",
    paymentUrl: URL,
  });

  it("is the professional Ayush Wellness structure, not the raw one-liner", () => {
    assert.ok(message.startsWith("Payment Link for Your Order 💳"), "has the friendly header");
    assert.ok(message.includes("Hi Vishwaa,"), "greets by first name");
    for (const part of ["Your order CRM-MUGTXF0Y-3GIP has been created successfully.", "Items:", "Payment: Pending", "Please complete your payment using the secure link below:", "Once payment is completed, we'll process your order.", "Thank you for choosing Ayush Wellness."]) {
      assert.ok(message.includes(part), part);
    }
    assert.equal(message.includes("Please complete your payment of"), false);
  });

  it("lists every product with its variant and quantity, using the real product names", () => {
    assert.ok(message.includes("• Skin, Hair & Nail Gummies with Glutathione & Hyaluronic Acid (1 Jar) × 1"));
    assert.ok(message.includes("• Brain Fuel Capsules × 2"));
  });

  it("shows the actual payable amount, and the payment URL exactly as given (untruncated, on its own line)", () => {
    assert.ok(message.includes("Total: ₹749.00") || message.includes("Total: ₹749"), "amount");
    assert.ok(message.split("\n").includes(URL), "the URL is a whole line, unaltered");
    assert.equal(message.includes("…"), false);
  });

  it("never contains ids, providers or secrets - only customer-safe facts", () => {
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(message), false, "no uuid");
    assert.equal(/cashfree_?(id|secret)|cfsk|Bearer|x-client/i.test(message.replace(URL, "")), false);
  });

  it("falls back gracefully without a name or items", () => {
    const m = buildPaymentLinkMessage({ orderNumber: "CRM-1", amount: "1199.00", currency: "INR", paymentUrl: URL });
    assert.ok(m.includes("Hi there,"));
    assert.equal(m.includes("Items:"), false);
    assert.ok(m.includes("₹1,199"));
  });
});

describe("COD confirmation message", () => {
  it("has the same voice, the items, the total and how the customer pays", () => {
    const m = buildOrderConfirmationMessage({ customerName: "Priya Shah", orderNumber: "CRM-9", items: [{ name: "Herbal Tea", quantity: 3 }], amount: "1047.00", currency: "INR" });
    assert.ok(m.startsWith("Order Confirmed 🎉"));
    assert.ok(m.includes("Hi Priya,") && m.includes("• Herbal Tea × 3") && m.includes("Cash on Delivery") && m.includes("₹1,047") && m.includes("Ayush Wellness"));
  });
});

describe("money formatting", () => {
  it("uses Indian grouping, no needless decimals, and keeps paise", () => {
    assert.equal(formatMoneyForMessage("1199.00"), "₹1,199");
    assert.equal(formatMoneyForMessage("749.5"), "₹749.50");
    assert.equal(formatMoneyForMessage("1234567"), "₹12,34,567");
    assert.equal(formatMoneyForMessage("10", "USD"), "USD 10");
  });
});

describe("template variables for the same message: customer_name, order_number, product_summary, amount, payment_link", () => {
  const ctx: VariableResolutionContext = {
    lead: { firstName: "Vishwaa", lastName: "Reddy", mobile: null, normalizedMobile: null, email: null },
    order: {
      orderNumber: "CRM-1", externalNumber: null, status: "PENDING_PAYMENT", currency: "INR", totalAmount: "749.00", latestShipment: null,
      items: [{ productName: "Skin, Hair & Nail Gummies", variantName: "1 Jar", quantity: 1 }, { productName: "Brain Fuel Capsules", variantName: null, quantity: 2 }],
      payments: [{ status: "PENDING", method: "PAYMENT_LINK", amount: "749.00", refundedAmount: null, paymentUrl: URL, paymentExpiresAt: null }],
    },
  };

  it("resolves all five from real order data", () => {
    const r = resolveTemplateVariables(["customer_name", "order_number", "product_summary", "amount", "payment_link"], ctx);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.values, {
      customer_name: "Vishwaa Reddy",
      order_number: "CRM-1",
      product_summary: "Skin, Hair & Nail Gummies (1 Jar) × 1, Brain Fuel Capsules × 2",
      amount: "₹749",
      payment_link: URL,
    });
    assert.equal(summarizeItems([{ name: "A", quantity: 1 }]), "A × 1");
  });

  it("product_summary and amount are refused (never guessed) without an order/items", () => {
    const r = resolveTemplateVariables(["product_summary", "amount"], { lead: ctx.lead, order: null });
    assert.equal(r.errors.length, 2);
    assert.equal(resolveTemplateVariables(["product_summary"], { lead: ctx.lead, order: { ...ctx.order!, items: [] } }).errors.length, 1);
  });
});
