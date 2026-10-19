// Create Order opened from an abandoned checkout: the product lines, the address, the banner and the "not captured" messages, rendered through the REAL dialog (inline
// seam, React Query cache pre-filled the way GET /abandonments/:id/order-prefill answers) plus the pure line-mapping helper.
// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/abandoned-checkout-prefill.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateOrderDialog } from "./create-order-dialog";
import { AbandonedCheckoutPrefill, prefillDraftItems } from "./abandoned-checkout-prefill";
import { emptyItem } from "./create-order-sections";
import { abandonmentKeys } from "@/lib/api-client/queries/abandonment.queries";
import type { OrderPrefill } from "@/lib/api-client/types/abandonment.types";

const LEAD = "11111111-1111-4111-8111-111111111111";
const AB1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AB2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const prefill = (over: Partial<OrderPrefill> = {}): OrderPrefill => ({
  abandonmentId: AB1, leadId: LEAD, dataFrom: "saved_cart", sourceName: "fastrr", capturedAt: new Date().toISOString(), stale: false, refreshSupported: false, currency: "INR",
  customer: { name: "Priya Shah", phone: "9000000123", email: "priya@example.invalid" }, addressKind: "shipping",
  address: { name: "Priya Shah", phone: "9000000123", line1: "12 Rose Villa", line2: "MG Road", landmark: "Near Park", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India", company: null },
  lines: [
    { key: "checkout-0", productId: "p-tea", variantId: "v-tea", matched: true, name: "Herbal Tea", variantTitle: "100g", sku: "TEA-100", imageUrl: null, quantity: 2, websiteUnitPrice: "449" },
    { key: "checkout-1", productId: "p-gum", variantId: null, matched: true, name: "Sleep Gummies", variantTitle: null, sku: "GUM-30", imageUrl: null, quantity: 1, websiteUnitPrice: "500" },
  ],
  totals: { total: "1398.00", shipping: "49", tax: "0", discount: "0", discountCodes: [] }, notes: [], ...over,
});

function dialog(opts: { id?: string; data?: OrderPrefill | null; seed?: [string, OrderPrefill][] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [id, data] of opts.seed ?? (opts.data ? [[opts.id ?? AB1, opts.data] as [string, OrderPrefill]] : [])) client.setQueryData(abandonmentKeys.orderPrefill(id), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CreateOrderDialog open onOpenChange={() => {}} leadId={LEAD} customerName="Priya Shah" customerMobile="9000000123" inline abandonmentId={opts.id ?? AB1} />
    </QueryClientProvider>,
  );
}

describe("Create Order from an abandoned checkout: what the form shows", () => {
  it("the banner says the values came from the abandoned checkout, with the saved cart's last-updated time and every website item", () => {
    const h = dialog({ data: prefill() });
    assert.match(h, /data-testid="abandoned-prefill"/);
    const t = text(h);
    assert.match(t, /Prefilled from the abandoned checkout/);
    assert.match(t, /saved cart last updated/);
    assert.match(t, /Herbal Tea — 100g × 2 website price/);
    assert.match(t, /Sleep Gummies × 1/);
  });

  it("the address fields are prefilled: pincode, phone, city, state, house/area and name", () => {
    const h = dialog({ data: prefill() });
    for (const v of ["411001", "9000000123", "Pune", "Maharashtra", "12 Rose Villa", "MG Road", "Priya Shah"]) assert.ok(h.includes(`value="${v}"`), `${v} is in an input`);
  });

  it("a stale cart shows 'may be out of date'", () => {
    const t = text(dialog({ data: prefill({ stale: true, notes: ["This saved cart was last updated 2026-09-01 and may be out of date. It cannot be refreshed automatically."] }) }));
    assert.match(t, /may be out of date/);
    assert.match(t, /last updated 2026-09-01/);
  });

  it("no products and no address captured: clear messages, nothing fabricated, the form is still there to fill in", () => {
    const h = dialog({ data: prefill({ dataFrom: "none", lines: [], address: null, addressKind: null, capturedAt: null, notes: ["No products were captured for this abandoned checkout. Add the products manually.", "No delivery address was captured for this abandoned checkout. Enter it manually."] }) });
    const t = text(h);
    assert.match(t, /No products were captured/);
    assert.match(t, /No delivery address was captured/);
    assert.doesNotMatch(h, /data-testid="abandoned-prefill-lines"/);
    assert.ok(!h.includes('value="411001"'), "no invented pincode");
    assert.match(h, /Create Order|Review order|Items/, "the order form is rendered");
  });

  it("billing-only and unmatched-product messages are shown", () => {
    const t = text(dialog({ data: prefill({ addressKind: "billing", notes: ["Only a billing address was captured - please confirm it is the delivery address.", "1 checkout item could not be matched to a CRM product - choose the product for it."], lines: [{ key: "checkout-0", productId: null, variantId: null, matched: false, name: "Mystery", variantTitle: null, sku: null, imageUrl: null, quantity: 3, websiteUnitPrice: null }] }) }));
    assert.match(t, /Only a billing address was captured/);
    assert.match(t, /could not be matched/);
    assert.match(t, /Mystery × 3 choose the matching product/);
  });

  it("the details could not be loaded: a clear message, and the order can still be filled in by hand", () => {
    const failed = renderToStaticMarkup(<AbandonedCheckoutPrefill prefill={null} loading={false} failed />);
    assert.match(failed, /data-testid="abandoned-prefill-failed"/);
    assert.match(text(failed), /could not be loaded\. You can still fill the order in manually/);
    const loading = renderToStaticMarkup(<AbandonedCheckoutPrefill prefill={null} loading failed={false} />);
    assert.match(text(loading), /Loading the abandoned checkout/);
    // and while it loads, the dialog itself still renders the full (editable) form
    const h = dialog({ id: AB2 });
    assert.match(text(h), /Loading the abandoned checkout/);
    assert.match(h, /Customer for this order/);
  });

  it("opened without an abandoned checkout the form is exactly as before (no banner)", () => {
    const client = new QueryClient();
    const h = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CreateOrderDialog open onOpenChange={() => {}} leadId={LEAD} customerName="Priya Shah" customerMobile="9000000123" inline />
      </QueryClientProvider>,
    );
    assert.doesNotMatch(h, /abandoned-prefill/);
  });

  it("two checkouts never cross-contaminate: each id shows ITS OWN address and products", () => {
    const other = prefill({ abandonmentId: AB2, address: { name: "Rahul", phone: "9111111111", line1: "9 Hill Rd", line2: null, landmark: null, city: "Delhi", state: "Delhi", pincode: "110001", country: "India", company: null }, lines: [{ key: "checkout-0", productId: "p-gum", variantId: null, matched: true, name: "Sleep Gummies", variantTitle: null, sku: null, imageUrl: null, quantity: 5, websiteUnitPrice: "500" }] });
    const seed: [string, OrderPrefill][] = [[AB1, prefill()], [AB2, other]];
    const a = dialog({ id: AB1, seed });
    const b = dialog({ id: AB2, seed });
    assert.ok(a.includes('value="411001"') && !a.includes('value="110001"') && !/Rahul|Delhi/.test(text(a)));
    assert.ok(b.includes('value="110001"') && !b.includes('value="411001"') && !/Herbal Tea|Pune/.test(text(b)));
    assert.match(text(b), /Sleep Gummies × 5/);
  });
});

describe("prefillDraftItems: the product lines the form starts with", () => {
  const catalog: Record<string, { variants: Record<string, string> }> = { "p-tea": { variants: { "v-tea": "449.00" } }, "p-gum": { variants: { "v-gum": "500.00" } } };
  const price = (p: { variants: Record<string, string> } | undefined, variantId: string) => (p ? (p.variants[variantId] ?? "") : "");
  const byId = (id: string) => catalog[id];
  const lines = [
    { key: "checkout-0", productId: "p-tea", variantId: "v-tea", quantity: 2 },
    { key: "checkout-1", productId: "p-gum", variantId: "v-gum", quantity: 1 },
    { key: "checkout-2", productId: null, variantId: null, quantity: 4 },
  ];

  it("one line per checkout item: product, variant, quantity, and the catalogue price of THAT variant; an unmatched item has no product and no price", () => {
    const items = prefillDraftItems([emptyItem()], lines, byId, price);
    assert.deepEqual(items.map((i) => [i.key, i.productId, i.variantId, i.quantity, i.unitPrice]), [["checkout-0", "p-tea", "v-tea", "2", "449.00"], ["checkout-1", "p-gum", "v-gum", "1", "500.00"], ["checkout-2", "", "", "4", ""]]);
  });

  it("applying it again (reload / refetch / a second effect run) never adds the lines twice", () => {
    const once = prefillDraftItems([emptyItem()], lines, byId, price);
    const twice = prefillDraftItems(once, lines, byId, price);
    assert.equal(twice, once, "unchanged");
    assert.equal(twice.length, 3);
  });

  it("a form the salesperson has already started is never overwritten", () => {
    const started = [{ ...emptyItem(), productId: "p-gum", variantId: "v-gum", unitPrice: "500.00" }];
    assert.equal(prefillDraftItems(started, lines, byId, price), started);
    const typedQty = [{ ...emptyItem(), quantity: "7" }];
    assert.equal(prefillDraftItems(typedQty, lines, byId, price), typedQty);
  });

  it("no captured products: the form is left exactly as it is (one empty editable line)", () => {
    const blank = [emptyItem()];
    assert.equal(prefillDraftItems(blank, [], byId, price), blank);
  });
});
