// Run with: ../backend/node_modules/.bin/tsx --test components/orders/my-orders-view.test.tsx
// "My Orders": every state of the list (loading, error, never created one, no match, rows with the right columns and links), and the navigation entry per role.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MyOrdersContent, type MyOrdersContentProps } from "./my-orders-view";
import { NAV_BY_ROLE } from "@/components/app-sidebar";
import type { OrderListItem, OrderListResult } from "@/lib/api-client/types/orders.types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const item = (over: Partial<OrderListItem> = {}): OrderListItem =>
  ({
    id: "o-1", orderNumber: "CRM-AAA-1111", status: "CONFIRMED", source: "SALESPERSON", currency: "INR", totalAmount: "449.00", itemCount: 1, paymentStatus: "PENDING", paymentMode: "COD",
    externalNumber: null, createdAt: "2026-10-14T10:00:00.000Z", customer: { leadId: "l-1", leadNumber: "LD-1", name: "Asha Rao" }, salesperson: { id: "u1", name: "Rep One" }, leadSource: { id: "s1", name: "Meta" }, ...over,
  }) as unknown as OrderListItem;
const result = (items: OrderListItem[]): OrderListResult => ({ items, pagination: { page: 1, pageSize: 20, totalItems: items.length, totalPages: items.length ? 1 : 0 } });
const base: MyOrdersContentProps = { data: null, isLoading: false, isFetching: false, error: null, filtered: false, onRetry: () => {}, onClear: () => {}, onOpen: () => {}, onPageChange: () => {} };
const view = (over: Partial<MyOrdersContentProps>) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MyOrdersContent {...base} {...over} />
    </QueryClientProvider>,
  );

describe("My Orders list states", () => {
  it("while loading it shows the skeleton, not an empty message", () => {
    const h = view({ isLoading: true });
    assert.match(h, /aria-busy="true"/);
    assert.doesNotMatch(text(h), /haven't created/);
  });
  it("a user who has created nothing sees a clear empty state", () => {
    const t = text(view({ data: result([]) }));
    assert.match(t, /You haven't created any orders yet/);
    assert.doesNotMatch(t, /Clear filters/);
  });
  it("an empty result under a search / filter says 'no match' and offers Clear filters (it does not claim they created nothing)", () => {
    const t = text(view({ data: result([]), filtered: true }));
    assert.match(t, /No orders match your search or filters/);
    assert.match(t, /Clear filters/);
    assert.doesNotMatch(t, /haven't created/);
  });
  it("a failed load is an alert with Try again, not a blank page", () => {
    const h = view({ error: "Failed to load your orders." });
    assert.match(h, /role="alert"/);
    assert.match(text(h), /Failed to load your orders\..*Try again/);
  });
  it("rows show the order, customer, order source, total, payment and status with a link to the order's detail - and NOT the Salesperson / Lead source columns", () => {
    const h = view({ data: result([item(), item({ id: "o-2", orderNumber: "CRM-BBB-2222", paymentStatus: "SUCCESS", paymentMode: "PREPAID", status: "PENDING_PAYMENT", totalAmount: "399.00" })]) });
    const t = text(h);
    for (const expected of ["CRM-AAA-1111", "CRM-BBB-2222", "Asha Rao", "₹449.00", "₹399.00"]) assert.ok(t.includes(expected), expected);
    assert.match(h, /href="\/dashboard\/orders\/o-1"/);
    assert.match(h, /href="\/dashboard\/orders\/o-2"/);
    const heads = [...h.matchAll(/<th[^>]*>.*?<span[^>]*>([^<]+)</g)].map((m) => m[1]!.trim());
    assert.deepEqual(heads, ["Order", "Customer", "Order source", "Total", "Payment", "Status", "Tags", "Date", "Actions"], "no Salesperson / Lead source column");
    assert.ok(!t.includes("Rep One") && !t.includes("Meta"), "creator / lead source cells are not rendered");
  });
  it("pagination appears when there are orders", () => {
    const h = view({ data: { items: [item()], pagination: { page: 1, pageSize: 20, totalItems: 45, totalPages: 3 } } });
    assert.match(h, /aria-label="Orders pagination"/);
  });
});

describe("navigation", () => {
  it("Admin, Manager and Salesperson/telecaller each get a separate 'My Orders' entry next to the unchanged 'Orders'", () => {
    for (const role of ["ADMIN", "MANAGER", "SALESPERSON"] as const) {
      const items = NAV_BY_ROLE[role].flatMap((s) => s.items);
      const orders = items.find((i) => i.title === "Orders");
      const mine = items.find((i) => i.title === "My Orders");
      assert.equal(orders?.href, "/dashboard/orders", `${role} keeps Orders`);
      assert.equal(mine?.href, "/dashboard/my-orders", `${role} gets My Orders`);
    }
  });
  it("HR (no orders) gets neither", () => {
    const titles = NAV_BY_ROLE.HR.flatMap((s) => s.items.flatMap((i) => [i.title, ...(i.children ?? []).map((c) => c.title)]));
    assert.ok(!titles.includes("My Orders") && !titles.includes("Orders"));
  });
});
