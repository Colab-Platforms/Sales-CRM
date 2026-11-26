// Orders list: matching-order count, downloads, row selection and the date presets. No network: the API client's adapter is faked.
// Run with: ../backend/node_modules/.bin/tsx --test components/orders/orders-bulk.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client/client";
import { ordersApi } from "@/lib/api-client/endpoints/orders.api";
import { orderLiveCountQueryOptions } from "@/lib/api-client/queries/orders.queries";
import type { LiveExportReply, LiveOrderListItem } from "@/lib/api-client/types/orders.types";
import { countText, exportFilters, selectedFor, toggleSelected, waitForOrdersFile } from "./orders-bulk";
import { OrdersBulkBar } from "./orders-bulk-bar";
import { OrdersTable } from "./orders-table";
import { DATE_PRESETS, DATE_PRESET_LABELS, filtersToApi, parseColumnFilters, presetRange } from "./orders-column-filters";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("date presets", () => {
  it("offers Today, Yesterday, This week, This month, Last 7 and 30 days (custom From/To stays below them)", () => {
    assert.deepEqual(DATE_PRESETS.map((p) => DATE_PRESET_LABELS[p]), ["Today", "Yesterday", "This week", "This month", "Last 7 days", "Last 30 days"]);
  });
  it("This week runs from Monday through today, including on a Monday, a Sunday and across a month and year", () => {
    const week = (y: number, m: number, d: number) => presetRange("week", new Date(y, m - 1, d, 0, 30));
    assert.deepEqual(week(2026, 11, 26), { dateFrom: "2026-11-23", dateTo: "2026-11-26" }); // Thursday
    assert.deepEqual(week(2026, 11, 23), { dateFrom: "2026-11-23", dateTo: "2026-11-23" }); // Monday
    assert.deepEqual(week(2026, 11, 29), { dateFrom: "2026-11-23", dateTo: "2026-11-29" }); // Sunday
    assert.deepEqual(week(2026, 12, 2), { dateFrom: "2026-11-30", dateTo: "2026-12-02" });
    assert.deepEqual(week(2027, 1, 1), { dateFrom: "2026-12-28", dateTo: "2027-01-01" });
  });
  it("the preset survives a refresh by name, and there is still no date filter by default", () => {
    const now = new Date(2026, 10, 26, 12);
    const f = parseColumnFilters(new URLSearchParams("datePreset=week"), now);
    assert.deepEqual([f.datePreset, f.dateFrom, f.dateTo], ["week", "2026-11-23", "2026-11-26"]);
    const none = parseColumnFilters(new URLSearchParams(""), now);
    assert.deepEqual([none.datePreset, none.dateFrom, none.dateTo], [undefined, undefined, undefined]);
  });
});

describe("what the count and the download send", () => {
  it("is every filter, search, status, source and date value as the list sends it, never the page", () => {
    const f = parseColumnFilters(new URLSearchParams("status=CONFIRMED,SHIPPED&source=SHOPIFY&paymentMode=COD&tags=VIP&totalMin=500"));
    const params = { after: "cursor", first: 50, search: "asha", dateFrom: "2026-11-22T18:30:00.000Z", dateTo: undefined, ...filtersToApi(f) };
    assert.deepEqual(exportFilters(params), { search: "asha", dateFrom: "2026-11-22T18:30:00.000Z", status: "CONFIRMED,SHIPPED", source: "SHOPIFY", paymentMode: "COD", tags: "VIP", totalMin: "500" });
    assert.deepEqual(exportFilters({ first: 20, ...filtersToApi(parseColumnFilters(new URLSearchParams(""))) }), {});
  });
});

describe("count line", () => {
  const say = (data: Parameters<typeof countText>[0]["data"], failed = false, waiting = false) => countText({ data, failed, waiting });
  it("shows the number, the progress of a long count, and never an old number while the search is still being typed", () => {
    assert.equal(say({ status: "ready", total: 9455 }), "9,455 matching orders");
    assert.equal(say({ status: "ready", total: 1 }), "1 matching order");
    assert.equal(say({ status: "ready", total: 0 }), "0 matching orders");
    assert.equal(say(null), "Counting orders…");
    assert.equal(say({ status: "pending", checked: 3200, expected: 9455 }), "Counting orders… (3,200 of 9,455 orders checked)");
    assert.equal(say({ status: "ready", total: 12 }, false, true), "Counting orders…");
    assert.equal(say({ status: "ready", total: 12 }, true), "Order count unavailable.");
  });

  it("is asked once per set of filters, polled only while the server is still counting, and never shows another filter's number", async () => {
    const asked: string[] = [];
    const replies: Record<string, unknown[]> = {
      COD: [{ status: "pending", checked: 100, expected: 200 }, { status: "ready", total: 7 }],
      PREPAID: [{ status: "ready", total: 3 }],
    };
    const previous = apiClient.defaults.adapter;
    apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      asked.push(`${config.url}?${new URLSearchParams(config.params)}`);
      await tick(5);
      return { data: { data: replies[config.params.paymentMode].shift() }, status: 200, statusText: "OK", headers: {}, config };
    };
    const client = new QueryClient();
    try {
      const observer = new QueryObserver(client, orderLiveCountQueryOptions({ paymentMode: "COD" }));
      const second = new QueryObserver(client, orderLiveCountQueryOptions({ paymentMode: "COD" }));
      const stop = [observer.subscribe(() => {}), second.subscribe(() => {})];
      await tick(50);
      assert.equal(asked.length, 1, "two readers of one filter set share the request");
      // React Query runs no timers outside a browser, so the polling rule is checked directly
      const options = orderLiveCountQueryOptions({ paymentMode: "COD" });
      const interval = options.refetchInterval as (q: unknown) => number | false;
      const query = client.getQueryCache().find({ queryKey: options.queryKey })!;
      assert.equal(interval(query), 1500, "pending: ask again");
      await observer.refetch();
      assert.deepEqual(observer.getCurrentResult().data, { status: "ready", total: 7 });
      assert.equal(interval(query), false, "ready: no more polling");
      assert.equal(interval({ state: { data: { status: "pending" }, error: new Error("x") } }), false, "failed: no polling");
      assert.deepEqual([options.retry, options.refetchOnWindowFocus, options.placeholderData], [false, false, undefined]);
      assert.equal(options.refetchIntervalInBackground, true, "a hidden tab keeps polling, or a long count would start over");
      // paging does not touch this key; a filter change is a new key and starts with no number at all
      observer.setOptions(orderLiveCountQueryOptions({ paymentMode: "PREPAID" }));
      assert.equal(observer.getCurrentResult().data, undefined);
      await tick(50);
      assert.deepEqual(observer.getCurrentResult().data, { status: "ready", total: 3 });
      assert.deepEqual(asked.at(-1), "/orders/live/count?paymentMode=PREPAID");
      stop.forEach((s) => s());
    } finally {
      client.clear();
      apiClient.defaults.adapter = previous;
    }
  });
});

describe("download", () => {
  const file: LiveExportReply = { status: "ready", blob: new Blob(["x"]), filename: "Orders_filtered_2026-11-26.xlsx", rows: 2, missing: 0 };

  it("asks again while the server prepares a large file, reporting progress", async () => {
    const replies: LiveExportReply[] = [{ status: "pending", checked: 100, expected: 9455 }, { status: "pending", checked: 5000, expected: 9455 }, file];
    const progress: string[] = [];
    assert.equal(await waitForOrdersFile(async () => replies.shift()!, { sleep: async () => {}, onProgress: (p) => progress.push(p) }), file);
    assert.deepEqual(progress, ["100 of 9,455 orders checked", "5,000 of 9,455 orders checked"]);
  });
  it("stops when the page is left, passes errors on, and gives up eventually", async () => {
    let calls = 0;
    let left = false;
    assert.equal(await waitForOrdersFile(async () => { calls++; return { status: "pending", checked: 0, expected: null }; }, { sleep: async () => { left = true; }, cancelled: () => left }), null);
    assert.equal(calls, 1);
    await assert.rejects(waitForOrdersFile(async () => { throw new Error("No orders match these filters, so there is nothing to download."); }), /nothing to download/);
    let time = 0;
    await assert.rejects(waitForOrdersFile(async () => ({ status: "pending", checked: 0, expected: null }), { sleep: async () => {}, now: () => (time += 600_000) }), /taking too long/);
  });

  it("reads the file, the 202 progress and the server's own error message", async () => {
    const previous = apiClient.defaults.adapter;
    const bodies: unknown[] = [];
    let reply: { status: number; body: Blob; headers?: Record<string, string> };
    apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      bodies.push(JSON.parse(config.data));
      const response = { data: reply.body, status: reply.status, statusText: "", headers: reply.headers ?? {}, config };
      if (reply.status >= 400) throw new AxiosError("failed", "ERR_BAD_REQUEST", config, null, response);
      return response;
    };
    try {
      reply = { status: 202, body: new Blob([JSON.stringify({ data: { status: "pending", checked: 5, expected: 10 } })]) };
      assert.deepEqual(await ordersApi.exportLive({ filters: { paymentMode: "COD" } }), { status: "pending", checked: 5, expected: 10 });
      reply = { status: 200, body: new Blob(["xlsx"]), headers: { "content-disposition": 'attachment; filename="Orders_selected_2026-11-26.xlsx"', "x-export-rows": "3", "x-export-missing": "1" } };
      const got = await ordersApi.exportLive({ ids: ["a", "shopify:2"] });
      assert.ok(got.status === "ready");
      assert.deepEqual([got.filename, got.rows, got.missing], ["Orders_selected_2026-11-26.xlsx", 3, 1]);
      assert.deepEqual(bodies, [{ filters: { paymentMode: "COD" } }, { ids: ["a", "shopify:2"] }]);
      reply = { status: 404, body: new Blob([JSON.stringify({ message: "No orders match these filters, so there is nothing to download." })]) };
      await assert.rejects(ordersApi.exportLive({ filters: {} }), { message: "No orders match these filters, so there is nothing to download." });
    } finally {
      apiClient.defaults.adapter = previous;
    }
  });
});

describe("selection", () => {
  it("keeps ticks across pages but empties under different filters", () => {
    let ids = toggleSelected(selectedFor(null, "f1"), ["a", "b"], true);
    ids = toggleSelected(ids, ["c", "a"], true);
    ids = toggleSelected(ids, ["b"], false);
    assert.deepEqual([...ids], ["a", "c"]);
    assert.equal(selectedFor({ filterKey: "f1", ids }, "f1"), ids);
    assert.equal(selectedFor({ filterKey: "f1", ids }, "f2").size, 0);
  });

  const order = (id: string): LiveOrderListItem => ({
    id, orderNumber: `#${id}`, status: "CONFIRMED", source: "SHOPIFY", currency: "INR", totalAmount: "500.00", itemCount: 1, paymentStatus: "PENDING", paymentMode: "COD", externalNumber: null,
    createdAt: "2026-11-20T10:00:00Z", customer: { leadId: null, leadNumber: null, name: "Buyer" }, salesperson: null, leadSource: null, linkedInCrm: true, fulfillmentStatus: null, hasTracking: false, shippingMethod: null, tags: [],
  } as unknown as LiveOrderListItem);
  const table = (selected: string[] | null, disabled = false) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <OrdersTable items={[order("1"), order("2")]} isFetching={false} onOpen={() => undefined} selection={selected ? { selected: new Set(selected), onToggle: () => undefined, disabled } : undefined} />
      </QueryClientProvider>,
    );
  const boxes = (html: string) => [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]);

  it("the table has no checkboxes unless selection is offered; with it, one per row plus select-all", () => {
    assert.equal(boxes(table(null)).length, 0);
    const some = boxes(table(["2"]));
    assert.equal(some.length, 3);
    assert.deepEqual(some.map((b) => / checked=""/.test(b)), [false, false, true]);
    assert.match(some[0]!, /Select all orders on this page/);
    assert.deepEqual(boxes(table(["1", "2"])).map((b) => / checked=""/.test(b)), [true, true, true]);
    assert.ok(boxes(table([], true)).every((b) => /disabled/.test(b)), "not tickable while rows are being replaced");
  });
});

describe("count and download bar", () => {
  const bar = (over: Partial<Parameters<typeof OrdersBulkBar>[0]> = {}) =>
    renderToStaticMarkup(<OrdersBulkBar count={{ data: { status: "ready", total: 1234 }, error: null, onRetry: () => undefined }} waiting={false} selectedCount={0} onClearSelection={() => undefined} downloading={null} onDownload={() => undefined} {...over} />);
  const disabled = (html: string, id: string) => /\sdisabled=""/.test(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(html)![0]);

  it("shows the total and both downloads; selected download needs a selection", () => {
    const html = bar();
    assert.match(text(html), /1,234 matching orders Download filtered orders Download selected orders/);
    assert.deepEqual([disabled(html, "download-filtered"), disabled(html, "download-selected")], [false, true]);
    const picked = bar({ selectedCount: 3 });
    assert.match(text(picked), /3 selected Clear selection/);
    assert.equal(disabled(picked, "download-selected"), false);
  });
  it("empty result, oversized selection, a running download and a failed count", () => {
    assert.equal(disabled(bar({ count: { data: { status: "ready", total: 0 }, error: null, onRetry: () => undefined } }), "download-filtered"), true);
    const many = bar({ selectedCount: 1001 });
    assert.equal(disabled(many, "download-selected"), true);
    assert.match(text(many), /Select at most 1,000 orders/);
    const busy = bar({ selectedCount: 1, downloading: { kind: "filtered", progress: "100 of 200 orders checked" } });
    assert.deepEqual([disabled(busy, "download-filtered"), disabled(busy, "download-selected")], [true, true]);
    assert.match(text(busy), /Preparing the download: 100 of 200 orders checked/);
    const failed = bar({ count: { data: null, error: "Choose a shorter date range.", onRetry: () => undefined } });
    assert.match(text(failed), /Order count unavailable\. Retry .*Choose a shorter date range\./);
  });
});
