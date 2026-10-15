// Run with: ../backend/node_modules/.bin/tsx --test components/abandonment/abandonment-customer-sections.test.tsx
// The abandoned lead's customer context: the FULL delivery address (not "City, State") and every earlier order with a link to it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeliveryAddressSection, LeadPreviousOrdersCard, PreviousOrdersSection } from "./abandonment-customer-sections";
import { AbandonmentPanel } from "./abandonment-panel";
import type { AbandonmentAddress, AbandonmentDetail, CustomerOrderSummary } from "@/lib/api-client/types/abandonment.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const addr = (over: Partial<AbandonmentAddress> = {}): AbandonmentAddress => {
  const a = { name: "Asha Rao", phone: "9811000001", line1: "12 MG Road", line2: "Flat 4B", landmark: "Near Station", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", ...over };
  return { ...a, formatted: [a.line1, a.line2, a.landmark, a.city, a.state, a.pincode, a.country].filter(Boolean).join(", ") };
};
const order = (over: Partial<CustomerOrderSummary> = {}): CustomerOrderSummary => ({
  id: "o-1", orderNumber: "CRM-AAA-1111", externalNumber: null, createdAt: "2026-10-01T10:00:00.000Z", totalAmount: "499.00", currency: "INR", status: "CONFIRMED", paymentMode: "COD", paymentStatus: "PENDING", fulfillmentStatus: null, origin: "CRM", ...over,
});
const sections = (addresses: AbandonmentDetail["addresses"]) => renderToStaticMarkup(<DeliveryAddressSection addresses={addresses} />);
const none = { shipping: null, billing: null, source: null, leadLocation: null } as const;

describe("delivery address", () => {
  it("shows every available part - line 1, line 2, landmark/locality, city, state, postal code, country - not just 'City, State'", () => {
    const h = sections({ ...none, shipping: addr(), source: "CHECKOUT", leadLocation: "Mumbai, Maharashtra" });
    const t = text(h);
    assert.match(t, /12 MG Road, Flat 4B, Near Station, Pune, Maharashtra, 411001, India/);
    for (const part of ["Address line 1 12 MG Road", "Address line 2 Flat 4B", "Landmark / locality Near Station", "City Pune", "State Maharashtra", "Postal code 411001", "Country India"]) assert.ok(t.includes(part), part);
    assert.ok(!t.includes("Mumbai, Maharashtra"), "the short lead location is not shown when a full address exists");
  });
  it("a partial address shows only what exists - no empty rows, nothing invented", () => {
    const t = text(sections({ ...none, shipping: addr({ line1: null, line2: null, landmark: null, pincode: null, country: null, name: null, phone: null }), source: "CHECKOUT" }));
    assert.match(t, /Pune, Maharashtra/);
    assert.ok(!/Address line|Postal code|Country|Landmark/.test(t));
  });
  it("without a checkout address it says the latest order's address is used", () => {
    const t = text(sections({ ...none, shipping: addr(), source: "LAST_ORDER" }));
    assert.match(t, /from their latest order/);
  });
  it("with only the short location it says so; with nothing it says not available", () => {
    assert.match(text(sections({ ...none, leadLocation: "Mumbai, Maharashtra" })), /Mumbai, Maharashtra.*Only the city and state were captured/);
    assert.match(text(sections(none)), /Not available/);
  });
  it("a billing address is shown only when it differs from the shipping address", () => {
    assert.ok(!text(sections({ ...none, shipping: addr(), billing: addr(), source: "CHECKOUT" })).includes("Billing address"));
    assert.match(text(sections({ ...none, shipping: addr(), billing: addr({ line1: "99 Billing Lane" }), source: "CHECKOUT" })), /Billing address.*99 Billing Lane/);
  });
});

describe("previous orders", () => {
  const view = (items: CustomerOrderSummary[], total = items.length, shopify: AbandonmentDetail["previousOrders"]["shopify"] = "OK") => renderToStaticMarkup(<PreviousOrdersSection previousOrders={{ total, items, shopify }} />);
  it("lists each order once with number, date, amount, payment, status, fulfilment and a link to its detail page", () => {
    const h = view([
      order(),
      order({ id: "o-2", orderNumber: "CRM-BBB-2222", externalNumber: "#1042", origin: "SHOPIFY", paymentMode: "PREPAID", paymentStatus: "SUCCESS", status: "CONFIRMED", fulfillmentStatus: "IN_TRANSIT", totalAmount: "1299.00" }),
    ]);
    const t = text(h);
    assert.match(h, /href="\/dashboard\/orders\/o-1"/);
    assert.match(h, /href="\/dashboard\/orders\/o-2"/);
    for (const expected of ["CRM-AAA-1111", "#1042", "CRM-BBB-2222", "₹499.00", "₹1,299.00", "Shopify", "2 orders"]) assert.ok(t.includes(expected), expected);
    assert.match(t, /01 Oct 2026|1 Oct 2026|Oct/);
    assert.equal((h.match(/data-testid="previous-order"/g) ?? []).length, 2);
  });
  it("a customer with no orders gets a plain message, not an error or an empty box", () => {
    const h = view([]);
    assert.match(text(h), /This customer has no previous orders/);
    assert.ok(!/orders<\/span>/.test(h));
  });
  it("a store order known only from Shopify is listed with its live link, fulfilment and courier tracking", () => {
    const h = view([order({ id: "shopify:1042", orderNumber: "#1042", externalNumber: "#1042", origin: "SHOPIFY", inCrm: false, fulfillmentLabel: "Delivered", tracking: { number: "AWB123", company: "Delhivery", url: "https://track.example/AWB123" } })]);
    assert.match(h, /href="\/dashboard\/orders\/shopify:1042"/);
    const t = text(h);
    assert.ok(t.includes("Delivered") && t.includes("Tracking: Delhivery AWB123"));
    assert.match(h, /href="https:\/\/track\.example\/AWB123"/);
  });
  const full = (over: Partial<AbandonmentDetail["previousOrders"]>, items: CustomerOrderSummary[] = []) =>
    renderToStaticMarkup(<PreviousOrdersSection previousOrders={{ total: items.length, items, shopify: "OK", shopifyCustomerFound: false, shopifyTruncated: false, shopifyMatchCount: 0, ...over }} />);
  it("state 2 - searched, no matching customer: a plain 'no previous orders' that says what was searched", () => {
    const h = full({});
    assert.match(text(h), /has no previous orders in the CRM or the store \(searched by phone and e-mail\)/);
    assert.ok(!h.includes("previous-orders-notice"));
  });
  it("state 2b - a matching store customer with no orders is said so", () => {
    assert.match(text(full({ shopifyCustomerFound: true })), /matching store customer was found, but they have no orders/);
  });
  it("state 3 - Shopify not configured is stated, never shown as 'no orders'", () => {
    const h = full({ shopify: "NOT_CONFIGURED" });
    assert.match(text(h), /Shopify is not configured on this server/);
    assert.ok(!/has no previous orders/.test(text(h)));
    assert.match(h, /data-state="NOT_CONFIGURED"/);
    assert.match(h, /role="alert"/);
  });
  it("state 4 - a failed lookup is an explicit problem, not an empty list; with CRM orders it warns the list may be incomplete", () => {
    const empty = full({ shopify: "UNAVAILABLE" });
    assert.match(text(empty), /could not be checked right now/);
    assert.ok(!/has no previous orders/.test(text(empty)));
    assert.match(text(full({ shopify: "UNAVAILABLE" }, [order()])), /could not be checked right now/);
  });
  it("state 5 - an ambiguous customer match shows no history and explains why", () => {
    const h = full({ shopify: "AMBIGUOUS", shopifyMatchCount: 2 });
    assert.match(text(h), /2 different store customers match.*no store history is shown/);
    assert.ok(!/has no previous orders/.test(text(h)));
  });
  it("state 1 - orders found are listed, and a truncated read is disclosed", () => {
    const h = full({ shopifyTruncated: true, shopifyCustomerFound: true }, [order({ id: "shopify:9", orderNumber: "#9", externalNumber: "#9", origin: "SHOPIFY", inCrm: false })]);
    assert.match(text(h), /#9/);
    assert.match(h, /previous-orders-truncated/);
    assert.ok(!h.includes("previous-orders-notice"));
  });
  it("Lead Details card: shown on the lead page (with the orders) when the lead has an abandoned checkout, absent otherwise", () => {
    const withOrders = renderToStaticMarkup(<LeadPreviousOrdersCard abandonment={{ previousOrders: { total: 1, items: [order()], shopify: "OK" } }} />);
    assert.match(withOrders, /data-testid="lead-previous-orders"/);
    assert.match(text(withOrders), /CRM-AAA-1111/);
    assert.equal(renderToStaticMarkup(<LeadPreviousOrdersCard abandonment={null} />), "");
  });
  it("says when only the latest orders are shown", () => {
    assert.match(text(view([order()], 120)), /Showing the latest 1 of 120/);
  });
});

describe("inside the abandoned-lead panel", () => {
  it("the panel shows both sections for the selected abandonment", () => {
    const detail = {
      id: "ab-1", type: "CHECKOUT", status: "ACTIVE", detectedAt: "2026-10-14T10:00:00.000Z", recoveredAt: null, priorityScore: null, priorityReason: null, summary: null, cartSnapshot: null,
      lead: { id: "l-1", leadNumber: "LD-1", firstName: "Asha", lastName: null, name: "Asha", mobile: "9811000001", email: null, workingStatus: "NEW", assignedManager: null, owner: null, calls: [], tasks: [] },
      source: null, latestRecoveryAction: null, reference: { referenceType: null, referenceId: null }, recoveryActions: [],
      addresses: { shipping: addr(), billing: null, source: "CHECKOUT", leadLocation: "Mumbai, Maharashtra" },
      previousOrders: { total: 1, items: [order()], shopify: "OK" },
    } as unknown as AbandonmentDetail;
    const t = text(renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><AbandonmentPanel abandonment={detail} /></QueryClientProvider>));
    assert.match(t, /Delivery address/);
    assert.match(t, /12 MG Road, Flat 4B/);
    assert.match(t, /Previous orders/);
    assert.match(t, /CRM-AAA-1111/);
    assert.match(t, /Recovery History/, "the existing sections are still there");
  });
  it("the lead page can show the previous orders in its own card, so the panel leaves them out", () => {
    const detail = { id: "ab-1", type: "CHECKOUT", status: "ACTIVE", detectedAt: "2026-10-14T10:00:00.000Z", recoveredAt: null, priorityScore: null, priorityReason: null, summary: null, cartSnapshot: null,
      lead: { id: "l-1", leadNumber: "LD-1", firstName: "Asha", lastName: null, name: "Asha", mobile: "9811000001", email: null, workingStatus: "NEW", assignedManager: null, owner: null, calls: [], tasks: [] },
      source: null, latestRecoveryAction: null, reference: { referenceType: null, referenceId: null }, recoveryActions: [], addresses: { shipping: addr(), billing: null, source: "CHECKOUT", leadLocation: null },
      previousOrders: { total: 1, items: [order()], shopify: "OK" } } as unknown as AbandonmentDetail;
    const t = text(renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><AbandonmentPanel abandonment={detail} showPreviousOrders={false} /></QueryClientProvider>));
    assert.ok(!/Previous orders/.test(t));
    assert.match(t, /Delivery address/);
  });
});
