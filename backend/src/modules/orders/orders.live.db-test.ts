// Database integration tests for the live-from-Shopify Orders list (orders.live.service.ts). Run
// with: npm run test:db. Every test runs inside ONE transaction that is always rolled back. No real
// Shopify call is ever made - the ShopifyClient is always the injected fake below (fetchImpl), never
// real credentials, matching orders.create.db-test.ts's own convention.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import OrdersLiveService from "./orders.live.service.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });
const ENV = { SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_faketoken", SHOPIFY_API_VERSION: "2026-01" };

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true },
  });
}

async function makeShopifyOrder(tx: Prisma.TransactionClient, leadId: string, externalId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return tx.order.create({
    data: { orderNumber: `SHP-${externalId}`, leadId, source: "SHOPIFY", status: "CONFIRMED", totalAmount: "699.00", externalSource: "SHOPIFY", externalId, ...overrides },
    select: { id: true },
  });
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const connectionBody = { data: { shop: { name: "Demo", myshopifyDomain: "demo-store.myshopify.com", currencyCode: "INR", ianaTimezone: "Asia/Kolkata" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } };

function orderListBody(nodes: Array<{ id: string; name: string; createdAt?: string; customerName?: string; lineItemCount?: number }>, pageInfo: Partial<{ hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }> = {}) {
  return {
    data: {
      orders: {
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, ...pageInfo },
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
          createdAt: n.createdAt ?? new Date().toISOString(),
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "FULFILLED",
          paymentGatewayNames: ["cod"],
          email: "shopper@example.invalid",
          phone: null,
          customer: n.customerName ? { firstName: n.customerName.split(" ")[0], lastName: n.customerName.split(" ")[1] ?? null, email: "shopper@example.invalid", phone: null } : null,
          totalPriceSet: { shopMoney: { amount: "699.00", currencyCode: "INR" } },
          lineItems: { nodes: Array.from({ length: n.lineItemCount ?? 1 }, (_, i) => ({ id: `gid://shopify/LineItem/${i}` })) },
        })),
      },
    },
  };
}

/** Fake Shopify: answers the connection check once, then the order-list query with the given responses. */
function fakeShopifyClient(...listResponses: unknown[]) {
  const calls: { url: string; body: unknown }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (typeof body.query === "string" && body.query.includes("ConnectionCheck")) return json(connectionBody);
    const response = listResponses[Math.min(n, listResponses.length - 1)];
    n++;
    return json(response);
  }) as unknown as typeof fetch;
  return { client: new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl }), calls };
}

function orderByIdBody(node: { id: string; name: string; fulfillmentTrackingNumber?: string | null; customerPhone?: string | null } | null) {
  if (!node) return { data: { order: null } };
  return {
    data: {
      order: {
        id: node.id,
        name: node.name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        processedAt: null,
        cancelledAt: null,
        cancelReason: null,
        currencyCode: "INR",
        displayFinancialStatus: "PAID",
        displayFulfillmentStatus: "FULFILLED",
        returnStatus: null,
        taxesIncluded: true,
        tags: [],
        paymentGatewayNames: ["cod"],
        discountCodes: [],
        email: "shopper@example.invalid",
        phone: null,
        customer: node.customerPhone ? { id: "gid://shopify/Customer/1", firstName: "Shopper", lastName: null, email: "shopper@example.invalid", phone: node.customerPhone } : null,
        shippingAddress: null,
        subtotalPriceSet: { shopMoney: { amount: "699.00", currencyCode: "INR" } },
        totalDiscountsSet: null,
        totalTaxSet: null,
        totalShippingPriceSet: null,
        totalPriceSet: { shopMoney: { amount: "699.00", currencyCode: "INR" } },
        totalRefundedSet: null,
        lineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
        transactions: [],
        fulfillments: node.fulfillmentTrackingNumber
          ? [{ id: "gid://shopify/Fulfillment/1", status: "SUCCESS", displayStatus: "DELIVERED", createdAt: new Date().toISOString(), deliveredAt: null, trackingInfo: [{ company: "Delhivery", number: node.fulfillmentTrackingNumber, url: null }] }]
          : [],
      },
    },
  };
}

/** Fake Shopify: answers OrderById (and ConnectionCheck) queries with the given response. */
function fakeShopifyDetailClient(orderBody: unknown) {
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (typeof body.query === "string" && body.query.includes("ConnectionCheck")) return json(connectionBody);
    return json(orderBody);
  }) as unknown as typeof fetch;
  return new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl });
}

describe("OrdersLiveService.getLiveOrderDetail", () => {
  it("ADMIN can view a Shopify order the CRM has not synced yet, by its numeric externalId", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const client = fakeShopifyDetailClient(orderByIdBody({ id: "gid://shopify/Order/555", name: "#4001" }));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderDetail(as(admin, Role.ADMIN), "555");
      assert.equal(result.error, undefined);
      assert.equal(result.order?.name, "#4001");
    });
  });

  it("a non-admin gets a not-found result, never the order data, for an unsynced Shopify order", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const client = fakeShopifyDetailClient(orderByIdBody({ id: "gid://shopify/Order/556", name: "#4002" }));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderDetail(as(rep, Role.SALESPERSON), "556");
      assert.equal(result.order, null);
      assert.ok(result.error);
    });
  });

  it("attaches live Shiprocket tracking for the order's Shopify-reported AWB", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const client = fakeShopifyDetailClient(orderByIdBody({ id: "gid://shopify/Order/557", name: "#4003", fulfillmentTrackingNumber: "AWB999" }));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderDetail(as(admin, Role.ADMIN), "557");
      assert.equal(result.order?.fulfillments[0]?.trackingNumber, "AWB999");
      assert.ok("AWB999" in result.liveTracking, "a tracking-number lookup must be attempted for every AWB Shopify reports");
    });
  });

  it("Shopify no longer has the order: reports a clear error, never throws", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const client = fakeShopifyDetailClient(orderByIdBody(null));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderDetail(as(admin, Role.ADMIN), "999999");
      assert.equal(result.order, null);
      assert.ok(result.error);
    });
  });

  it("links to the matching CRM lead when the Shopify customer's phone matches an existing Lead", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx, { firstName: "Priya", normalizedMobile: "+919999911111", mobile: "9999911111" });
      const client = fakeShopifyDetailClient(orderByIdBody({ id: "gid://shopify/Order/558", name: "#4004", customerPhone: "+919999911111" }));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderDetail(as(admin, Role.ADMIN), "558");
      assert.equal(result.crmLink?.leadId, lead.id);
    });
  });

  it("crmLink is null (never invented) when no CRM lead matches the Shopify customer's phone", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const client = fakeShopifyDetailClient(orderByIdBody({ id: "gid://shopify/Order/559", name: "#4005", customerPhone: "+919999922222" }));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderDetail(as(admin, Role.ADMIN), "559");
      assert.equal(result.crmLink, null);
    });
  });
});

describe("OrdersLiveService.getLiveOrderHistory", () => {
  it("returns the customer's other Shopify orders, excluding the current one, with a ready-to-navigate id", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const linkedExtId = `${Date.now()}a`;
      await makeShopifyOrder(tx, lead.id, linkedExtId);

      const { client } = fakeShopifyClient(orderListBody([
        { id: `gid://shopify/Order/999current`, name: "#CURRENT" },
        { id: `gid://shopify/Order/${linkedExtId}`, name: "#OLDLINKED" },
        { id: `gid://shopify/Order/notlinked1`, name: "#OLDUNLINKED" },
      ]));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderHistory(as(admin, Role.ADMIN), "1", "999current", { first: 10 });
      assert.equal(result.error, undefined);
      const numbers = result.items.map((i) => i.orderNumber);
      assert.ok(!numbers.includes("#CURRENT"), "the current order must be excluded from its own history");
      assert.equal(numbers.length, 2);

      const linked = result.items.find((i) => i.orderNumber === "#OLDLINKED");
      assert.equal(linked?.linkedInCrm, true);
      assert.equal(linked?.id, (await tx.order.findFirst({ where: { externalId: linkedExtId }, select: { id: true } }))!.id);

      const unlinked = result.items.find((i) => i.orderNumber === "#OLDUNLINKED");
      assert.equal(unlinked?.linkedInCrm, false);
      assert.equal(unlinked?.id, "shopify:notlinked1");
    });
  });

  it("a non-admin gets a not-found result, never the history data", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const { client } = fakeShopifyClient(orderListBody([]));

      const result = await new OrdersLiveService(tx, () => client).getLiveOrderHistory(as(rep, Role.SALESPERSON), "1", "current", { first: 10 });
      assert.equal(result.items.length, 0);
      assert.ok(result.error);
    });
  });

  it("Shopify unreachable: reports a clear error and an empty list, never throws", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const failing = new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch });

      const result = await new OrdersLiveService(tx, () => failing).getLiveOrderHistory(as(admin, Role.ADMIN), "1", "current", { first: 10 });
      assert.equal(result.items.length, 0);
      assert.ok(result.error);
    });
  });
});

describe("OrdersLiveService.listLiveOrders", () => {
  it("an unsynced Shopify order's item count comes from Shopify's own line items, never hardcoded to 0", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const extId = `${Date.now()}`;
      const { client } = fakeShopifyClient(orderListBody([{ id: `gid://shopify/Order/${extId}`, name: "#5001", lineItemCount: 3 }]));

      const result = await new OrdersLiveService(tx, () => client).listLiveOrders(as(admin, Role.ADMIN), { first: 25 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.linkedInCrm, false);
      assert.equal(result.items[0]!.itemCount, 3, "itemCount must reflect Shopify's real line-item count, not a hardcoded 0");
    });
  });

  it("joins the CRM's own Order/Lead row (already synced) onto the live Shopify page by externalId", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx, { firstName: "Aftab", lastName: null });
      const extId = `${Date.now()}`;
      await makeShopifyOrder(tx, lead.id, extId);

      const { client } = fakeShopifyClient(orderListBody([{ id: `gid://shopify/Order/${extId}`, name: "#1001", customerName: "Aftab" }]));
      const svc = new OrdersLiveService(tx, () => client);

      const result = await svc.listLiveOrders(as(admin, Role.ADMIN), { first: 25 });
      assert.equal(result.error, undefined);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.linkedInCrm, true);
      assert.equal(result.items[0]!.customer.leadId, lead.id);
      assert.equal(result.items[0]!.customer.name, "Aftab");
      assert.equal(result.items[0]!.orderNumber, "#1001");
    });
  });

  it("a Shopify order the CRM has not synced yet is shown to ADMIN only, flagged linkedInCrm: false", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const extId = `${Date.now()}`;
      const { client: adminClient } = fakeShopifyClient(orderListBody([{ id: `gid://shopify/Order/${extId}`, name: "#1002" }]));

      const adminResult = await new OrdersLiveService(tx, () => adminClient).listLiveOrders(as(admin, Role.ADMIN), { first: 25 });
      assert.equal(adminResult.items.length, 1);
      assert.equal(adminResult.items[0]!.linkedInCrm, false);
      assert.equal(adminResult.items[0]!.customer.leadId, null);

      const { client: repClient } = fakeShopifyClient(orderListBody([{ id: `gid://shopify/Order/${extId}`, name: "#1002" }]));
      const repResult = await new OrdersLiveService(tx, () => repClient).listLiveOrders(as(rep, Role.SALESPERSON), { first: 25 });
      assert.equal(repResult.items.length, 0, "an unsynced order is never shown to a non-admin, since there is no lead to check scope against");
    });
  });

  it("RBAC: a salesperson only sees Shopify orders linked to their own leads, never a colleague's", async () => {
    await inRollback(async (tx) => {
      const repA = await tx.user.create({ data: { name: "Rep A", email: `ra-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const repB = await tx.user.create({ data: { name: "Rep B", email: `rb-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const leadA = await makeLead(tx, { ownerId: repA.id });
      const leadB = await makeLead(tx, { ownerId: repB.id });
      const extA = `${Date.now()}a`;
      const extB = `${Date.now()}b`;
      await makeShopifyOrder(tx, leadA.id, extA);
      await makeShopifyOrder(tx, leadB.id, extB);

      const { client } = fakeShopifyClient(orderListBody([
        { id: `gid://shopify/Order/${extA}`, name: "#2001" },
        { id: `gid://shopify/Order/${extB}`, name: "#2002" },
      ]));

      const result = await new OrdersLiveService(tx, () => client).listLiveOrders(as(repA, Role.SALESPERSON), { first: 25 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.customer.leadId, leadA.id);
    });
  });

  it("Shopify unreachable: reports a clear error and an empty list, never throws", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const failing = new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch });
      const result = await new OrdersLiveService(tx, () => failing).listLiveOrders(as(admin, Role.ADMIN), { first: 25 });
      assert.equal(result.items.length, 0);
      assert.ok(result.error, "a reachability failure must be reported, not silently empty");
    });
  });

  it("caches a repeated identical query - Shopify is not called again within the TTL", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { client, calls } = fakeShopifyClient(orderListBody([{ id: "gid://shopify/Order/999", name: "#3001" }]));
      const svc = new OrdersLiveService(tx, () => client);

      const query = { first: 25, search: "cache-test-unique-marker" };
      const first = await svc.listLiveOrders(as(admin, Role.ADMIN), query);
      const callsAfterFirst = calls.length;
      const second = await svc.listLiveOrders(as(admin, Role.ADMIN), query);

      assert.deepEqual(second, first);
      assert.equal(calls.length, callsAfterFirst, "the second identical call must be served from cache, not hit Shopify again");
    });
  });

  it("does not cache across different users (RBAC-sensitive) or different search terms", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const marker = `distinct-${uid()}`;
      const { client, calls } = fakeShopifyClient(orderListBody([]), orderListBody([]));
      const svc = new OrdersLiveService(tx, () => client);

      await svc.listLiveOrders(as(admin, Role.ADMIN), { first: 25, search: marker });
      await svc.listLiveOrders(as(rep, Role.SALESPERSON), { first: 25, search: marker });
      // 1 connection check (cached after) + 2 distinct list queries = at least 2 "orders" calls.
      const listCalls = calls.filter((c) => typeof c.body === "object" && JSON.stringify(c.body).includes("OrderList"));
      assert.equal(listCalls.length, 2, "different users must never share a cached RBAC-sensitive page");
    });
  });

  it("passes the date window and free-text search through to Shopify's query string", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { client, calls } = fakeShopifyClient(orderListBody([]));
      const svc = new OrdersLiveService(tx, () => client);

      const dateFrom = new Date("2026-02-01T00:00:00.000Z");
      const dateTo = new Date("2026-02-28T23:59:59.999Z");
      await svc.listLiveOrders(as(admin, Role.ADMIN), { first: 25, dateFrom, dateTo, search: "aftab" });

      const listCall = calls.find((c) => typeof c.body === "object" && (c.body as any).variables?.query);
      const searchString: string = (listCall!.body as any).variables.query;
      assert.match(searchString, /created_at:>=/);
      assert.match(searchString, /created_at:</);
      assert.match(searchString, /aftab/);
    });
  });
});
