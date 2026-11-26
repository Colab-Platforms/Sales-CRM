// Orders list count and Excel download. A fake Shopify (paged, with search cursors) and a fake CRM: no network, no database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import ExcelJS from "exceljs";
import express from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import OrdersLiveService, { clearLiveOrderCaches } from "./orders.live.service.js";
import { MAX_BULK_ORDERS, ORDER_BULK_ROLES, OrdersLiveBulkService, type BulkFilters } from "./orders.live.bulk.js";
import { validateLiveOrdersExport } from "./orders.live.validators.js";

process.env.JWT_SECRET ||= "throwaway-test-secret";
const { requireRole } = await import("@/middlewares/auth.js");
const { makeCountLiveOrders, makeExportLiveOrders } = await import("./orders.live.controller.js");

const user = (role: Role = Role.ADMIN) => ({ id: "00000000-0000-4000-8000-000000000001", role, username: "u" }) as never;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SALESPERSON = uuid(900001);

// Order n (1..N): odd = prepaid and paid, even = COD pending. Every 4th is not synced into the CRM. Every 5th CRM order was booked by the salesperson.
const node = (n: number) => ({
  id: `gid://shopify/Order/${n}`,
  name: `#${n}`,
  createdAt: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(),
  displayFinancialStatus: n % 2 ? "PAID" : "PENDING",
  displayFulfillmentStatus: n % 3 ? "UNFULFILLED" : "FULFILLED",
  tags: [] as string[],
  paymentGatewayNames: [n % 2 ? "razorpay" : "Cash on Delivery (COD)"],
  customer: { firstName: n === 1 ? "=HYPERLINK(1)" : "Buyer", lastName: String(n), phone: `+9190000${String(n).padStart(5, "0")}` },
  totalPriceSet: { shopMoney: { amount: "500.00", currencyCode: "INR" } },
  lineItems: { nodes: [{ id: "l1" }] },
  transactions: [],
  fulfillments: [],
});
const crmRow = (n: number) => ({
  id: uuid(n),
  externalId: String(n),
  totalAmount: "500.00",
  status: n % 10 === 0 ? "CANCELLED" : "CONFIRMED",
  source: n % 5 === 0 ? "SALESPERSON" : "SHOPIFY",
  payments: [{ status: n % 2 ? "SUCCESS" : "PENDING", method: n % 2 ? "UPI" : "COD" }],
  confirmedByName: null,
  metadata: null,
  createdBy: n % 5 === 0 ? { id: SALESPERSON, name: "Asha" } : null,
  _count: { items: 2 },
  lead: { id: `lead-${n}`, leadNumber: `L-${n}`, firstName: "Buyer", lastName: String(n), owner: null, source: null },
});
const synced = (n: number) => n % 4 !== 0;

function world(total: number, options: { overlap?: boolean; crmDown?: boolean; waitMs?: number; maxOrders?: number; throttle?: number; gate?: Promise<void>; failLists?: number; extraOnIds?: number } = {}) {
  const calls = { count: [] as string[], list: [] as { first: number; after: string | null; query: string }[] };
  let throttle = options.throttle ?? 0;
  let failLists = options.failLists ?? 0;
  const orders = Array.from({ length: total }, (_, i) => node(total - i)); // newest first
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("ConnectionCheck")) return json({ data: { shop: { name: "D", myshopifyDomain: "d.myshopify.com", currencyCode: "INR", ianaTimezone: "Asia/Kolkata" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } });
    if (query.includes("query Count")) {
      calls.count.push(variables.query);
      return json({ data: { result: { count: total, precision: "EXACT" } } });
    }
    assert.ok(query.includes("query OrderList"), "only reads are sent to Shopify");
    calls.list.push(variables);
    await options.gate;
    if (failLists > 0) {
      failLists--;
      return new Response("no", { status: 403 });
    }
    if (throttle > 0) {
      throttle--;
      return json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    }
    let matching = orders;
    const ids = [...String(variables.query).matchAll(/\bid:(\d+)/g)].map((m) => Number(m[1]));
    if (ids.length) matching = orders.filter((o) => ids.includes(Number(o.name.slice(1))) || Number(o.name.slice(1)) === options.extraOnIds);
    const at = Number(variables.after ?? 0);
    // "overlap": each further page repeats the previous page's last row, as happens when the list shifts while it is being read
    const from = options.overlap && at > 0 ? at - 1 : at;
    const nodes = matching.slice(from, at + variables.first);
    const end = at + variables.first;
    return json({ data: { orders: { pageInfo: { hasNextPage: end < matching.length, hasPreviousPage: at > 0, startCursor: String(at), endCursor: String(end) }, edges: nodes.map((_, i) => ({ cursor: String(from + i + 1) })), nodes } } });
  }) as unknown as typeof fetch;
  const getClient = () => new ShopifyClient(loadShopifyConfig({ SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_faketoken", SHOPIFY_API_VERSION: "2026-01" }), { fetchImpl, sleep: async () => {} });
  const db = {
    order: {
      findMany: async ({ where }: { where: { id?: { in: string[] }; externalId?: { in: string[] } } }) => {
        if (options.crmDown) throw new Error("db down");
        const numbers = where.id ? where.id.in.map((id) => Number(id.slice(-12))) : where.externalId!.in.filter((v) => /^\d+$/.test(v)).map(Number);
        return numbers.filter((n) => n >= 1 && n <= total && synced(n)).map(crmRow);
      },
    },
    user: { findMany: async () => [{ name: "Asha" }] },
    source: { findMany: async () => [] },
    lead: { findMany: async () => [] },
  } as never;
  const service = new OrdersLiveBulkService({ db, getShopifyClient: getClient, sleep: async () => {}, waitMs: options.waitMs ?? 30_000, maxOrders: options.maxOrders });
  return { service, calls, db, getClient };
}

const numbers = Array.from({ length: 250 }, (_, i) => i + 1);
const ready = <T extends { status: string }>(r: T) => {
  assert.equal(r.status, "ready");
  return r as Extract<T, { status: "ready" }>;
};
async function sheets(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const orders = wb.getWorksheet("Orders")!;
  const headers = (orders.getRow(1).values as string[]).slice(1);
  const rows: Record<string, unknown>[] = [];
  orders.eachRow((row, i) => {
    if (i > 1) rows.push(Object.fromEntries(headers.map((h, c) => [h, row.getCell(c + 1).value])));
  });
  const summary: Record<string, unknown> = {};
  wb.getWorksheet("Summary")!.eachRow((row) => (summary[String(row.getCell(1).value)] = row.getCell(2).value));
  return { headers, rows, summary };
}

describe("matching-order count", () => {
  it("date range and search only: one Shopify count request, no order reads, with the same search the list sends", async () => {
    const w = world(250);
    const filters: BulkFilters = { search: "asha", dateFrom: new Date("2026-09-30T18:30:00.000Z"), dateTo: new Date("2026-10-05T18:29:59.999Z") };
    assert.deepEqual(await w.service.count(user(), filters), { status: "ready", total: 250 });
    assert.deepEqual([w.calls.count.length, w.calls.list.length], [1, 0]);
    clearLiveOrderCaches();
    await new OrdersLiveService(w.db, w.getClient).listLiveOrders(user(), { ...filters, first: 20 });
    assert.equal(w.calls.count[0], w.calls.list[0]!.query);
    assert.equal(w.calls.count[0], "created_at:>='2026-09-30T18:30:00.000Z' created_at:<'2026-10-05T18:29:59.999Z' asha");
  });

  it("several CRM filters: counts every match across all Shopify pages - exactly the rows the paginated list shows", async () => {
    const filters = { paymentMode: ["COD" as const], source: ["SHOPIFY" as const], status: ["CONFIRMED" as const] };
    const w = world(250);
    const expected = numbers.filter((n) => synced(n) ? n % 2 === 0 && n % 5 !== 0 && n % 10 !== 0 : false);
    const counted = ready(await w.service.count(user(), filters)).total;
    assert.equal(w.calls.list.length, 3);

    clearLiveOrderCaches();
    const list = new OrdersLiveService(w.db, w.getClient);
    const shown: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await list.listLiveOrders(user(), { ...filters, first: 20, after });
      shown.push(...r.items.map((i) => i.orderNumber));
      if (!r.pageInfo.hasNextPage) break;
      after = r.pageInfo.endCursor!;
    }
    assert.equal(new Set(shown).size, shown.length, "the list repeats nothing");
    assert.equal(counted, shown.length);
    assert.ok(counted >= expected.length && expected.length > 20, "more than one list page matched");
  });

  it("salesperson, source, total and fulfilment filters combine, and changing them does not read Shopify again", async () => {
    const w = world(250);
    const booked = numbers.filter((n) => synced(n) && n % 5 === 0);
    assert.equal(ready(await w.service.count(user(), { salespersonId: [SALESPERSON] })).total, booked.length);
    assert.equal(ready(await w.service.count(user(), { salespersonId: [SALESPERSON], source: ["SALESPERSON"], fulfillment: ["FULFILLED"], totalMin: 100 })).total, booked.filter((n) => n % 3 === 0).length);
    assert.equal(ready(await w.service.count(user(Role.MANAGER), { totalMin: 10_000 })).total, 0);
    assert.equal(w.calls.list.length, 3);
    // a different date range is a different Shopify set
    await w.service.count(user(), { salespersonId: [SALESPERSON], dateFrom: new Date("2026-10-01T00:00:00Z") });
    assert.equal(w.calls.list.length, 6);
    // a CRM change (cancellation, sync) drops the finished read
    w.service.clearFinished();
    await w.service.count(user(), { salespersonId: [SALESPERSON] });
    assert.equal(w.calls.list.length, 9);
  });

  it("a long read answers pending with progress, concurrent requests share the one read, then it is ready", async () => {
    let open!: () => void;
    const w = world(250, { gate: new Promise<void>((r) => (open = r)), waitMs: 20 });
    const [a, b] = await Promise.all([w.service.count(user(), { paymentMode: ["COD"] }), w.service.exportFiltered(user(Role.MANAGER), { paymentMode: ["PREPAID"] })]);
    assert.deepEqual(a, { status: "pending", checked: 0, expected: 250 });
    assert.equal(b.status, "pending");
    assert.equal(w.calls.list.length, 1);
    open();
    await new Promise((r) => setTimeout(r, 200));
    const cod = ready(await w.service.count(user(), { paymentMode: ["COD"] })).total;
    const prepaid = ready(await w.service.exportFiltered(user(), { paymentMode: ["PREPAID"] })).rows;
    assert.equal(cod + prepaid, 250);
    assert.equal(w.calls.list.length, 3);
  });

  it("never answers with a partial figure: too many orders, a CRM failure and a Shopify failure are errors", async () => {
    const big = world(250, { maxOrders: 200 });
    await assert.rejects(big.service.count(user(), { paymentMode: ["COD"] }), (e: { statusCode: number; message: string }) => e.statusCode === 422 && /Choose a shorter date range/.test(e.message));
    assert.equal(big.calls.list.length, 0);
    await assert.rejects(big.service.exportFiltered(user(), {}), { statusCode: 422 });

    await assert.rejects(world(250, { crmDown: true }).service.count(user(), { paymentMode: ["COD"] }), { statusCode: 503 });

    const flaky = world(150, { failLists: 1 });
    await assert.rejects(flaky.service.count(user(), { paymentMode: ["COD"] }), { statusCode: 502 });
    assert.equal(ready(await flaky.service.count(user(), { paymentMode: ["COD"] })).status, "ready", "the failure is not remembered");
  });

  it("waits out Shopify throttling during a long read", async () => {
    const w = world(150, { throttle: 5 }); // more than the client's own three attempts
    assert.ok(ready(await w.service.count(user(), { paymentMode: ["COD"] })).total > 0);
  });
});

describe("download filtered orders", () => {
  it("exports every match across pages, once each, with the list's details", async () => {
    const w = world(250, { overlap: true });
    const file = ready(await w.service.exportFiltered(user(), { salespersonId: [SALESPERSON] }));
    const { headers, rows, summary } = await sheets(file.buffer);
    const booked = numbers.filter((n) => synced(n) && n % 5 === 0);
    assert.deepEqual(rows.map((r) => r["Order ID"]), [...booked].reverse().map((n) => `#${n}`));
    for (const h of ["Order ID", "Customer", "Phone", "Total", "Payment method", "Payment status", "Order status", "Fulfilment", "Order source", "Salesperson", "Tags"]) assert.ok(headers.includes(h), h);
    const first = rows[0]!;
    assert.deepEqual([first["Salesperson"], first["Total"], first["Items"], first["Synced to CRM"], first["Phone"]], ["Asha", 500, 2, "Yes", "'+919000000250"]);
    // 250 minutes after midnight UTC, written as India time
    assert.equal((rows.at(-1)!["Order date (Asia/Kolkata)"] as Date).toISOString(), "2026-10-01T05:35:00.000Z");
    assert.deepEqual([summary["Salesperson"], summary["Rows in the Orders sheet"]], ["Asha", booked.length]);
    assert.match(file.filename, /^Orders_filtered_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("with no CRM filter it still exports every page, without duplicates, and spreadsheet formulas are defused", async () => {
    const w = world(250, { overlap: true });
    const file = ready(await w.service.exportFiltered(user(), {}));
    const { rows } = await sheets(file.buffer);
    assert.deepEqual([rows.length, new Set(rows.map((r) => r["Order ID"])).size, file.rows], [250, 250, 250]);
    assert.equal(rows.find((r) => r["Order ID"] === "#1")!["Customer"], "'=HYPERLINK(1) 1");
  });

  it("an empty result is an explained error, not an empty file", async () => {
    await assert.rejects(world(50).service.exportFiltered(user(), { totalMin: 9_999 }), { statusCode: 404, message: /No orders match/ });
    await assert.rejects(world(0).service.exportFiltered(user(), {}), { statusCode: 404 });
  });

  it("handles a large export", async () => {
    const w = world(9_500);
    const started = Date.now();
    const file = ready(await w.service.exportFiltered(user(), {}));
    assert.equal(file.rows, 9_500);
    assert.equal(w.calls.list.length, 95);
    console.log(`9,500 rows: ${Date.now() - started} ms, ${(file.buffer.length / 1024).toFixed(0)} KB (excluding Shopify network time)`);
    assert.equal(MAX_BULK_ORDERS, 20_000);
  });
});

describe("download selected orders", () => {
  it("exports only the ticked orders (CRM ids and unsynced Shopify ids), once each, ignoring the date window", async () => {
    const w = world(250, { extraOnIds: 99 }); // even if Shopify returned something not asked for, it is dropped
    const file = ready(await w.service.exportSelected(user(Role.MANAGER), [uuid(3), "shopify:8", uuid(3), uuid(7)]));
    const { rows, summary } = await sheets(file.buffer);
    assert.deepEqual(rows.map((r) => r["Order ID"]), ["#8", "#7", "#3"]);
    assert.deepEqual(rows.map((r) => r["Synced to CRM"]), ["No", "Yes", "Yes"]);
    assert.deepEqual([file.missing, summary["Download"]], [0, "Selected orders only"]);
    assert.equal(w.calls.list.length, 1);
    assert.deepEqual(w.calls.list[0]!.query.split(" OR ").sort(), ["id:3", "id:7", "id:8"]);
    assert.ok(!/created_at/.test(w.calls.list[0]!.query));
  });

  it("reads a large selection in pages and reports orders that could not be found", async () => {
    const w = world(250);
    const ids = [...numbers.filter(synced).slice(0, 150).map(uuid), uuid(5000), "shopify:777777"];
    const file = ready(await w.service.exportSelected(user(), ids));
    assert.deepEqual([file.rows, file.missing, w.calls.list.length], [150, 2, 2]);
  });

  it("refuses an empty selection, too large a selection, and a selection that matches nothing", async () => {
    const w = world(10);
    await assert.rejects(w.service.exportSelected(user(), []), { statusCode: 400, message: /Select at least one/ });
    await assert.rejects(w.service.exportSelected(user(), Array.from({ length: 1001 }, (_, i) => uuid(i + 1))), { statusCode: 400 });
    await assert.rejects(w.service.exportSelected(user(), ["shopify:424242"]), { statusCode: 404 });
  });
});

describe("more than one server process (the progress and the finished read are held in each process's memory)", () => {
  const until = async <T extends { status: string }>(ask: (turn: number) => Promise<T>) => {
    for (let turn = 0; turn < 500; turn++) {
      const r = await ask(turn);
      if (r.status === "ready") return { r, turn };
      await new Promise((r2) => setTimeout(r2, 5));
    }
    throw new Error("never finished");
  };

  it("with requests alternating between instances it still finishes with the complete result; each instance does its own full read", async () => {
    for (const instances of [2, 3]) {
      const w = world(250);
      const servers = Array.from({ length: instances }, () => new OrdersLiveBulkService({ db: w.db, getShopifyClient: w.getClient, waitMs: 1 }));
      const seen: number[] = [];
      const done = await until(async (turn) => {
        const r = await servers[turn % instances]!.count(user(), { paymentMode: ["COD"] });
        if (r.status === "pending") seen.push(r.checked);
        return r;
      });
      assert.deepEqual(done.r, { status: "ready", total: 125 }, `${instances} instances`);
      const file = await until((turn) => servers[(turn + 1) % instances]!.exportFiltered(user(), { paymentMode: ["COD"] }));
      assert.equal((file.r as { rows: number }).rows, 125, "a file always comes from one complete read");
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(w.calls.list.length >= 3 && w.calls.list.length <= 3 * instances, `${w.calls.list.length} Shopify pages for ${instances} instances`);
    }
  });

  it("a restart or deploy part-way through starts the read again and still returns the complete result", async () => {
    let open!: () => void;
    const w = world(250, { gate: new Promise<void>((r) => (open = r)), waitMs: 5 });
    assert.equal((await w.service.count(user(), { paymentMode: ["COD"] })).status, "pending");
    const replacement = new OrdersLiveBulkService({ db: w.db, getShopifyClient: w.getClient, waitMs: 5 });
    const first = await replacement.count(user(), { paymentMode: ["COD"] });
    assert.deepEqual(first, { status: "pending", checked: 0, expected: 250 });
    open();
    assert.deepEqual((await until(() => replacement.count(user(), { paymentMode: ["COD"] }))).r, { status: "ready", total: 125 });
  });
});

describe("Admin / Manager only", () => {
  it("the role list, the route gate and the service's own check agree", async () => {
    assert.deepEqual(ORDER_BULK_ROLES, [Role.ADMIN, Role.MANAGER]);
    for (const role of Object.values(Role)) {
      let error: unknown = null;
      requireRole(...ORDER_BULK_ROLES)({ user: { role } } as never, {} as never, ((e?: unknown) => (error = e ?? null)) as never);
      assert.equal(error === null, ORDER_BULK_ROLES.some((r) => r === role), role);
      if (ORDER_BULK_ROLES.some((r) => r === role)) continue;
      const w = world(10);
      await assert.rejects(w.service.count(user(role), {}), { statusCode: 403 });
      await assert.rejects(w.service.exportFiltered(user(role), {}), { statusCode: 403 });
      await assert.rejects(w.service.exportSelected(user(role), [uuid(1)]), { statusCode: 403 });
      assert.deepEqual([w.calls.count.length, w.calls.list.length], [0, 0]);
    }
  });
});

describe("request validation and HTTP responses", () => {
  it("the export takes either ids or the list's filters; unknown or bad values are refused, not dropped", () => {
    const ok = validateLiveOrdersExport({ filters: { paymentMode: "COD,PREPAID", first: 20, after: "x" } });
    assert.deepEqual([ok.error, ok.value], [null, { filters: { paymentMode: ["COD", "PREPAID"] } }]);
    assert.equal(validateLiveOrdersExport({ ids: [uuid(1), "shopify:5"] }).error, null);
    for (const bad of [undefined, {}, { ids: [] }, { ids: "x" }, { ids: ["1 OR id:2"] }, { ids: ["shopify:1) OR (id:2"] }, { ids: [uuid(1)], filters: {} }, { filters: { stauts: "CONFIRMED" } }, { filters: { status: "NOPE" } }, { filters: [] }, { filters: {}, all: true }]) {
      assert.ok(validateLiveOrdersExport(bad).error, JSON.stringify(bad));
    }
  });

  it("serves the count, a 202 while preparing, the .xlsx with its headers, and errors as JSON", async () => {
    let open!: () => void;
    const w = world(120, { gate: new Promise<void>((r) => (open = r)), waitMs: 10 });
    const app = express();
    app.use(express.json(), (req, _res, next) => {
      (req as unknown as { user: unknown }).user = user();
      next();
    });
    app.get("/count", makeCountLiveOrders(w.service));
    app.post("/export", makeExportLiveOrders(w.service));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise((r) => server.once("listening", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      type Body = { message: string; data: unknown };
      const body_ = async (r: Response) => (await r.json()) as Body;
      const post = (body: unknown) => fetch(`${base}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const waiting = await post({ filters: {} });
      assert.equal(waiting.status, 202);
      assert.deepEqual((await body_(waiting)).data, { status: "pending", checked: 0, expected: 120 });
      open();
      await new Promise((r) => setTimeout(r, 150));
      const file = await post({ filters: {} });
      assert.equal(file.status, 200);
      assert.match(file.headers.get("content-type")!, /spreadsheetml/);
      assert.match(file.headers.get("content-disposition")!, /Orders_filtered_.*\.xlsx/);
      assert.deepEqual([file.headers.get("x-export-rows"), file.headers.get("x-export-missing")], ["120", "0"]);
      assert.deepEqual((await body_(await fetch(`${base}/count?paymentMode=COD&first=20`))).data, { status: "ready", total: 60 });
      assert.equal((await fetch(`${base}/count?paymentMode=CASH`)).status, 400);
      const empty = await post({ filters: { totalMin: "9999" } });
      assert.deepEqual([empty.status, /No orders match/.test((await body_(empty)).message)], [404, true]);
      assert.equal((await post({ ids: [] })).status, 400);
    } finally {
      server.close();
    }
  });
});
