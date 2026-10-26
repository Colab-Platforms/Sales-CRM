import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShopifyApiError } from "../shopify/shopify.client.js";
import { ORDER_LIST_QUERY } from "../shopify/shopify.queries.js";
import { Role } from "../../../generated/prisma/enums.js";
import { LiveWebsiteOrders, localDate, rangeSearch } from "./orders.dashboard.live.source.js";
import { LiveWebsiteDashboardService } from "./orders.dashboard.live.service.js";
import { chartBuckets, filterOrders, summarize } from "./orders.dashboard.live.metrics.js";

// No network and no database: Shopify is a scripted fake and the "database" is a stub that can only SELECT (any write attempt throws).

const NOW = new Date("2026-10-26T09:00:00Z");
const admin = { id: "u1", role: Role.ADMIN } as never;
const manager = { id: "u2", role: Role.MANAGER } as never;
const salesperson = { id: "u3", role: Role.SALESPERSON } as never;

const money = (amount: string, currencyCode = "INR") => ({ shopMoney: { amount, currencyCode } });
let seq = 1000;
interface NodeOver { id?: number; createdAt?: string; total?: string; refunded?: string; financial?: string; fulfillment?: string; cancelledAt?: string | null; tags?: string[]; gateways?: string[]; currency?: string; tx?: unknown[]; phone?: string }
function node(o: NodeOver = {}) {
  const id = o.id ?? seq++;
  const gateways = o.gateways ?? ["Cash on Delivery (COD)"];
  const paid = o.financial === "PAID";
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#AW${id}`,
    createdAt: o.createdAt ?? "2026-10-25T04:00:00Z",
    processedAt: o.createdAt ?? "2026-10-25T04:00:00Z",
    cancelledAt: o.cancelledAt ?? null,
    displayFinancialStatus: o.financial ?? "PENDING",
    displayFulfillmentStatus: o.fulfillment ?? "UNFULFILLED",
    returnStatus: "NO_RETURN",
    tags: o.tags ?? [],
    paymentGatewayNames: gateways,
    email: null,
    phone: o.phone ?? "+919800000001",
    customer: { firstName: "Asha", lastName: "K", email: null, phone: null },
    shippingLine: { title: "Standard" },
    totalPriceSet: money(o.total ?? "649.00", o.currency),
    totalRefundedSet: money(o.refunded ?? "0.00", o.currency),
    lineItems: { nodes: [{ id: "gid://shopify/LineItem/1" }] },
    transactions: o.tx ?? (paid ? [{ id: `gid://shopify/OrderTransaction/${id}`, kind: "SALE", status: "SUCCESS", gateway: gateways[0], processedAt: o.createdAt ?? "2026-10-25T04:00:00Z", amountSet: money(o.total ?? "649.00", o.currency) }] : []),
    fulfillments: [],
  };
}

interface FakeOpts { pageSize?: number; countOverride?: number; failOn?: (call: number) => unknown }
/** A scripted Shopify: serves `nodes` page by page for ORDER_LIST_QUERY and the count for the count query. Records every request. */
function fakeShopify(nodes: ReturnType<typeof node>[], opts: FakeOpts = {}) {
  const calls: { document: string; variables: Record<string, unknown> }[] = [];
  const client = {
    async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      calls.push({ document, variables });
      const failure = opts.failOn?.(calls.length);
      if (failure) throw failure;
      if (document === ORDER_LIST_QUERY) {
        const size = opts.pageSize ?? 100;
        const start = variables.after ? Number(String(variables.after).replace("c", "")) : 0;
        const slice = nodes.slice(start, start + size);
        const next = start + size;
        return { orders: { pageInfo: { hasNextPage: next < nodes.length, hasPreviousPage: start > 0, startCursor: `c${start}`, endCursor: `c${next}` }, nodes: slice } } as T;
      }
      return { result: { count: opts.countOverride ?? nodes.length, precision: "EXACT" } } as T; // count query
    },
  };
  return { client, calls };
}

/** A database stub that can only read: `crm` lists Shopify ids of orders created in the CRM by a telecaller. Any other call (create, update, delete...) throws. */
function readOnlyDb(crm: string[] = [], failRead = false) {
  const writes: string[] = [];
  const reads: unknown[] = [];
  const order = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      if (prop === "findMany") {
        return async (args: unknown) => {
          reads.push(args);
          if (failRead) throw new Error("db down");
          return crm.map((externalId) => ({ externalId }));
        };
      }
      return () => {
        writes.push(prop);
        throw new Error(`database write attempted: order.${prop}`);
      };
    },
  });
  const db = new Proxy({ order }, { get: (t, prop: string) => (prop in t ? (t as never)[prop] : () => { writes.push(prop); throw new Error(`database access attempted: ${prop}`); }) });
  return { db: db as never, writes, reads };
}

const range = { start: new Date("2026-10-24T18:30:00Z"), end: new Date("2026-10-25T18:30:00Z"), timezone: "Asia/Kolkata" };
const make = (nodes: ReturnType<typeof node>[], opts: FakeOpts = {}, dbOpts: { crm?: string[]; failRead?: boolean } = {}, maxOrders?: number) => {
  const shopify = fakeShopify(nodes, opts);
  const database = readOnlyDb(dbOpts.crm, dbOpts.failRead);
  const source = new LiveWebsiteOrders({ db: database.db, client: () => shopify.client as never, now: () => NOW, maxOrders });
  return { source, shopify, database };
};

describe("live website orders - fetching", () => {
  it("asks Shopify for exactly the IST day (exact instants, created_at >= start and < end)", () => {
    assert.equal(rangeSearch(range), "created_at:>='2026-10-24T18:30:00.000Z' created_at:<'2026-10-25T18:30:00.000Z'");
  });

  it("follows every page - 250 orders over 3 pages are all counted, none twice", async () => {
    const nodes = Array.from({ length: 250 }, (_, i) => node({ id: 5000 + i }));
    const { source, shopify } = make(nodes);
    const r = await source.fetch(range);
    assert.equal(r.orders.length, 250);
    assert.equal(new Set(r.orders.map((o) => o.externalId)).size, 250);
    assert.equal(r.pages, 3);
    assert.equal(shopify.calls.filter((c) => c.document === ORDER_LIST_QUERY).length, 3);
    assert.deepEqual(r.warnings, []);
  });

  it("an order repeated by Shopify across pages is counted once", async () => {
    const dup = node({ id: 77 });
    const { source } = make([dup, node({ id: 78 }), dup], { pageSize: 2, countOverride: 3 });
    const r = await source.fetch(range);
    assert.equal(r.orders.length, 2);
    assert.ok(r.warnings.some((w) => /reported 3 orders .* 2 were read/.test(w)), "a count mismatch is surfaced, not hidden");
  });

  it("an empty range is a genuine empty result (zero orders, no warning)", async () => {
    const { source } = make([]);
    const r = await source.fetch(range);
    assert.equal(r.orders.length, 0);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.shopifyCount, 0);
  });

  it("date boundaries: an order outside [start, end) returned by Shopify is dropped; 18:29:59Z belongs to the day, 18:30:00Z to the next", async () => {
    const { source } = make([node({ id: 1, createdAt: "2026-10-24T18:29:59Z" }), node({ id: 2, createdAt: "2026-10-24T18:30:00Z" }), node({ id: 3, createdAt: "2026-10-25T18:29:59Z" }), node({ id: 4, createdAt: "2026-10-25T18:30:00Z" })]);
    const r = await source.fetch(range);
    assert.deepEqual(r.orders.map((o) => o.externalId).sort(), ["2", "3"]);
    assert.equal(localDate(new Date("2026-10-24T18:30:00Z"), "Asia/Kolkata"), "2026-10-25");
    assert.equal(localDate(new Date("2026-10-25T18:29:59Z"), "Asia/Kolkata"), "2026-10-25");
  });

  it("refuses a range larger than the limit with an explanation instead of returning cut-off totals", async () => {
    const { source } = make([node(), node(), node()], {}, {}, 2);
    await assert.rejects(source.fetch(range), (e: { statusCode: number; message: string }) => e.statusCode === 422 && /at most 2/.test(e.message));
  });

  it("a rate-limited Shopify (429) is reported as such - never as zeros", async () => {
    const { source } = make([node()], { failOn: () => new ShopifyApiError("Shopify is rate limiting requests (429).", 429) });
    await assert.rejects(source.fetch(range), (e: { statusCode: number; message: string }) => e.statusCode === 429 && /rate limiting/.test(e.message));
  });

  it("a Shopify failure half way through the pages fails the request (no partial totals)", async () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node({ id: 9000 + i }));
    const { source } = make(nodes, { pageSize: 10, failOn: (call) => (call === 3 ? new ShopifyApiError("boom token=shpat_secret", 500) : null) });
    await assert.rejects(source.fetch(range), (e: { statusCode: number; message: string }) => e.statusCode === 502 && !/shpat_secret/.test(e.message));
  });

  it("a failure is not remembered: the next call reads Shopify again", async () => {
    let fail = true;
    const { source, shopify } = make([node()], { failOn: () => (fail ? new ShopifyApiError("down", 503) : null) });
    await assert.rejects(source.fetch(range));
    fail = false;
    assert.equal((await source.fetch(range)).orders.length, 1);
    assert.ok(shopify.calls.length >= 2);
  });

  it("concurrent requests for the same range (cards + chart + list) share one fetch", async () => {
    const { source, shopify } = make([node(), node()]);
    await Promise.all([source.fetch(range), source.fetch(range), source.fetch(range)]);
    assert.equal(shopify.calls.filter((c) => c.document === ORDER_LIST_QUERY).length, 1);
  });

  it("only queries are sent to Shopify - no mutation", async () => {
    const { source, shopify } = make([node()]);
    await source.fetch(range);
    assert.ok(shopify.calls.every((c) => !/\bmutation\b/i.test(c.document)));
  });
});

describe("live website orders - website vs telecaller", () => {
  it("leaves out orders tagged 'Order Created by <name>' and orders the CRM holds as telecaller-created; the rest are website orders", async () => {
    const nodes = [node({ id: 1 }), node({ id: 2, tags: ["Order Created by Asha"] }), node({ id: 3 }), node({ id: 4, tags: ["vip"] })];
    const { source, database } = make(nodes, {}, { crm: ["3"] });
    const r = await source.fetch(range);
    assert.deepEqual(r.orders.map((o) => o.externalId).sort(), ["1", "4"]);
    assert.equal(r.telecallerExcluded, 2);
    assert.equal(r.shopifyOrders, 4);
    assert.equal(database.writes.length, 0);
  });

  it("the CRM lookup is a SELECT limited to non-storefront sources, by Shopify id (numeric and GID forms)", async () => {
    const { source, database } = make([node({ id: 11 })]);
    await source.fetch(range);
    const where = (database.reads[0] as { where: { source: unknown; externalId: { in: string[] } } }).where;
    assert.deepEqual(where.source, { notIn: ["SHOPIFY", "WEBSITE"] });
    assert.deepEqual(where.externalId.in, ["11", "gid://shopify/Order/11"]);
  });

  it("a name that merely looks like a telecaller never matters - only the tag or the CRM record does", async () => {
    const { source } = make([node({ id: 1, tags: ["Created by Asha", "Order created"] })]);
    assert.equal((await source.fetch(range)).orders.length, 1);
  });

  it("if the CRM cannot be read the page says so (and still leaves out tagged orders)", async () => {
    const { source } = make([node({ id: 1 }), node({ id: 2, tags: ["Order Created by Bala"] })], {}, { failRead: true });
    const r = await source.fetch(range);
    assert.equal(r.orders.length, 1);
    assert.ok(r.warnings.some((w) => /could not be checked/.test(w)));
  });
});

describe("live website orders - figures", () => {
  const fetchAll = async (nodes: ReturnType<typeof node>[]) => (await make(nodes).source.fetch(range)).orders;

  it("COD / prepaid / paid / pending / cancelled / fulfilled follow the same definitions as the database dashboard", async () => {
    const orders = await fetchAll([
      node({ id: 1, total: "699.00" }), // COD, pending
      node({ id: 2, total: "1000.00", financial: "PAID", gateways: ["Cashfree"] }), // prepaid, paid
      node({ id: 3, total: "500.00", cancelledAt: "2026-10-25T06:00:00Z" }), // COD, cancelled
      node({ id: 4, total: "300.00", financial: "PAID", gateways: ["Cashfree"], fulfillment: "FULFILLED" }), // prepaid, paid, fulfilled (shipped)
    ]);
    const s = summarize(orders);
    assert.deepEqual(s, { totalOrders: 4, totalValue: 1999, cod: 2, prepaid: 2, paid: 2, pendingPayment: 2, cancelled: 1, cancelledValue: 500, fulfilled: 1 });
  });

  it("money is added in whole cents: ten orders of 0.10 + 0.20 never drift, totals are Shopify's order total (tax/shipping/discount already inside it)", async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node({ id: 100 + i, total: i % 2 ? "0.10" : "0.20" }));
    const s = summarize(await fetchAll(nodes));
    assert.equal(s.totalValue, 1.5);
    const odd = summarize(await fetchAll([node({ id: 1, total: "649.995" }), node({ id: 2, total: "10.005" })]));
    assert.equal(odd.totalValue, 660.01, "each total is rounded to cents once, then summed as integers");
  });

  it("a fully refunded paid order stays in the totals at its gross amount (refunds are not netted - same as the database dashboard); a non-INR order is left out of the value with a warning", async () => {
    const paidRefunded = node({ id: 1, total: "500.00", financial: "REFUNDED", refunded: "500.00", gateways: ["Cashfree"], tx: [
      { id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "Cashfree", processedAt: "2026-10-25T04:00:00Z", amountSet: money("500.00") },
      { id: "gid://shopify/OrderTransaction/2", kind: "REFUND", status: "SUCCESS", gateway: "Cashfree", processedAt: "2026-10-25T08:00:00Z", amountSet: money("500.00"), parentTransaction: { id: "gid://shopify/OrderTransaction/1" } },
    ] });
    const usd = node({ id: 2, total: "10.00", currency: "USD" });
    const { source } = make([paidRefunded, usd]);
    const r = await source.fetch(range);
    const s = summarize(r.orders);
    assert.equal(s.totalOrders, 2);
    assert.equal(s.totalValue, 500);
    assert.equal(s.paid, 0, "a refunded payment is no longer 'paid'");
    assert.ok(r.warnings.some((w) => /not in INR/.test(w)));
  });

  it("filterOrders: the clicked card, search and payment filter narrow ONE list; the card number equals the list length", async () => {
    const orders = await fetchAll([node({ id: 1 }), node({ id: 2, financial: "PAID", gateways: ["Cashfree"], phone: "+919811112222" }), node({ id: 3, cancelledAt: "2026-10-25T06:00:00Z" })]);
    const s = summarize(orders);
    assert.equal(filterOrders(orders, { metric: "COD" }).length, s.cod);
    assert.equal(filterOrders(orders, { metric: "CANCELLED" }).length, s.cancelled);
    assert.equal(filterOrders(orders, { metric: "TOTAL", search: "9811112222" }).length, 1);
    assert.equal(filterOrders(orders, { metric: "TOTAL", search: "#AW3" }).length, 1);
    assert.equal(filterOrders(orders, { paymentStatus: "SUCCESS" }).length, 1);
  });

  it("chart buckets add up to the cards and use IST days: 23:59 IST and 00:01 IST fall on different days", async () => {
    // a 2-day range (24 and 25 Oct IST)
    const wide = { start: new Date("2026-10-23T18:30:00Z"), end: new Date("2026-10-25T18:30:00Z"), timezone: "Asia/Kolkata" };
    const got = (await make([
      node({ id: 1, createdAt: "2026-10-24T18:29:00Z", total: "100.00" }),
      node({ id: 2, createdAt: "2026-10-24T18:31:00Z", total: "200.00" }),
      node({ id: 3, createdAt: "2026-10-25T10:00:00Z", total: "50.00", cancelledAt: "2026-10-25T11:00:00Z" }),
    ]).source.fetch(wide)).orders;
    const buckets = chartBuckets(got, { from: "2026-10-24", to: "2026-10-25" }, "daily");
    assert.deepEqual(buckets.map((b) => [b.key, b.orders, b.revenue]), [["2026-10-24", 1, 100], ["2026-10-25", 2, 200]]);
    const s = summarize(got);
    assert.equal(buckets.reduce((a, b) => a + (b.orders ?? 0), 0), s.totalOrders);
    assert.equal(buckets.reduce((a, b) => a + (b.revenue ?? 0), 0), s.totalValue);
  });
});

describe("live website dashboard service", () => {
  const svc = (nodes: ReturnType<typeof node>[], opts: FakeOpts = {}) => {
    const m = make(nodes, opts);
    return { service: new LiveWebsiteDashboardService(m.source, () => NOW), ...m };
  };

  it("overview: cards, coverage FULL, live block (source, counts, telecaller excluded) and a details page for a clicked card", async () => {
    const { service } = svc([node({ id: 1 }), node({ id: 2, financial: "PAID", gateways: ["Cashfree"] }), node({ id: 3, tags: ["Order Created by Asha"] })]);
    const r = await service.overview(admin, { range: "yesterday", metric: "COD" }, 1, 25);
    assert.equal(r.coverage, "FULL");
    assert.equal(r.summary.totalOrders, 2);
    assert.equal(r.live.source, "SHOPIFY_LIVE");
    assert.equal(r.live.telecallerExcluded, 1);
    assert.equal(r.live.shopifyOrders, 3);
    assert.equal(r.details?.items.length, r.summary.cod);
    assert.equal(r.details?.pagination.totalItems, r.summary.cod);
    assert.equal(r.details?.items[0]?.section, "WEBSITE");
  });

  it("details paginate without repeats", async () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node({ id: 200 + i, createdAt: `2026-10-25T0${i % 9}:00:00Z` }));
    const { service } = svc(nodes);
    const p1 = await service.overview(admin, { range: "yesterday", metric: "TOTAL" }, 1, 25);
    const p2 = await service.overview(admin, { range: "yesterday", metric: "TOTAL" }, 2, 25);
    assert.equal(p1.details?.items.length, 25);
    assert.equal(p2.details?.items.length, 5);
    assert.equal(new Set([...p1.details!.items, ...p2.details!.items].map((i) => i.id)).size, 30);
  });

  it("overview without a clicked card sends no rows", async () => {
    const { service } = svc([node()]);
    assert.equal((await service.overview(manager, { range: "yesterday" }, 1, 25)).details, null);
  });

  it("an unreadable Shopify is an error, not zero cards", async () => {
    const { service } = svc([node()], { failOn: () => new ShopifyApiError("down", 503) });
    await assert.rejects(service.overview(admin, { range: "yesterday" }, 1, 25), (e: { statusCode: number }) => e.statusCode === 502);
  });

  it("the comparison is skipped (null) when the previous period cannot be read, but the current figures still show", async () => {
    // the 2nd fetch (previous period) fails: calls 1-2 = count + list for the current period
    const { service } = svc([node()], { failOn: (call) => (call >= 3 ? new ShopifyApiError("down", 503) : null) });
    const r = await service.overview(admin, { range: "yesterday" }, 1, 25);
    assert.equal(r.summary.totalOrders, 1);
    assert.equal(r.comparison, null);
  });

  it("chart: buckets and totals match the cards; unknown interval refused", async () => {
    const { service } = svc([node({ id: 1, total: "100.00" }), node({ id: 2, total: "250.50" })]);
    const c = await service.chart(admin, { range: "yesterday" }, "daily");
    const o = await service.overview(admin, { range: "yesterday" }, 1, 25);
    assert.deepEqual(c.totals, { orders: o.summary.totalOrders, revenue: o.summary.totalValue });
    assert.equal(c.coverage, "FULL");
    await assert.rejects(service.chart(admin, { range: "yesterday" }, "hourly" as never));
  });

  it("only Admin and Manager may read it (the service checks the role again)", async () => {
    const { service } = svc([node()]);
    await assert.rejects(service.overview(salesperson, { range: "yesterday" }, 1, 25), (e: { statusCode: number }) => e.statusCode === 403);
    await assert.rejects(service.chart(salesperson, { range: "yesterday" }, "daily"), (e: { statusCode: number }) => e.statusCode === 403);
    await assert.rejects(service.exportXlsx(salesperson, { range: "yesterday" }), (e: { statusCode: number }) => e.statusCode === 403);
  });

  it("the whole read path performs no database write (overview, chart, export)", async () => {
    const { service, database } = svc([node(), node({ tags: ["Order Created by Asha"] })]);
    await service.overview(admin, { range: "yesterday", metric: "TOTAL" }, 1, 25);
    await service.chart(admin, { range: "yesterday" }, "daily");
    const file = await service.exportXlsx(admin, { range: "yesterday" });
    assert.ok(file.rows >= 1 && file.buffer.length > 0);
    assert.deepEqual(database.writes, []);
  });
});
