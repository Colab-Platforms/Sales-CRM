// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/previous-order-details.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { OrderDetailsBody, viewFromCrm, viewFromLive } from "./previous-order-details";
import { PreviousOrdersSection } from "./abandonment-customer-sections";
import type { OrderDetail, ShopifyLiveOrder } from "@/lib/api-client/types/orders.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const crm = (over: Partial<OrderDetail> = {}) => ({
  id: "o1", orderNumber: "CRM-1", currency: "INR", subtotal: "749.92", discountAmount: "50.00", taxAmount: "0.00", shippingAmount: "0.00", totalAmount: "699.92",
  shippingAddress: { name: "Asha", line1: "12 MG Road", city: "Pune", state: "Maharashtra", pincode: "411001" },
  items: [
    { id: "i1", productName: "Brain Fuel", variantName: "Pack Of 2", sku: "BF-2", quantity: 2, unitPrice: "299.96", discountAmount: "0", taxAmount: "0", totalPrice: "599.92" },
    { id: "i2", productName: "Herbal Tea", variantName: null, sku: null, quantity: 1, unitPrice: "150.00", discountAmount: "0", taxAmount: "0", totalPrice: "150.00" },
  ],
  shipments: [{ id: "s1", status: "IN_TRANSIT", courier: "Delhivery", trackingNumber: "AWB1", trackingUrl: null }],
  ...over,
}) as unknown as OrderDetail;

describe("expanded previous order", () => {
  it("shows the persisted products with variant, SKU, quantity, unit price and line total, plus the money breakdown, address, courier and tracking", () => {
    const h = renderToStaticMarkup(<OrderDetailsBody view={viewFromCrm(crm())} />);
    const t = text(h);
    assert.equal((h.match(/data-testid="order-line"/g) ?? []).length, 2);
    for (const expected of ["Brain Fuel", "Pack Of 2", "SKU BF-2", "₹299.96", "₹599.92", "Herbal Tea", "Subtotal", "₹749.92", "Discount", "₹50.00", "Total", "₹699.92", "12 MG Road, Pune, Maharashtra, 411001", "in transit", "Courier: Delhivery", "Tracking: AWB1"]) assert.ok(t.includes(expected), expected);
  });

  it("optional parts that are missing are left out, not invented (no SKU, variant, tax, discount, address, shipment)", () => {
    const view = viewFromCrm(crm({ discountAmount: "0.00", shippingAddress: null, shipments: [], items: [{ id: "i", productName: "Plain item", variantName: null, sku: null, quantity: 1, unitPrice: "10.00", discountAmount: "0", taxAmount: "0", totalPrice: "10.00" }] } as never));
    const t = text(renderToStaticMarkup(<OrderDetailsBody view={view} />));
    assert.ok(t.includes("Plain item"));
    for (const absent of ["SKU", "Discount", "Tax", "Ship to", "Courier", "Tracking"]) assert.ok(!t.includes(absent), absent);
  });

  it("an order with no recorded products says so", () => {
    assert.match(text(renderToStaticMarkup(<OrderDetailsBody view={viewFromCrm(crm({ items: [] }))} />)), /No products are recorded/);
  });

  it("a store-only order is shown from Shopify's own record (line total = unit price x quantity)", () => {
    const live = { currency: "INR", fulfillmentStatus: "FULFILLED", itemsTruncated: true, amounts: { subtotal: "699.92", discount: null, tax: null, shipping: "0.00", total: "699.92", refunded: null },
      items: [{ id: "l1", title: "Brain Fuel", variantTitle: "Default Title", sku: "BF-1", quantity: 2, unitPrice: "349.96", discounts: [], productId: null, variantId: null }],
      shippingAddress: { name: "Nick", address1: "Sm krishna badavane", address2: null, city: "Chikkamagaluru", province: "Karnataka", zip: "577548", country: "India", phone: null },
      fulfillments: [{ status: "SUCCESS", displayStatus: null, createdAt: null, trackingCompany: "Bluedart", trackingNumber: "T9", trackingUrl: "https://t.example/T9" }] } as unknown as ShopifyLiveOrder;
    const h = renderToStaticMarkup(<OrderDetailsBody view={viewFromLive(live)} />);
    const t = text(h);
    assert.ok(t.includes("Brain Fuel") && t.includes("SKU BF-1") && t.includes("₹699.92") && t.includes("577548") && t.includes("Courier: Bluedart"));
    assert.ok(!t.includes("Default Title"), "Shopify's placeholder variant is hidden");
    assert.match(t, /Only the first products are shown/);
    assert.match(h, /href="https:\/\/t\.example\/T9"/);
  });

  it("each previous-order card has a toggle and starts collapsed (nothing fetched until expanded)", () => {
    const h = renderToStaticMarkup(<PreviousOrdersSection previousOrders={{ total: 1, shopify: "OK", items: [{ id: "o1", orderNumber: "CRM-1", externalNumber: null, createdAt: "2026-10-01T10:00:00.000Z", totalAmount: "699.92", currency: "INR", status: "CONFIRMED", paymentMode: "COD", paymentStatus: "PENDING", fulfillmentStatus: null, origin: "CRM" }] }} />);
    assert.match(h, /data-testid="order-toggle"/);
    assert.match(h, /aria-expanded="false"/);
    assert.ok(!h.includes("order-expanded"));
  });
});
