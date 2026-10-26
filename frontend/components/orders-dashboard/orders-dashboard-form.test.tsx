// Run with: ../backend/node_modules/.bin/tsx --test components/orders-dashboard/orders-dashboard-form.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AbandonedChartResult, AbandonedResult, Coverage, OrdersChartResult, OrdersDashboardResult } from "@/lib/api-client/types/orders-dashboard.types";
import { CARDS, DEFAULT_QUERY, DEFAULT_RANGE, RANGE_LABEL, RANGE_OPTIONS, cardLabel, cardValue, changeRange, closeDetails, compareLabel, describeRange, formatInr, selectCard, switchTab, todayIn, validateCustomRange, websiteFeedWarning, withFilters } from "./orders-dashboard-form";
import { ABANDONED_CARDS, abandonedCardValue, closeAbandonedDetails, selectAbandonedCard } from "./abandoned-dashboard-form";
import { bucketLabel, chartGeometry, niceAxis, type ChartPoint } from "./chart-geometry";
import { OrdersDashboard } from "./orders-dashboard-view";
import { NAV_BY_ROLE } from "../app-sidebar";

const summary = { totalOrders: 2, totalValue: 1500, cod: 1, prepaid: 1, paid: 1, pendingPayment: 1, cancelled: 0, cancelledValue: 0, fulfilled: 1 };
const RANGE = { kind: "yesterday" as const, from: "2026-10-25", to: "2026-10-25", timezone: "Asia/Kolkata", days: 1 };
const websiteResult = (over: Partial<OrdersDashboardResult> = {}, fresh: Partial<OrdersDashboardResult["freshness"]> = {}): OrdersDashboardResult => ({
  range: RANGE,
  coverage: "FULL",
  verification: null,
  comparison: { totalOrders: { previous: 1, changePct: 100 }, totalValue: { previous: 111, changePct: 1251.4 } },
  summary,
  freshness: { latestWebsiteOrderAt: "2026-10-07T12:45:00Z", websiteMayBeIncomplete: true, shopifyWebhooksReceived: 0, lastShopifyWebhookAt: null, ...fresh },
  details: null,
  ...over,
});
const abandonedResult = (over: Partial<AbandonedResult> = {}): AbandonedResult => ({
  range: RANGE,
  coverage: "FULL",
  comparison: { totalAbandoned: { previous: 3, changePct: 100 } },
  summary: { totalAbandoned: 6, potentialValue: 1550, openCheckouts: 5, followUpPending: 5, followUpCompleted: 1, recovered: 1, openWithoutValue: 1, openOtherCurrency: 1 },
  source: { name: "Shiprocket Checkout (Fastrr) abandon-cart events", paymentModeAvailable: false, latestCheckoutAt: "2026-10-26T07:23:00Z" },
  details: null,
  ...over,
});
const ordersChart: OrdersChartResult = {
  range: { ...RANGE, kind: "last_7_days", from: "2026-10-20", to: "2026-10-26", days: 7 },
  interval: "daily",
  coverage: "PARTIAL",
  verification: { shopifyCount: null, crmCount: 0, verified: false, perBucket: false },
  buckets: [
    { key: "2026-10-20", from: "2026-10-20", to: "2026-10-20", available: false, partial: false, orders: null, revenue: null },
    { key: "2026-10-21", from: "2026-10-21", to: "2026-10-21", available: true, partial: false, orders: 3, revenue: 900 },
    { key: "2026-10-22", from: "2026-10-22", to: "2026-10-22", available: true, partial: false, orders: 0, revenue: 0 },
    { key: "2026-10-23", from: "2026-10-23", to: "2026-10-23", available: true, partial: true, orders: 2, revenue: 500 },
  ],
  totals: { orders: 5, revenue: 1400 },
};
const abandonedChart: AbandonedChartResult = {
  range: RANGE,
  interval: "daily",
  coverage: "FULL",
  buckets: [{ key: "2026-10-25", from: "2026-10-25", to: "2026-10-25", available: true, partial: false, abandoned: 6, openValue: 1550 }],
  totals: { abandoned: 6, openValue: 1550 },
};

interface Seed { site?: OrdersDashboardResult | null; ab?: AbandonedResult | null; chartOrders?: OrdersChartResult | null; chartAb?: AbandonedChartResult | null }
/** The REAL page with React Query's cache pre-filled the way each default (cards-only) request is answered. */
function render(allowed: boolean, seed: Seed = {}) {
  const { site = websiteResult(), ab = abandonedResult(), chartOrders = ordersChart, chartAb = abandonedChart } = seed;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (site) client.setQueryData(["orders-dashboard", "website", { ...DEFAULT_RANGE, scope: "WEBSITE", pageSize: 25, page: 1 }], site);
  if (ab) client.setQueryData(["orders-dashboard", "abandoned", { ...DEFAULT_RANGE, pageSize: 25, page: 1 }], ab);
  if (chartOrders) client.setQueryData(["orders-dashboard", "chart", "orders", DEFAULT_RANGE, "daily"], chartOrders);
  if (chartAb) client.setQueryData(["orders-dashboard", "chart", "abandoned", DEFAULT_RANGE, "daily"], chartAb);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <OrdersDashboard allowed={allowed} />
    </QueryClientProvider>,
  );
}
const section = (html: string, id: "website-panel" | "abandoned-panel") => {
  const start = html.indexOf(`data-testid="${id}"`);
  assert.ok(start >= 0, id);
  const next = html.indexOf("<section", start + 10);
  const cards = html.indexOf("data-testid=\"orders-revenue-card\"", start);
  const cut = [next, cards].filter((i) => i > start).sort((a, b) => a - b)[0];
  return cut ? html.slice(start, cut) : html.slice(start);
};

describe("page structure: both dashboards stacked on ONE page", () => {
  it("shows Website Orders, the Orders & Revenue chart, Abandoned Checkouts and its trend in that order - with no top-level tabs", () => {
    const html = render(true);
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    const order = ["website-panel", "orders-revenue-card", "abandoned-panel", "abandoned-trend-card"].map(at);
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "stacked in that order");
    assert.ok(!html.includes('role="tablist"') && !html.includes("dashboard-website") && !html.includes("dashboard-abandoned"), "no tabs between the dashboards");
    assert.match(html, /Website Orders/);
    assert.match(html, /Abandoned Checkouts/);
    assert.equal((html.match(/data-testid="range-controls"/g) ?? []).length, 1, "ONE date range for everything");
  });

  it("the date presets: Today, Yesterday, This Week, Last 7 Days, Last 30 Days, This Month, Last Month, Custom Range - with Yesterday selected", () => {
    const html = render(true);
    assert.deepEqual(RANGE_OPTIONS.map((k) => RANGE_LABEL[k]), ["Today", "Yesterday", "This Week", "Last 7 Days", "Last 30 Days", "This Month", "Last Month", "Custom Range"]);
    for (const k of RANGE_OPTIONS) assert.ok(html.includes(`data-testid="range-${k}"`), k);
    assert.match(html, /data-testid="range-yesterday"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="range-yesterday"/);
    for (const k of RANGE_OPTIONS.filter((x) => x !== "yesterday")) assert.match(html, new RegExp(`aria-pressed="false"[^>]*data-testid="range-${k}"|data-testid="range-${k}"[^>]*aria-pressed="false"`), `${k} is not selected`);
    assert.deepEqual([DEFAULT_RANGE.range, DEFAULT_QUERY.range], ["yesterday", "yesterday"]);
  });

  it("any other role gets the access message and no data", () => {
    const html = render(false);
    assert.ok(html.includes("orders-dashboard-forbidden") && !html.includes("summary-cards") && !html.includes("orders-revenue-card"));
  });
});

describe("cards", () => {
  it("Website Orders: eight clickable cards, values from the data, no table / details / selected card by default", () => {
    const site = section(render(true), "website-panel");
    assert.deepEqual(CARDS.map((c) => c.label), ["Total Orders", "Total Order Value", "COD", "Prepaid", "Paid", "Pending Payment", "Cancelled", "Fulfilled"]);
    for (const [key, shown] of [["total", "2"], ["value", "₹1,500"], ["cod", "1"], ["prepaid", "1"], ["paid", "1"], ["pending", "1"], ["cancelled", "0"], ["fulfilled", "1"]]) {
      assert.match(site, new RegExp(`data-testid="card-value-${key}"[^>]*>${shown}<`), key);
    }
    const buttons = site.match(/<button[^>]*data-testid="card-[a-z]+"[^>]*>/g) ?? [];
    assert.equal(buttons.length, 8);
    assert.ok(buttons.every((b) => /type="button"/.test(b) && /aria-pressed="false"/.test(b)), "real buttons, none selected");
    for (const hidden of ["order-details", "order-row", "export-orders", "close-details", "<table"]) assert.ok(!site.includes(hidden), `${hidden} hidden by default`);
  });

  it("Abandoned Checkouts: its own five cards, separate numbers, no COD / prepaid, source stated", () => {
    const ab = section(render(true), "abandoned-panel");
    assert.deepEqual(ABANDONED_CARDS.map((c) => c.label), ["Total Abandoned Checkouts", "Potential Abandoned Value", "Follow-up Pending", "Follow-up Completed", "Recovered"]);
    for (const [key, shown] of [["total", "6"], ["value", "₹1,550"], ["pending", "5"], ["done", "1"], ["recovered", "1"]]) assert.match(ab, new RegExp(`data-testid="card-value-${key}"[^>]*>${shown}<`), key);
    assert.ok(!/>COD<|>Prepaid<|card-cod|card-prepaid/.test(ab));
    assert.match(ab, /do not say whether the customer chose COD or prepaid/);
    assert.ok(!ab.includes("<table") && !ab.includes("order-details"));
  });

  it("the two datasets stay separate: 2 website orders and 6 abandoned checkouts on the same page", () => {
    const html = render(true);
    assert.match(section(html, "website-panel"), /card-value-total"[^>]*>2</);
    assert.match(section(html, "abandoned-panel"), /card-value-total"[^>]*>6</);
  });

  it("a comparison appears only where the server sent one (real, fully covered history): Total Orders, Total Order Value and Total Abandoned", () => {
    const html = render(true);
    const site = section(html, "website-panel");
    assert.match(site, /data-testid="card-compare-total"[^>]*>[\s\S]*?100% vs previous day/);
    assert.match(site, /data-testid="card-compare-value"[^>]*>[\s\S]*?1251.4% vs previous day/);
    assert.ok(!site.includes("card-compare-cod") && !site.includes("card-compare-paid"), "no invented comparison on other cards");
    assert.match(section(html, "abandoned-panel"), /data-testid="card-compare-total"/);
    const none = section(render(true, { site: websiteResult({ comparison: null }), ab: abandonedResult({ comparison: null }) }), "website-panel");
    assert.ok(!none.includes("card-compare-"), "no comparison without history");
    assert.equal(compareLabel(1), "vs previous day");
    assert.equal(compareLabel(7), "vs previous 7 days");
  });

  it("UNAVAILABLE data is never shown as a zero: coverage NONE shows 'No data', PARTIAL says the number is incomplete", () => {
    const none = section(render(true, { site: websiteResult({ coverage: "NONE", summary: { ...summary, totalOrders: 0, totalValue: 0 } }, {}) }), "website-panel");
    assert.equal((none.match(/>No data</g) ?? []).length, 8, "all eight cards say no data");
    assert.ok(!/card-value-total"[^>]*>0</.test(none), "not a zero");
    assert.match(none, /Not received for this period/);
    const partial = section(render(true, { site: websiteResult({ coverage: "PARTIAL", comparison: null }) }), "website-panel");
    assert.match(partial, /Partial - data incomplete/);
    assert.match(partial, /card-value-total"[^>]*>2</);
    const abNone = section(render(true, { ab: abandonedResult({ coverage: "NONE", comparison: null }) }), "abandoned-panel");
    assert.equal((abNone.match(/>No data</g) ?? []).length, 5);
    assert.match(abNone, /coverage-warning/);
  });

  it("the stale-data warning stays while the Shopify feed is behind, with the real reason; it disappears when the feed is current", () => {
    const html = section(render(true), "website-panel");
    assert.match(html, /data-testid="freshness-warning"/);
    assert.match(html, /never received a Shopify order webhook/);
    assert.match(html, /NOT shown - the counts here are incomplete/);
    const ok = section(render(true, { site: websiteResult({}, { websiteMayBeIncomplete: false, shopifyWebhooksReceived: 12 }) }), "website-panel");
    assert.ok(!ok.includes("freshness-warning"));
  });

  it("shows loading before the first answers arrive", () => {
    const html = render(true, { site: null, ab: null, chartOrders: null, chartAb: null });
    assert.match(html, /Loading/);
    assert.ok(!html.includes("order-details"));
  });
});

describe("Orders & Revenue chart", () => {
  it("renders green bars for the days with data, the dark line for revenue, a Daily / Weekly / Monthly selector, and the totals", () => {
    const html = render(true);
    const c = html.slice(html.indexOf('data-testid="orders-revenue-card"'), html.indexOf('data-testid="abandoned-panel"'));
    assert.match(c, /Orders &amp; Revenue/);
    for (const i of ["daily", "weekly", "monthly"]) assert.ok(c.includes(`data-testid="interval-${i}"`), i);
    assert.match(c, /data-testid="interval-daily"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="interval-daily"/, "daily by default");
    assert.equal((c.match(/data-testid="chart-bar"/g) ?? []).length, 3, "bars for the 3 days with data (a day with 0 orders is a real zero-height bar)");
    assert.ok(c.includes("fill-emerald-500") && c.includes("stroke-slate-800"), "green bars, dark line");
    assert.match(c, /data-testid="chart-totals"[^>]*><strong>5<\/strong> orders, <strong>₹1,400<\/strong>/);
    assert.match(c, /role="img"/);
  });

  it("a day the CRM has no data for is a hatched gap, not a zero bar, and the line breaks there", () => {
    const html = render(true);
    const c = html.slice(html.indexOf('data-testid="orders-revenue-card"'), html.indexOf('data-testid="abandoned-panel"'));
    assert.equal((c.match(/data-testid="chart-gap"/g) ?? []).length, 1);
    assert.match(c, /no data in the CRM for this period/);
    assert.match(c, /data-testid="chart-coverage-note"/);
    assert.match(c, /No data for this period/);
  });

  it("the abandoned trend is its own chart with its own totals", () => {
    const html = render(true);
    const c = html.slice(html.indexOf('data-testid="abandoned-trend-card"'));
    assert.match(c, /Abandoned Checkouts trend/);
    assert.match(c, /<strong>6<\/strong> abandoned checkouts, <strong>₹1,550<\/strong> still open/);
    assert.ok(!/orders-chart/.test(c));
  });
});

describe("chart geometry", () => {
  const pts = (rows: [number | null, number | null][]): ChartPoint[] => rows.map(([bar, line], i) => ({ key: `2026-10-${String(20 + i).padStart(2, "0")}`, bar, line, available: bar !== null, partial: false }));

  it("nice axes: 1/2/5 x 10^n, always four steps, and a usable axis when everything is zero", () => {
    assert.deepEqual(niceAxis(7), { max: 10, ticks: [0, 2.5, 5, 7.5, 10] });
    assert.equal(niceAxis(23).max, 50);
    assert.equal(niceAxis(1400).max, 2000);
    assert.deepEqual(niceAxis(0), { max: 4, ticks: [0, 1, 2, 3, 4] });
  });

  it("bar heights follow the values; the tallest bar fills the axis; a real zero is a zero-height bar", () => {
    const g = chartGeometry(pts([[10, 100], [5, 50], [0, 0]]));
    assert.equal(g.bars.length, 3);
    assert.ok(Math.abs(g.bars[0]!.h - 2 * g.bars[1]!.h) < 1e-9);
    assert.equal(g.bars[2]!.h, 0);
    assert.equal(g.gaps.length, 0);
  });

  it("a bucket with no data is a gap marker, not a bar, and breaks the line into separate segments", () => {
    const g = chartGeometry(pts([[3, 30], [null, null], [2, 20], [4, 40]]));
    assert.deepEqual(g.bars.map((b) => b.value), [3, 2, 4]);
    assert.equal(g.gaps.length, 1);
    assert.deepEqual(g.segments.map((s) => s.length), [1, 2], "the line does not bridge the gap");
  });

  it("labels are thinned so they never overlap", () => {
    assert.equal(chartGeometry(pts(Array.from({ length: 5 }, () => [1, 1] as [number, number]))).labelIdx.length, 5);
    assert.ok(chartGeometry(pts(Array.from({ length: 90 }, () => [1, 1] as [number, number]))).labelIdx.length <= 10);
    assert.equal(bucketLabel("2026-10-25", "daily"), "25 Oct");
    assert.equal(bucketLabel("2026-10-01", "monthly"), "Oct 2026");
  });
});

describe("card / range interaction rules", () => {
  it("clicking a website card opens its details with the date range kept; another card re-targets the same details; closing returns to cards only", () => {
    const q = selectCard({ ...DEFAULT_QUERY, range: "custom", from: "2026-10-20", to: "2026-10-22", scope: "WEBSITE" }, "COD");
    assert.deepEqual([q.metric, q.range, q.from, q.to, q.page, q.scope], ["COD", "custom", "2026-10-20", "2026-10-22", 1, "WEBSITE"]);
    const next = selectCard({ ...q, search: "asha", page: 3 }, "PAID");
    assert.deepEqual([next.metric, next.search, next.page], ["PAID", "asha", 1]);
    const closed = closeDetails({ ...next, paymentStatus: "SUCCESS" });
    assert.deepEqual([closed.metric, closed.search, closed.paymentStatus, closed.scope, closed.range, closed.from], [undefined, undefined, undefined, "WEBSITE", "custom", "2026-10-20"]);
  });
  it("a new range keeps the open card; filters restart at page 1", () => {
    const open = selectCard(DEFAULT_QUERY, "CANCELLED");
    const c = changeRange({ ...open, page: 5 }, { range: "last_30_days", from: undefined, to: undefined });
    assert.deepEqual([c.metric, c.range, c.page], ["CANCELLED", "last_30_days", 1]);
    assert.equal(withFilters({ ...open, page: 4 }, { fulfilment: "FULFILLED" }).page, 1);
    assert.equal(switchTab(open, "TELECALLER").metric, "CANCELLED");
  });
  it("abandoned: nothing selected on load; a click selects, another re-targets, close keeps the range", () => {
    const base = { range: "yesterday" as const, page: 1, pageSize: 25 };
    const a = selectAbandonedCard({ ...base, range: "this_month" }, "PENDING");
    assert.deepEqual([a.metric, a.range, a.page], ["PENDING", "this_month", 1]);
    const b = selectAbandonedCard({ ...a, search: "x", page: 4 }, "DONE");
    assert.deepEqual([b.metric, b.search, b.page], ["DONE", "x", 1]);
    const c = closeAbandonedDetails(b);
    assert.deepEqual([c.metric, c.search, c.range], [undefined, undefined, "this_month"]);
  });
});

describe("helpers", () => {
  it("card values and labels", () => {
    assert.equal(cardValue(summary, "VALUE"), "₹1,500");
    assert.equal(cardLabel("FULFILLED"), "Fulfilled");
    assert.deepEqual(ABANDONED_CARDS.map((c) => abandonedCardValue(abandonedResult().summary, c.key)), ["6", "₹1,550", "5", "1", "1"]);
  });
  it("the feed warning explains the problem from what the database knows", () => {
    const fmt = (iso: string) => iso.slice(0, 10);
    assert.equal(websiteFeedWarning({ latestWebsiteOrderAt: "2026-10-26T00:00:00Z", websiteMayBeIncomplete: false, shopifyWebhooksReceived: 0, lastShopifyWebhookAt: null }, fmt), null);
    assert.match(websiteFeedWarning({ latestWebsiteOrderAt: "2026-10-07T12:45:00Z", websiteMayBeIncomplete: true, shopifyWebhooksReceived: 0, lastShopifyWebhookAt: null }, fmt) ?? "", /2026-10-07.*never received a Shopify order webhook/);
    assert.match(websiteFeedWarning({ latestWebsiteOrderAt: "2026-10-07T12:45:00Z", websiteMayBeIncomplete: true, shopifyWebhooksReceived: 12, lastShopifyWebhookAt: "2026-10-07T12:50:00Z" }, fmt) ?? "", /last Shopify webhook arrived 2026-10-07/);
    const stale = { latestWebsiteOrderAt: "2026-10-26T00:00:00Z", websiteMayBeIncomplete: false, shopifyWebhooksReceived: 3, lastShopifyWebhookAt: "2026-10-26T00:00:00Z" };
    assert.match(websiteFeedWarning(stale, fmt, { coverage: "PARTIAL", verification: { shopifyCount: 8910, crmCount: 274, verified: true } }) ?? "", /Shopify has 8,910 orders for this period but the CRM holds 274/);
    assert.match(websiteFeedWarning(stale, fmt, { coverage: "NONE", verification: { shopifyCount: null, crmCount: 0, verified: false } }) ?? "", /incomplete/);
    assert.equal(websiteFeedWarning(stale, fmt, { coverage: "FULL", verification: { shopifyCount: 100, crmCount: 100, verified: true } }), null);
  });
  it("today is read in the business timezone; custom range validation explains each mistake", () => {
    assert.equal(todayIn("Asia/Kolkata", new Date("2026-10-25T18:40:00Z")), "2026-10-26");
    const today = "2026-10-26";
    assert.equal(validateCustomRange("2026-10-20", "2026-10-26", today), null);
    assert.match(validateCustomRange(undefined, "2026-10-26", today) ?? "", /both a From and a To/);
    assert.match(validateCustomRange("2026-10-22", "2026-10-20", today) ?? "", /on or before/);
    assert.match(validateCustomRange("2026-10-20", "2026-10-27", today) ?? "", /future/);
    assert.match(validateCustomRange("2025-01-01", "2026-10-26", today) ?? "", /at most 366 days/);
  });
  it("formatting", () => {
    assert.equal(formatInr(2796), "₹2,796");
    assert.equal(describeRange({ from: "2026-10-25", to: "2026-10-25" }), "25 Oct 2026");
    assert.equal(describeRange({ from: "2026-10-20", to: "2026-10-25" }), "20 Oct 2026 - 25 Oct 2026");
  });
  it("the navigation item exists for ADMIN and MANAGER only", () => {
    const has = (role: keyof typeof NAV_BY_ROLE) => JSON.stringify(NAV_BY_ROLE[role]).includes("/dashboard/orders-dashboard");
    assert.deepEqual([has("ADMIN"), has("MANAGER"), has("SALESPERSON"), has("HR"), has("RECRUITER")], [true, true, false, false, false]);
  });
  void ({} as Coverage);
});
