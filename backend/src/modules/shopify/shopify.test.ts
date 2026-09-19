import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import { ShopifyClient, ShopifyApiError, ShopifyGraphQLError } from "./shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "./shopify.config.js";
import { fetchOrder, listOrderRefs, normalizeOrder, orderNodeSchema } from "./shopify.orders.js";
import * as queries from "./shopify.queries.js";
import { maskEmail, maskName, maskPhone } from "./shopify.report.js";
import { analyseScopes } from "./shopify.sync.js";
import { CliUsageError, parseCliArgs, runCli } from "./shopify.cli.js";
import { codOrderNode, ENV, orderNode, TOKEN } from "./shopify.fixtures.js";
import type { TxRunner } from "./shopify.persist.js";

const config = () => loadShopifyConfig(ENV);

// ---- fakes ----

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake fetch that answers from a queue and records every request. */
function fakeFetch(...responses: Array<Response | Error | ((call: Call) => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next.clone();
  }) as typeof fetch;
  return { impl, calls };
}

const connectionData = (scopes = ["read_customers", "read_orders", "read_products"]) => ({
  shop: { name: "Demo Store", myshopifyDomain: "demo-store.myshopify.com", currencyCode: "INR" },
  currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
});

/** Answers ConnectionCheck, OrderRefs and OrderById the way Shopify would. */
function shopifyFake(opts: { orders?: Array<Record<string, unknown>>; scopes?: string[]; orderError?: Response } = {}) {
  const orders = opts.orders ?? [orderNode()];
  return fakeFetch((call) => {
    const { query, variables } = JSON.parse(String(call.init.body)) as { query: string; variables: { id?: string; first?: number } };
    if (query.includes("ConnectionCheck")) return json({ data: connectionData(opts.scopes) });
    if (query.includes("OrderRefs")) {
      const page = orders.slice(0, variables.first ?? orders.length);
      return json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: page.map((o) => ({ id: o.id, updatedAt: o.updatedAt })) } } });
    }
    if (opts.orderError) return opts.orderError;
    return json({ data: { order: orders.find((o) => o.id === variables.id) ?? null } });
  });
}

const noSleep = async () => {};
const everything = (error: unknown) => `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}\n${String(error)}`;

// ---- request construction ----

describe("request construction", () => {
  it("posts a JSON GraphQL request to the versioned Admin endpoint built from the config", async () => {
    const { impl, calls } = fakeFetch(json({ data: { ok: true } }));
    await new ShopifyClient(config(), { fetchImpl: impl }).query("query Q($n: Int!) { x }", { n: 3 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://demo-store.myshopify.com/admin/api/2026-01/graphql.json");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { query: "query Q($n: Int!) { x }", variables: { n: 3 } });
  });

  it("uses the store domain and version from the environment, not hard-coded values", async () => {
    const other = loadShopifyConfig({ ...ENV, SHOPIFY_STORE_DOMAIN: "Other-Shop.myshopify.com", SHOPIFY_API_VERSION: "2026-04" });
    const { impl, calls } = fakeFetch(json({ data: {} }));
    await new ShopifyClient(other, { fetchImpl: impl }).query("{ x }");
    assert.equal(calls[0].url, "https://other-shop.myshopify.com/admin/api/2026-04/graphql.json");
  });

  it("only ever sends queries, never mutations", () => {
    const documents: string[] = Object.values(queries);
    assert.equal(documents.length, 7);
    for (const document of documents) assert.doesNotMatch(document, /\bmutation\b/i);
  });

  it("asks for the order, customer, money, payment, shipment and line-item fields the CRM mapping needs", () => {
    for (const field of [
      "displayFinancialStatus", "displayFulfillmentStatus", "returnStatus", "cancelReason", "totalDiscountsSet", "totalTaxSet", "totalShippingPriceSet",
      "totalPriceSet", "totalRefundedSet", "lineItems", "variantTitle", "sku", "quantity", "originalUnitPriceSet", "discountAllocations", "taxLines",
      "product {", "variant {", "customer {", "shippingAddress", "zip", "transactions", "gateway", "kind", "parentTransaction", "fulfillments",
      "displayStatus", "trackingInfo", "paymentGatewayNames", "tags", "currencyCode", "createdAt", "updatedAt",
    ]) {
      assert.ok(queries.ORDER_BY_ID_QUERY.includes(field), `missing ${field}`);
    }
  });
});

// ---- authentication / header handling ----

describe("authentication header handling", () => {
  it("sends the token only in X-Shopify-Access-Token", async () => {
    const { impl, calls } = fakeFetch(json({ data: {} }));
    await new ShopifyClient(config(), { fetchImpl: impl }).query("{ x }");

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["X-Shopify-Access-Token"], TOKEN);
    assert.equal(headers.Authorization, undefined);
    assert.equal(calls[0].url.includes(TOKEN), false, "token must not be in the URL");
    assert.equal(String(calls[0].init.body).includes(TOKEN), false, "token must not be in the body");
  });

  it("keeps the token out of JSON.stringify, console.log and util.inspect of the config and client", () => {
    const cfg = config();
    const client = new ShopifyClient(cfg);
    for (const rendered of [JSON.stringify(cfg), inspect(cfg, { showHidden: false }), JSON.stringify(client), inspect(client, { depth: 5 })]) {
      assert.equal(rendered.includes(TOKEN), false);
    }
    assert.equal(cfg.accessToken, TOKEN, "the token is still usable by the client");
  });
});

// ---- response parsing ----

describe("response parsing", () => {
  it("normalizes a full order, including payments, shipments and address", () => {
    const order = normalizeOrder(orderNodeSchema.parse(codOrderNode({ fulfillments: [{ id: "gid://shopify/Fulfillment/1", status: "SUCCESS", displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "Shiprocket", number: "SR1", url: null }] }] })));
    assert.equal(order.id, "gid://shopify/Order/1000000000002");
    assert.equal(order.name, "#TST1002");
    assert.equal(order.financialStatus, "PENDING");
    assert.deepEqual(order.paymentGateways, ["Cash on Delivery (COD)"]);
    assert.deepEqual(order.amounts, { subtotal: "649.0", discount: "0.0", tax: "0.0", shipping: "50.0", total: "699.0", refunded: "0.0" });
    assert.equal(order.transactions[0].kind, "SALE");
    assert.equal(order.transactions[0].gateway, "Cash on Delivery (COD)");
    assert.equal(order.fulfillments[0].trackingNumber, "SR1");
    assert.equal(order.shippingAddress?.zip, "786125");
    assert.equal(order.customer.source, "customer");
    assert.equal(order.items[0].sku, "AW-HM-PN-60");
    assert.equal(order.items[0].variantId, "gid://shopify/ProductVariant/6001");
  });

  it("falls back to the order's own contact details for a guest checkout", () => {
    const order = normalizeOrder(orderNodeSchema.parse(orderNode({ customer: null, phone: "+911111111111" })));
    assert.equal(order.customer.id, null);
    assert.equal(order.customer.email, "asha.verma@example.com");
    assert.equal(order.customer.phone, "+911111111111");
    assert.equal(order.customer.source, "order");
  });

  it("copes with missing optional data", () => {
    const order = normalizeOrder(orderNodeSchema.parse(orderNode({
      customer: null, email: null, phone: null, shippingAddress: null, totalTaxSet: null, displayFulfillmentStatus: null, transactions: null, fulfillments: null,
      lineItems: { pageInfo: { hasNextPage: true }, nodes: [{ id: "x", title: "Custom item", quantity: 1, product: null, variant: null }] },
    })));
    assert.equal(order.customer.source, "none");
    assert.equal(order.shippingAddress, null);
    assert.equal(order.amounts.tax, null);
    assert.deepEqual(order.transactions, []);
    assert.equal(order.items[0].productId, null);
    assert.equal(order.itemsTruncated, true);
  });

  it("lists light order references for a page and asks for the requested number", async () => {
    const fake = shopifyFake({ orders: [orderNode(), orderNode({ id: "gid://shopify/Order/2" })] });
    const page = await listOrderRefs(new ShopifyClient(config(), { fetchImpl: fake.impl }), { first: 5, since: new Date("2026-09-01T00:00:00Z") });

    assert.equal(page.refs.length, 2);
    assert.equal(page.hasNextPage, false);
    const sent = JSON.parse(String(fake.calls[0].init.body)).variables;
    assert.equal(sent.first, 5);
    assert.equal(sent.query, "updated_at:>='2026-09-01T00:00:00.000Z'");
  });

  it("fetches one order in full by id, and returns null when Shopify no longer has it", async () => {
    const fake = shopifyFake({ orders: [orderNode()] });
    const client = new ShopifyClient(config(), { fetchImpl: fake.impl });
    assert.equal((await fetchOrder(client, "gid://shopify/Order/1000000000001"))?.name, "#TST1001");
    assert.equal(await fetchOrder(client, "gid://shopify/Order/999"), null);
  });

  it("reports an unexpected response shape by field path without echoing values", async () => {
    const fake = fakeFetch(json({ data: { order: orderNode({ name: 12345, email: "leaky-value@example.com" }) } }));
    await assert.rejects(fetchOrder(new ShopifyClient(config(), { fetchImpl: fake.impl }), "gid://shopify/Order/1"), (error: Error) => {
      assert.ok(error instanceof ShopifyApiError);
      assert.match(error.message, /order\.name/);
      assert.equal(error.message.includes("leaky-value"), false);
      return true;
    });
  });
});

// ---- GraphQL errors ----

describe("GraphQL errors", () => {
  const denied = {
    errors: [
      {
        message: "Access denied for orders field. Required access: `read_orders` access scope. Also: The user must have read_orders.",
        path: ["orders"],
        extensions: { code: "ACCESS_DENIED", requiredAccess: "`read_orders` access scope." },
      },
    ],
  };

  it("surfaces an access-denied error with the missing scope", async () => {
    const { impl } = fakeFetch(json(denied));
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl }).query("{ orders }"), (error: unknown) => {
      assert.ok(error instanceof ShopifyGraphQLError);
      assert.deepEqual(error.requiredScopes, ["read_orders"]);
      assert.equal(error.errors[0].code, "ACCESS_DENIED");
      assert.equal(error.errors[0].path, "orders");
      return true;
    });
  });

  it("does not retry an access-denied error", async () => {
    const { impl, calls } = fakeFetch(json(denied));
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl, sleep: noSleep }).query("{ orders }"));
    assert.equal(calls.length, 1);
  });

  it("retries a throttled query and then succeeds", async () => {
    const waits: number[] = [];
    const { impl, calls } = fakeFetch(json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }), json({ data: { ok: true } }));
    const data = await new ShopifyClient(config(), { fetchImpl: impl, sleep: async (ms) => void waits.push(ms) }).query<{ ok: boolean }>("{ x }");

    assert.deepEqual(data, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(waits.length, 1);
  });

  it("fails clearly when Shopify returns neither data nor errors", async () => {
    const { impl } = fakeFetch(json({}));
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl }).query("{ x }"), /no data/);
  });
});

// ---- HTTP failures and retries ----

describe("HTTP errors and retries", () => {
  it("explains a rejected token (401) and does not retry", async () => {
    const { impl, calls } = fakeFetch(new Response("nope", { status: 401 }));
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl, sleep: noSleep }).query("{ x }"), (error: unknown) => {
      assert.ok(error instanceof ShopifyApiError);
      assert.equal(error.status, 401);
      assert.match(error.message, /SHOPIFY_ACCESS_TOKEN/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("explains a wrong store domain or API version (404)", async () => {
    const { impl } = fakeFetch(new Response("", { status: 404 }));
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl }).query("{ x }"), /SHOPIFY_STORE_DOMAIN and SHOPIFY_API_VERSION/);
  });

  it("retries a 429, honouring Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const { impl, calls } = fakeFetch(new Response("", { status: 429, headers: { "Retry-After": "2" } }), json({ data: { ok: 1 } }));
    await new ShopifyClient(config(), { fetchImpl: impl, sleep: async (ms) => void waits.push(ms) }).query("{ x }");
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [2000]);
  });

  it("gives up after three attempts on a persistent 503", async () => {
    const { impl, calls } = fakeFetch(new Response("", { status: 503 }));
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl, sleep: noSleep }).query("{ x }"), /server error \(503\)/);
    assert.equal(calls.length, 3);
  });

  it("times out a request that never answers", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: hang, timeoutMs: 20 }).query("{ x }"), /did not respond within/);
  });

  it("rejects a response that is not JSON", async () => {
    const { impl } = fakeFetch(new Response("<html>oops</html>", { status: 200 }));
    await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl }).query("{ x }"), /not valid JSON/);
  });
});

// ---- environment configuration ----

describe("environment configuration", () => {
  it("names every missing required variable", () => {
    assert.throws(
      () => loadShopifyConfig({}),
      (error: unknown) => {
        assert.ok(error instanceof ShopifyConfigError);
        for (const name of ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_API_VERSION"]) assert.match(error.message, new RegExp(name));
        return true;
      },
    );
  });

  it("treats blank values as missing", () => {
    assert.throws(() => loadShopifyConfig({ ...ENV, SHOPIFY_ACCESS_TOKEN: "   " }), /SHOPIFY_ACCESS_TOKEN is not set/);
  });

  it("accepts the required variables, defaulting SHOPIFY_SYNC_ENABLED to false", () => {
    const cfg = loadShopifyConfig(ENV);
    assert.equal(cfg.storeDomain, "demo-store.myshopify.com");
    assert.equal(cfg.apiVersion, "2026-01");
    assert.equal(cfg.syncEnabled, false);
  });

  it("accepts a store domain that starts with digits", () => {
    assert.equal(loadShopifyConfig({ ...ENV, SHOPIFY_STORE_DOMAIN: "123456-ab.myshopify.com" }).storeDomain, "123456-ab.myshopify.com");
  });

  it("reads SHOPIFY_SYNC_ENABLED", () => {
    assert.equal(loadShopifyConfig({ ...ENV, SHOPIFY_SYNC_ENABLED: "true" }).syncEnabled, true);
    assert.throws(() => loadShopifyConfig({ ...ENV, SHOPIFY_SYNC_ENABLED: "yes" }), /SHOPIFY_SYNC_ENABLED/);
  });

  it("rejects a malformed domain or version without echoing what was supplied", () => {
    const secretish = "https://user:hunter2-secret@evil.example.com/path";
    for (const bad of [{ SHOPIFY_STORE_DOMAIN: secretish }, { SHOPIFY_STORE_DOMAIN: "example.com" }, { SHOPIFY_API_VERSION: "latest" }, { SHOPIFY_ACCESS_TOKEN: "has a space" }]) {
      assert.throws(
        () => loadShopifyConfig({ ...ENV, ...bad }),
        (error: Error) => {
          assert.ok(error instanceof ShopifyConfigError);
          assert.equal(error.message.includes("hunter2"), false);
          assert.equal(error.message.includes("has a space"), false);
          assert.equal(error.message.includes("evil.example.com"), false);
          return true;
        },
      );
    }
  });
});

// ---- errors never contain the token ----

describe("errors never contain the access token", () => {
  const scenarios: Array<[string, () => ReturnType<typeof fakeFetch>]> = [
    ["a 401", () => fakeFetch(new Response(`bad token ${TOKEN}`, { status: 401 }))],
    ["a 403", () => fakeFetch(new Response(`forbidden ${TOKEN}`, { status: 403 }))],
    ["a 500 after retries", () => fakeFetch(new Response(TOKEN, { status: 500 }))],
    ["a network failure whose message contains the token", () => fakeFetch(Object.assign(new TypeError(`fetch failed for ${TOKEN}`), { cause: { code: "ECONNREFUSED", message: TOKEN } }))],
    ["a GraphQL error that echoes the token", () => fakeFetch(json({ errors: [{ message: `Invalid token ${TOKEN} and shpat_ANOTHER99secret`, extensions: { code: "ACCESS_DENIED" } }] }))],
    ["an invalid JSON body", () => fakeFetch(new Response(TOKEN, { status: 200 }))],
  ];

  for (const [label, make] of scenarios) {
    it(`for ${label}`, async () => {
      const { impl } = make();
      await assert.rejects(new ShopifyClient(config(), { fetchImpl: impl, sleep: noSleep }).query("{ x }"), (error: unknown) => {
        const text = everything(error);
        assert.equal(text.includes(TOKEN), false, `token leaked: ${text}`);
        assert.equal(/shp(at|ca|pa|ss)_[A-Za-z0-9]+/.test(text), false, "a token-shaped string leaked");
        return true;
      });
    });
  }
});

// ---- command line ----

describe("command line", () => {
  it("defaults: a dry run reads 5, a real sync 50, orders only", () => {
    assert.deepEqual(parseCliArgs(["--dry-run"]), { limit: 5, since: null, only: ["orders"], force: false, dryRun: true });
    assert.deepEqual(parseCliArgs([]), { limit: 50, since: null, only: ["orders"], force: false, dryRun: false });
  });

  it("reads --limit, --all, --since, --only and --force", () => {
    assert.equal(parseCliArgs(["--limit", "100"]).limit, 100);
    assert.equal(parseCliArgs(["--all"]).limit, null);
    assert.equal(parseCliArgs(["--since", "2026-09-01"]).since?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(parseCliArgs(["--since", "2026-09-01T10:30:00Z"]).since?.toISOString(), "2026-09-01T10:30:00.000Z");
    assert.deepEqual(parseCliArgs(["--only", "products,orders,products"]).only, ["products", "orders"]);
    assert.equal(parseCliArgs(["--force"]).force, true);
  });

  it("rejects bad input", () => {
    for (const argv of [
      ["--limit", "0"], ["--limit", "1001"], ["--limit", "abc"], ["--dry-run", "--limit", "26"], ["--all", "--limit", "5"], ["--dry-run", "--all"],
      ["--dry-run", "--force"], ["--since", "yesterday"], ["--only", "orders,carts"], ["--only", ""], ["--sync"], ["orders"],
    ]) {
      assert.throws(() => parseCliArgs(argv), CliUsageError, argv.join(" "));
    }
  });
});

// ---- dry run ----

describe("dry run", () => {
  const ARGS = ["--dry-run", "--limit", "5"];
  const throwingRunner = () => Promise.reject(new Error("the database must not be opened by a dry run")) as Promise<TxRunner>;

  const run = async (fake: ReturnType<typeof shopifyFake>, argv = ARGS, env: Record<string, string | undefined> = ENV) => {
    const lines: string[] = [];
    let opened = 0;
    const code = await runCli({
      argv, env, print: (l) => lines.push(l), fetchImpl: fake.impl,
      getRunner: () => { opened++; return throwingRunner(); },
    });
    return { code, lines, text: lines.join("\n"), opened };
  };

  it("reads real-looking orders end to end, maps them, and reports Database writes: 0", async () => {
    const fake = shopifyFake({ orders: [orderNode(), codOrderNode()] });
    const { code, text, opened } = await run(fake);

    assert.equal(code, 0);
    assert.equal(opened, 0, "a dry run must never ask for a database");
    assert.match(text, /Shopify connection: PASS/);
    assert.match(text, /dry run \(nothing is written\)/);
    assert.match(text, /Store: demo-store\.myshopify\.com \(Demo Store\)/);
    assert.match(text, /API version: 2026-01/);
    assert.match(text, /Orders fetched: 2/);
    assert.match(text, /Database writes: 0/);
    assert.match(text, /Order: #TST1001\s+->\s+CRM order number SHP-TST1001/);
    assert.match(text, /CRM order status: CONFIRMED\s+Payment mode: COD/);
    assert.match(text, /CRM payments: PENDING\/COD 699\.0/);
    assert.match(text, /Payment mode: PREPAID/);
    assert.match(text, /Ship to pincode: 786125/);
  });

  it("only reads: one connection check, one reference list, then one fetch per order", async () => {
    const fake = shopifyFake({ orders: [orderNode(), codOrderNode()] });
    await run(fake);
    const names = fake.calls.map((c) => (JSON.parse(String(c.init.body)).query as string).match(/query (\w+)/)![1]);
    assert.deepEqual(names, ["ConnectionCheck", "OrderRefs", "OrderById", "OrderById"]);
  });

  it("does not treat zero orders as a failure", async () => {
    const { code, text } = await run(shopifyFake({ orders: [] }));
    assert.equal(code, 0);
    assert.match(text, /Orders fetched: 0/);
    assert.match(text, /authentication itself worked/);
  });

  it("stops with a clear message when the environment is incomplete, without contacting Shopify", async () => {
    const fake = shopifyFake();
    const { code, text } = await run(fake, ARGS, {});
    assert.equal(code, 1);
    assert.match(text, /SHOPIFY_ACCESS_TOKEN is not set/);
    assert.match(text, /Database writes: 0/);
    assert.equal(fake.calls.length, 0);
  });

  it("rejects bad options with usage and exit code 2, never contacting Shopify", async () => {
    const fake = shopifyFake();
    const { code, text } = await run(fake, ["--dry-run", "--limit", "999"]);
    assert.equal(code, 2);
    assert.match(text, /Usage:/);
    assert.equal(fake.calls.length, 0);
  });

  it("reports a rejected token as FAIL, safely", async () => {
    const rejected = fakeFetch(new Response(`Invalid ${TOKEN}`, { status: 401 }));
    const lines: string[] = [];
    const failed = await runCli({ argv: ARGS, env: ENV, print: (l) => lines.push(l), fetchImpl: rejected.impl });
    const out = lines.join("\n");
    assert.equal(failed, 1);
    assert.match(out, /Shopify connection: FAIL/);
    assert.match(out, /rejected the access token/);
    assert.match(out, /Database writes: 0/);
    assert.equal(out.includes(TOKEN), false);
  });

  it("names the missing scope when orders are denied, but still reports the connection as working", async () => {
    const denied = json({
      data: null,
      errors: [{ message: "Access denied for orders field. Required access: `read_orders` access scope.", path: ["orders"], extensions: { code: "ACCESS_DENIED" } }],
    });
    const fake = fakeFetch((call) => {
      const query = JSON.parse(String(call.init.body)).query as string;
      return query.includes("ConnectionCheck") ? json({ data: connectionData(["read_products"]) }) : denied;
    });
    const lines: string[] = [];
    const code = await runCli({ argv: ARGS, env: ENV, print: (l) => lines.push(l), fetchImpl: fake.impl });
    const text = lines.join("\n");

    assert.equal(code, 1);
    assert.match(text, /Shopify connection: PASS/);
    assert.match(text, /Missing scopes: read_orders, read_customers/);
    assert.match(text, /Result: FAIL/);
    assert.match(text, /Database writes: 0/);
  });

  it("refuses a real sync when no database is provided", async () => {
    const lines: string[] = [];
    const code = await runCli({ argv: ["--limit", "5"], env: ENV, print: (l) => lines.push(l), fetchImpl: shopifyFake().impl });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /No database is available/);
  });

  it("keeps database code out of everything the dry run uses", () => {
    const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".db-test.ts")).map((f) => join(dir, f));
    assert.ok(files.length >= 12);

    // Only the webhook wiring may open the database. Everything else takes a transaction from its caller,
    // and the CLI script loads Prisma lazily, only when a real sync asks for it.
    const mayImportDatabase = new Set(["shopify.webhook.routes.ts"]);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const name = file.split(/[\\/]/).pop()!;
      const runtimeImports = source.split("\n").filter((l) => /^\s*(import|export)\b(?!\s+type\b).*\bfrom\b/.test(l));
      for (const line of runtimeImports) {
        if (mayImportDatabase.has(name)) continue;
        assert.doesNotMatch(line, /lib\/prisma|@prisma\/client|adapter-neon|generated\/prisma\/client/i, `${name} imports a database client: ${line.trim()}`);
      }
    }

    const script = readFileSync(join(dir, "../../scripts/shopify-sync.ts"), "utf8");
    assert.doesNotMatch(script, /^\s*import\b.*prisma/im, "the script must not import Prisma at the top level");
    assert.match(script, /await import\("\.\.\/lib\/prisma\.js"\)/, "Prisma is loaded lazily");
  });
});

// ---- terminal output is safe ----

describe("terminal output is safe", () => {
  it("masks personal data and never prints the token", async () => {
    const lines: string[] = [];
    await runCli({ argv: ["--dry-run"], env: ENV, print: (l) => lines.push(l), fetchImpl: shopifyFake({ orders: [orderNode({ customer: { id: "gid://shopify/Customer/1", firstName: "Priya", lastName: "Sharma", email: "priya.sharma@gmail.com", phone: "+91 98765 43210" } })] }).impl });
    const text = lines.join("\n");

    assert.equal(text.includes(TOKEN), false);
    assert.equal(/shpat_/.test(text), false);
    assert.equal(text.includes("priya.sharma@gmail.com"), false, "raw email");
    assert.equal(text.includes("98765 43210"), false, "raw phone");
    assert.equal(text.includes("Sharma"), false, "full last name");
    assert.equal(text.includes("12 Park Road"), false, "street address");
    assert.match(text, /Customer: Priya S\./);
    assert.match(text, /Email: p\*\*\*@g\*\*\*\.com/);
    assert.match(text, /Phone: \*+10/);
    assert.equal(/authorization|x-shopify-access-token/i.test(text), false);
  });

  it("masks emails, phones and names", () => {
    assert.equal(maskEmail("priya.sharma@gmail.com"), "p***@g***.com");
    assert.equal(maskEmail("a@b.co.in"), "a***@b***.co.in");
    assert.equal(maskEmail("not-an-email"), "***");
    assert.equal(maskEmail(null), "-");
    assert.match(maskPhone("+91 98765 43210"), /^\*+10$/);
    assert.equal(maskPhone("12"), "***");
    assert.equal(maskPhone(null), "-");
    assert.equal(maskName("Priya", "Sharma"), "Priya S.");
    assert.equal(maskName("Priya", null), "Priya");
    assert.equal(maskName(null, null), "-");
  });
});

// ---- scope analysis ----

describe("scope analysis", () => {
  it("reports nothing missing when all three read scopes are granted", () => {
    const report = analyseScopes(["read_orders", "read_customers", "read_products"]);
    assert.deepEqual(report.missing, []);
    assert.equal(report.historicalOrders, false);
    assert.deepEqual(report.unneededWrite, []);
  });

  it("lists missing scopes, including ones Shopify named in an error", () => {
    assert.deepEqual(analyseScopes(["read_orders"]).missing.sort(), ["read_customers", "read_products"]);
    assert.deepEqual(analyseScopes(["read_orders", "read_customers", "read_products"], ["read_inventory"]).missing, ["read_inventory"]);
  });

  it("treats a write scope as also granting read, and flags write scopes as unneeded", () => {
    const report = analyseScopes(["write_orders", "read_customers", "read_products", "read_all_orders"]);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.unneededWrite, ["write_orders"]);
    assert.equal(report.historicalOrders, true);
  });
});

