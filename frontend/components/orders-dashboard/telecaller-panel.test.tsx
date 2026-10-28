// Run with: ../backend/node_modules/.bin/tsx --test components/orders-dashboard/telecaller-panel.test.tsx
// Renders the REAL panel (server-side, from a pre-filled query cache - no network). This is a component render, not a browser session.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TelecallerPerformanceResult } from "@/lib/api-client/types/orders-dashboard.types";
import { TelecallerPanel } from "./telecaller-panel";

const result = (over: Partial<TelecallerPerformanceResult> = {}, summary: Partial<TelecallerPerformanceResult["summary"]> = {}): TelecallerPerformanceResult => ({
  range: { kind: "yesterday", from: "2026-10-27", to: "2026-10-27", timezone: "Asia/Kolkata", days: 1 },
  summary: { totalOrders: 30, cod: 23, prepaid: 7, codRevenue: 16077, prepaidRevenue: 5443, totalRevenue: 21520, paid: 8, pendingPayment: 22, collected: 5443, fulfilled: 4, assistedOrders: 0, confirmedOrders: 30, ...summary },
  invalidAmounts: 0,
  salespeople: [{ id: "u1", name: "Asha" }],
  ...over,
});

function render(data: TelecallerPerformanceResult | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // the panel's own key for the default filters
  if (data) client.setQueryData(["orders-dashboard", "telecaller", { range: "yesterday", from: undefined, to: undefined, salespersonId: "", paymentMode: "ALL", orderStatus: "ALL" }], data);
  return renderToStaticMarkup(<QueryClientProvider client={client}><TelecallerPanel range={{ range: "yesterday" }} /></QueryClientProvider>);
}
const card = (html: string, id: string) => {
  const from = html.indexOf(`data-testid="telecaller-card-${id}"`);
  const next = html.indexOf('data-testid="telecaller-card-', from + 10);
  return from < 0 ? "" : html.slice(from, next < 0 ? undefined : next);
};

describe("TelecallerPanel (rendered)", () => {
  it("renders all ten cards with the figures it was given, the heading, and the 'not all website orders' note", () => {
    const html = render(result());
    for (const [id, text] of [["totalOrders", "30"], ["cod", "23"], ["prepaid", "7"], ["codRevenue", "₹16,077"], ["prepaidRevenue", "₹5,443"], ["totalRevenue", "₹21,520"], ["paid", "8"], ["pendingPayment", "22"], ["collected", "₹5,443"], ["fulfilled", "4"]] as const) {
      assert.match(card(html, id), new RegExp(text.replace("₹", "₹")), id);
    }
    assert.equal((html.match(/data-testid="telecaller-card-/g) ?? []).length, 10);
    assert.match(html, /Telecaller Performance/);
    assert.match(html, /Not all website orders/);
    assert.match(html, /30 confirmed by a telecaller in the CRM/);
    assert.doesNotMatch(html, /NaN/);
  });
  it("a missing amount renders N/A and the incomplete-figures warning - never NaN", () => {
    const html = render(result({ invalidAmounts: 2 }, { collected: undefined as never, codRevenue: Number.NaN }));
    assert.match(card(html, "collected"), /N\/A/);
    assert.match(card(html, "codRevenue"), /N\/A/);
    assert.match(html, /2 orders had a missing or invalid amount/);
    assert.doesNotMatch(html, /NaN/);
  });
  it("an empty period shows real zeros and the empty message", () => {
    const html = render(result({}, { totalOrders: 0, cod: 0, prepaid: 0, codRevenue: 0, prepaidRevenue: 0, totalRevenue: 0, paid: 0, pendingPayment: 0, collected: 0, fulfilled: 0, assistedOrders: 0, confirmedOrders: 0 }));
    assert.match(html, /No telecaller-credited orders/);
    assert.match(card(html, "totalRevenue"), /₹0/);
  });
  it("before any data arrives it shows Loading and no cards (no invented numbers)", () => {
    const html = render(undefined);
    assert.match(html, /Loading/);
    assert.doesNotMatch(html, /telecaller-card-/);
  });
});
