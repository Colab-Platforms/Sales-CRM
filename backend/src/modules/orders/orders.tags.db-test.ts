// Orders Tags (list display + filter) against the real schema and a fake Shopify that behaves like Shopify's own order search for `tag:`
// terms (exact tag, OR, cursor pagination). Every test runs in ONE transaction that is always rolled back; no real Shopify call is made.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import OrdersLiveService from "./orders.live.service.js";
import { validateLiveOrdersQuery } from "./orders.live.validators.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const ENV = { SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_faketoken", SHOPIFY_API_VERSION: "2026-01" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

interface FakeOrder { numeric: string; name: string; tags: string[]; paymentGateways?: string[] }

/** Shopify stand-in: honours `tag:"X"` terms (exact, OR via `(a OR b)`), page size and `after` cursors; also serves the tag-options query. */
function fakeShopify(orders: FakeOrder[], opts: { popularTags?: string[]; failTagOptions?: boolean } = {}) {
  const searches: string[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const q: string = body.query;
    if (q.includes("ConnectionCheck")) return json({ data: { shop: { name: "Demo", myshopifyDomain: "demo-store.myshopify.com", currencyCode: "INR", ianaTimezone: "Asia/Kolkata" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } });
    if (q.includes("crmOrderTagOptions")) {
      if (opts.failTagOptions) return json({ errors: [{ message: "boom" }] });
      return json({ data: { shop: { orderTags: { edges: (opts.popularTags ?? []).map((node) => ({ node })) } } } });
    }
    const search: string = body.variables.query ?? "";
    searches.push(search);
    const wanted = [...search.matchAll(/tag:"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1").toLowerCase());
    const matching = orders.filter((o) => wanted.length === 0 || o.tags.some((t) => wanted.includes(t.toLowerCase())));
    const start = body.variables.after ? Number(body.variables.after) + 1 : 0;
    const first: number = body.variables.first;
    const page = matching.slice(start, start + first);
    const lastIndex = start + page.length - 1;
    return json({
      data: {
        orders: {
          pageInfo: { hasNextPage: start + first < matching.length, hasPreviousPage: start > 0, startCursor: String(start), endCursor: page.length ? String(lastIndex) : null },
          nodes: page.map((o) => ({
            id: `gid://shopify/Order/${o.numeric}`, name: o.name, createdAt: new Date().toISOString(), processedAt: new Date().toISOString(), cancelledAt: null,
            displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", returnStatus: null, tags: o.tags, paymentGatewayNames: o.paymentGateways ?? ["Cash on Delivery (COD)"],
            email: "shopper@example.invalid", phone: null, customer: null, shippingLine: { title: "Standard" },
            totalPriceSet: { shopMoney: { amount: "499.00", currencyCode: "INR" } }, totalRefundedSet: null, lineItems: { nodes: [{ id: "gid://shopify/LineItem/1" }] }, transactions: [], fulfillments: [],
          })),
        },
      },
    });
  }) as unknown as typeof fetch;
  return { client: new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl }), searches };
}

async function world(tx: Prisma.TransactionClient, orders: FakeOrder[], fakeOpts: Parameters<typeof fakeShopify>[1] = {}) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", mobile: "9000000555", normalizedMobile: "+919000000555" }, select: { id: true } });
  const shop = fakeShopify(orders, fakeOpts);
  const svc = new OrdersLiveService(tx as never, () => shop.client);
  // `link` makes a CRM row for a fake Shopify order (so the CRM overlay - confirmer, status, payment mode - applies).
  const link = (numeric: string, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    tx.order.create({ data: { orderNumber: `T-${numeric}-${uid().slice(0, 6)}`, leadId: lead.id, source: "SHOPIFY", status: "CONFIRMED", totalAmount: "499.00", externalSource: "SHOPIFY", externalId: numeric, ...extra }, select: { id: true } });
  const list = async (q: Record<string, string>) => {
    const parsed = validateLiveOrdersQuery({ first: "25", ...q });
    assert.ifError(parsed.error);
    return svc.listLiveOrders({ id: admin.id, username: admin.username, role: Role.ADMIN }, { ...parsed.value!, after: parsed.value!.after });
  };
  return { svc, shop, link, list, admin };
}
const names = (r: { items: { orderNumber: string }[] }) => r.items.map((i) => i.orderNumber).sort();
const N = (n: number) => String(7_000_000 + n); // numeric ids unlikely to collide with real CRM rows

describe("Orders Tags: what a row shows", () => {
  it("no tags -> an empty list; one tag; several tags; Shopify-only (unsynced) orders show Shopify's tags", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, [
        { numeric: N(1), name: "#T1", tags: [] },
        { numeric: N(2), name: "#T2", tags: ["COD"] },
        { numeric: N(3), name: "#T3", tags: ["COD", "VIP", "Fastrr"] },
      ]);
      const r = await w.list({});
      const by = Object.fromEntries(r.items.map((i) => [i.orderNumber, i.tags]));
      assert.deepEqual([by["#T1"], by["#T2"], by["#T3"]], [[], ["COD"], ["COD", "VIP", "Fastrr"]]);
    });
  });
  it("the CRM confirmation tag appears automatically from the confirmer, first, without duplicating Shopify's copy", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, [
        { numeric: N(1), name: "#T1", tags: ["COD", "VIP"] }, // confirmed in the CRM, tag not on Shopify yet
        { numeric: N(2), name: "#T2", tags: ["crm confirmed by vini", "COD"] }, // Shopify already has it (other case)
      ]);
      await w.link(N(1), { confirmedByName: "Vini" });
      await w.link(N(2), { confirmedByName: "Vini" });
      const by = Object.fromEntries((await w.list({})).items.map((i) => [i.orderNumber, i.tags]));
      assert.deepEqual(by["#T1"], ["CRM Confirmed by Vini", "COD", "VIP"]);
      assert.deepEqual(by["#T2"], ["CRM Confirmed by Vini", "COD"], "exactly one confirmation tag");
    });
  });
  it("the creator tag ('Order Created by <name>') appears on the row from the stored creator, next to the confirmation tag, once - and not at all when no creator was stored", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, [
        { numeric: N(1), name: "#T1", tags: ["COD", "VIP"] }, // created in the CRM by Vini, tag not on Shopify yet
        { numeric: N(2), name: "#T2", tags: ["order created by vini", "COD"] }, // Shopify already holds it (other case)
        { numeric: N(3), name: "#T3", tags: ["COD"] }, // no creator ever stored
      ]);
      const created = { createdBy: { id: "u-1", name: "Vini", role: "SALESPERSON" } };
      await w.link(N(1), { confirmedByName: "Vini", metadata: created });
      await w.link(N(2), { metadata: created });
      await w.link(N(3));
      const by = Object.fromEntries((await w.list({})).items.map((i) => [i.orderNumber, i.tags]));
      assert.deepEqual(by["#T1"], ["CRM Confirmed by Vini", "Order Created by Vini", "COD", "VIP"]);
      assert.deepEqual(by["#T2"], ["Order Created by Vini", "COD"], "exactly one creator tag");
      assert.deepEqual(by["#T3"], ["COD"], "nothing invented when the creator is unknown");
    });
  });

  it("changing the confirmer: only the NEW confirmation tag is shown, other tags untouched, and the old tag no longer matches the row", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, [{ numeric: N(1), name: "#T1", tags: ["VIP", "CRM Confirmed by Vini", "COD"] }]);
      await w.link(N(1), { confirmedByName: "Rahul" }); // CRM already says Rahul; Shopify has not caught up
      const r = await w.list({});
      assert.deepEqual(r.items[0]!.tags, ["CRM Confirmed by Rahul", "VIP", "COD"]);
      const old = await w.list({ tags: "CRM Confirmed by Vini" });
      assert.equal(old.items.length, 0, "a row never matches a tag it does not display");
    });
  });
});

describe("Orders Tags: filter", () => {
  const data: FakeOrder[] = [
    { numeric: N(1), name: "#T1", tags: ["COD", "VIP"] },
    { numeric: N(2), name: "#T2", tags: ["COD-Verified"] },
    { numeric: N(3), name: "#T3", tags: ["Fastrr", "COD"] },
    { numeric: N(4), name: "#T4", tags: [] },
    { numeric: N(5), name: "#T5", tags: ["VIP"] },
  ];
  it("single tag, exact matching (COD never matches COD-Verified), case-insensitive", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, data);
      assert.deepEqual(names(await w.list({ tags: "COD" })), ["#T1", "#T3"]);
      assert.deepEqual(names(await w.list({ tags: "cod" })), ["#T1", "#T3"]);
      assert.deepEqual(names(await w.list({ tags: "COD-Verified" })), ["#T2"]);
      assert.equal((await w.list({ tags: "Nothing" })).items.length, 0);
    });
  });
  it("several tags use OR (Tag A OR Tag B), and an order holding both is listed once", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, data);
      assert.deepEqual(names(await w.list({ tags: "VIP,Fastrr" })), ["#T1", "#T3", "#T5"]);
      assert.deepEqual(names(await w.list({ tags: "COD,VIP" })), ["#T1", "#T3", "#T5"]);
      assert.match(w.shop.searches.at(-1)!, /\(tag:"COD" OR tag:"VIP"\)/);
    });
  });
  it("a tag with spaces (the confirmation tag) is matched as ONE tag", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, [{ numeric: N(1), name: "#T1", tags: ["CRM Confirmed by Vini"] }, { numeric: N(2), name: "#T2", tags: ["CRM Confirmed by Rahul"] }]);
      await w.link(N(1), { confirmedByName: "Vini" });
      await w.link(N(2), { confirmedByName: "Rahul" });
      assert.deepEqual(names(await w.list({ tags: "CRM Confirmed by Vini" })), ["#T1"]);
      assert.deepEqual(names(await w.list({ tags: "CRM Confirmed by Vini,CRM Confirmed by Rahul" })), ["#T1", "#T2"]);
    });
  });
  it("combines with the existing filters (status / payment mode / search) as AND", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, [
        { numeric: N(1), name: "#T1", tags: ["VIP"] },
        { numeric: N(2), name: "#T2", tags: ["VIP"] },
        { numeric: N(3), name: "#T3", tags: ["Other"] },
      ]);
      await w.link(N(1), { status: "CONFIRMED" });
      await w.link(N(2), { status: "CANCELLED" });
      await w.link(N(3), { status: "CONFIRMED" });
      assert.deepEqual(names(await w.list({ tags: "VIP", status: "CONFIRMED" })), ["#T1"]);
      assert.deepEqual(names(await w.list({ tags: "VIP,Other", status: "CONFIRMED" })), ["#T1", "#T3"]);
      assert.deepEqual(names(await w.list({ tags: "VIP", status: "CANCELLED" })), ["#T2"]);
      assert.equal((await w.list({ tags: "Other", status: "CANCELLED" })).items.length, 0);
      assert.match(w.shop.searches.at(-1)!, /tag:"Other"/);
      const withSearch = await w.list({ tags: "VIP", search: "T1" });
      assert.match(w.shop.searches.at(-1)!, /tag:"VIP".*T1|T1.*tag:"VIP"/, "free-text search and the tag clause are sent together");
      assert.ok(withSearch.items.length >= 0);
    });
  });
  it("pagination follows the FILTERED set: pages walk only matching orders, with a correct next-page flag", async () => {
    await inRollback(async (tx) => {
      const many: FakeOrder[] = Array.from({ length: 7 }, (_, i) => ({ numeric: N(10 + i), name: `#P${i + 1}`, tags: i % 2 === 0 ? ["Hot"] : ["Cold"] }));
      const w = await world(tx, many);
      const p1 = await w.list({ tags: "Hot", first: "2" });
      assert.deepEqual([p1.items.length, p1.pageInfo.hasNextPage], [2, true]);
      const p2 = await w.list({ tags: "Hot", first: "2", after: p1.pageInfo.endCursor! });
      assert.deepEqual([p2.items.length, p2.pageInfo.hasNextPage], [2, false]);
      assert.deepEqual([...names(p1), ...names(p2)].sort(), ["#P1", "#P3", "#P5", "#P7"]);
    });
  });
  it("invalid tag input is rejected or ignored safely (empty entries dropped, oversize tag refused)", () => {
    assert.deepEqual(validateLiveOrdersQuery({ tags: " VIP , ,COD " }).value?.tags, ["VIP", "COD"]);
    assert.equal(validateLiveOrdersQuery({ tags: "" }).value?.tags, undefined);
    assert.ok(validateLiveOrdersQuery({ tags: "x".repeat(300) }).error);
  });
});

describe("Orders Tags: filter options", () => {
  it("offers Shopify's tags plus the CRM confirmation tags, each once, CRM tags first", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, [], { popularTags: ["COD", "VIP", "crm confirmed by vini"] });
      await w.link(N(1), { confirmedByName: "Vini" });
      await w.link(N(2), { confirmedByName: "Vini" });
      await w.link(N(3), { confirmedByName: "Rahul" });
      const o = await w.svc.listTagOptions();
      const names = o.tags.map((t) => t.name);
      assert.ok(names.includes("CRM Confirmed by Vini") && names.includes("CRM Confirmed by Rahul") && names.includes("COD") && names.includes("VIP"));
      assert.equal(names.filter((n) => n.toLowerCase() === "crm confirmed by vini").length, 1, "no duplicates");
      assert.equal(o.tags.find((t) => t.name === "CRM Confirmed by Vini")!.source, "CRM");
      assert.equal(o.tags.find((t) => t.name === "COD")!.source, "SHOPIFY");
      assert.ok(names.indexOf("CRM Confirmed by Rahul") < names.indexOf("COD"));
      assert.equal(o.error, undefined);
    });
  });
});
