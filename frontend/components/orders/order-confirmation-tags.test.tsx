// Run with: ../backend/node_modules/.bin/tsx --test components/orders/order-confirmation-tags.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrderConfirmationTags } from "./order-confirmation-tags";

const render = (props: Partial<Parameters<typeof OrderConfirmationTags>[0]> = {}) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <OrderConfirmationTags id="o1" confirmedBy={null} confirmationTag={null} shopifyConfirmationTag={null} confirmedAt={null} externalNumber={null} {...props} />
    </QueryClientProvider>,
  );
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("Order Detail: Tags", () => {
  it("confirmed order: the full tag 'CRM Confirmed by Vini' (not just 'Vini'), plus who and when", () => {
    const t = text(render({ confirmedBy: { id: "u1", name: "Vini" }, confirmationTag: "CRM Confirmed by Vini", confirmedAt: "2026-10-06T10:30:00.000Z", shopifyConfirmationTag: { status: "synced", tag: "CRM Confirmed by Vini" }, externalNumber: "#1042" }));
    assert.match(t, /Tags/);
    assert.match(t, /CRM Confirmed by Vini/);
    assert.match(t, /Confirmed by: Vini/);
    assert.match(t, /Confirmed at:/);
    assert.match(t, /Also on Shopify #1042/);
    assert.doesNotMatch(t, /Retry Shopify tag/);
  });
  it("not confirmed: the empty state, no confirmer lines", () => {
    const t = text(render());
    assert.match(t, /Tags —/);
    assert.doesNotMatch(t, /Confirmed by:/);
  });
  it("Shopify tag failure: says the CRM confirmation is saved and offers a retry", () => {
    const t = text(render({ confirmedBy: { id: "u1", name: "Vini" }, confirmationTag: "CRM Confirmed by Vini", shopifyConfirmationTag: { status: "failed", reason: "Access denied. Required access: write_orders" } }));
    assert.match(t, /CRM Confirmed by Vini/);
    assert.match(t, /The Shopify tag could not be updated: Access denied/);
    assert.match(t, /The CRM confirmation is saved/);
    assert.match(t, /Retry Shopify tag/);
  });
  it("a different confirmer shows only the current one", () => {
    const t = text(render({ confirmedBy: { id: "u2", name: "Rahul" }, confirmationTag: "CRM Confirmed by Rahul" }));
    assert.match(t, /CRM Confirmed by Rahul/);
    assert.doesNotMatch(t, /Vini/);
  });
});
