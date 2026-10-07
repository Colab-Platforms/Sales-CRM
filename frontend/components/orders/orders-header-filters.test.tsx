// Run with: ../backend/node_modules/.bin/tsx --test components/orders/orders-header-filters.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { OrdersTable } from "./orders-table";
import { headerFilterNodes } from "./orders-header-filters";
import { EMPTY_FILTERS, type ColumnFilters } from "./orders-column-filters";

const render = (filters: ColumnFilters, showSalesperson = true) =>
  renderToStaticMarkup(
    <OrdersTable items={[]} isFetching={false} onOpen={() => undefined} headerFilters={headerFilterNodes({ filters, onChange: () => undefined, salespeople: [{ id: "u1", name: "Rep One" }], leadSources: [{ id: "s1", name: "Meta" }], showSalesperson })} />,
  );
const funnels = (html: string) => [...html.matchAll(/aria-label="(Filter [^"]+?)"[^>]*data-active="(true|false)"|data-active="(true|false)"[^>]*aria-label="(Filter [^"]+?)"/g)].map((m) => ({ label: (m[1] ?? m[4]!).replace(/ \(active.*$/, ""), active: (m[2] ?? m[3]) === "true" }));
const labelsOf = (html: string) => [...html.matchAll(/aria-label="(Filter [^"]+)"/g)].map((m) => m[1]!.replace(/ \(active.*$/, ""));

describe("Orders table column filters (header funnels)", () => {
  it("funnels appear beside the filterable columns only: Payment, Order source, Status, Salesperson, Lead source, Tags, Date, Total", () => {
    const labels = labelsOf(render(EMPTY_FILTERS));
    for (const l of ["Filter Payment", "Filter Order source", "Filter Status", "Filter Salesperson", "Filter Lead source", "Filter Tags", "Filter Date", "Filter Total"]) assert.ok(labels.includes(l), `${l} in ${labels.join(", ")}`);
    assert.equal(labels.length, 8);
    const html = render(EMPTY_FILTERS);
    for (const plain of ["Order", "Customer", "Actions"]) assert.ok(!labels.includes(`Filter ${plain}`));
    assert.ok(html.includes("Actions"), "existing columns are untouched");
  });
  it("no filter active: every funnel reads inactive", () => {
    const f = funnels(render(EMPTY_FILTERS));
    assert.equal(f.length, 8);
    assert.ok(f.every((x) => !x.active));
  });
  it("active filters are visibly indicated on exactly their columns (Payment=COD, Source=Shopify, Status/Fulfilment=Unfulfilled)", () => {
    const f = funnels(render({ ...EMPTY_FILTERS, paymentMode: ["COD"], source: ["SHOPIFY"], fulfillment: ["UNFULFILLED"] }));
    const active = f.filter((x) => x.active).map((x) => x.label).sort();
    assert.deepEqual(active, ["Filter Order source", "Filter Payment", "Filter Status"]);
    const html = render({ ...EMPTY_FILTERS, paymentMode: ["COD"] });
    assert.match(html, /aria-label="Filter Payment \(active: COD\)"/);
  });
  it("date and total funnels light up for presets and custom ranges", () => {
    const f = funnels(render({ ...EMPTY_FILTERS, datePreset: "7d", dateFrom: "2026-09-25", dateTo: "2026-10-01", totalMin: "500", totalMax: "1000" }));
    assert.deepEqual(f.filter((x) => x.active).map((x) => x.label).sort(), ["Filter Date", "Filter Total"]);
  });
  it("a salesperson (who only ever sees their own orders) gets no Salesperson filter", () => {
    assert.ok(!labelsOf(render(EMPTY_FILTERS, false)).includes("Filter Salesperson"));
    assert.equal(labelsOf(render(EMPTY_FILTERS, false)).length, 7);
  });
  it("without filters passed, the table renders exactly as before (plain headers)", () => {
    const html = renderToStaticMarkup(<OrdersTable items={[]} isFetching={false} onOpen={() => undefined} />);
    assert.equal(labelsOf(html).length, 0);
    for (const h of ["Order", "Customer", "Salesperson", "Lead source", "Order source", "Total", "Payment", "Status", "Date", "Actions"]) assert.ok(html.includes(h), h);
  });
});
