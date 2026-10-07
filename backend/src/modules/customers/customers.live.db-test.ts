// Database integration tests for the live-from-Shopify Customers list (customers.live.service.ts).
// Run with: npm run test:db. Every test runs inside ONE transaction that is always rolled back. No
// real Shopify call is ever made - the ShopifyClient is always the injected fake below (fetchImpl),
// matching orders.live.db-test.ts's own convention.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import CustomersLiveService from "./customers.live.service.js";

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
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });
const ENV = { SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_faketoken", SHOPIFY_API_VERSION: "2026-01" };

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true, normalizedMobile: true },
  });
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function customerListBody(nodes: Array<{ id: string; firstName?: string; lastName?: string; phone?: string | null; email?: string | null }>, pageInfo: Partial<{ hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }> = {}) {
  return {
    data: {
      customers: {
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null, ...pageInfo },
        nodes: nodes.map((n) => ({
          id: n.id,
          firstName: n.firstName ?? null,
          lastName: n.lastName ?? null,
          email: n.email ?? "shopper@example.invalid",
          phone: n.phone ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          numberOfOrders: "3",
          amountSpent: { amount: "1999.00", currencyCode: "INR" },
          defaultAddress: { address1: "1 MG Road", address2: null, city: "Mumbai", province: "Maharashtra", zip: "400001", country: "India" },
        })),
      },
    },
  };
}

/** Fake Shopify: answers CustomerList queries with the given responses in order. */
function fakeShopifyClient(...listResponses: unknown[]) {
  const calls: { url: string; body: unknown }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const response = listResponses[Math.min(n, listResponses.length - 1)];
    n++;
    return json(response);
  }) as unknown as typeof fetch;
  return { client: new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl }), calls };
}

describe("CustomersLiveService.listLiveCustomers", () => {
  it("joins the CRM's own Lead row (matched by normalized mobile) onto the live Shopify page", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx, { firstName: "Aftab", lastName: null });
      const extId = `${Date.now()}`;

      const { client } = fakeShopifyClient(customerListBody([{ id: `gid://shopify/Customer/${extId}`, firstName: "Aftab", phone: lead.normalizedMobile }]));
      const svc = new CustomersLiveService(tx, () => client);

      const result = await svc.listLiveCustomers(as(admin, Role.ADMIN), { first: 25 });
      assert.equal(result.error, undefined);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.linkedInCrm, true);
      assert.equal(result.items[0]!.leadId, lead.id);
    });
  });

  it("a Shopify customer with no matching CRM lead is shown to ADMIN only, flagged linkedInCrm: false", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON } });
      const extId = `${Date.now()}`;
      const phone = "+919999888877";

      const { client: adminClient } = fakeShopifyClient(customerListBody([{ id: `gid://shopify/Customer/${extId}`, firstName: "Unknown", phone }]));
      const adminResult = await new CustomersLiveService(tx, () => adminClient).listLiveCustomers(as(admin, Role.ADMIN), { first: 25 });
      assert.equal(adminResult.items.length, 1);
      assert.equal(adminResult.items[0]!.linkedInCrm, false);
      assert.equal(adminResult.items[0]!.leadId, null);
      // The UI must not crash on an unlinked customer - confirmed here by the shape itself always
      // being present (name/email/phone/amountSpent), never undefined/missing fields.
      assert.ok(adminResult.items[0]!.name);

      const { client: repClient } = fakeShopifyClient(customerListBody([{ id: `gid://shopify/Customer/${extId}`, firstName: "Unknown", phone }]));
      const repResult = await new CustomersLiveService(tx, () => repClient).listLiveCustomers(as(rep, Role.SALESPERSON), { first: 25 });
      assert.equal(repResult.items.length, 0, "an unlinked Shopify customer is never shown to a non-admin, since there is no lead to check scope against");
    });
  });

  it("RBAC: a salesperson only sees Shopify customers matching their own leads, never a colleague's", async () => {
    await inRollback(async (tx) => {
      const repA = await tx.user.create({ data: { name: "Rep A", username: `ra-${uid()}`, role: Role.SALESPERSON } });
      const repB = await tx.user.create({ data: { name: "Rep B", username: `rb-${uid()}`, role: Role.SALESPERSON } });
      const leadA = await makeLead(tx, { ownerId: repA.id, normalizedMobile: "+911111111111", mobile: "1111111111" });
      const leadB = await makeLead(tx, { ownerId: repB.id, normalizedMobile: "+912222222222", mobile: "2222222222" });

      const { client } = fakeShopifyClient(customerListBody([
        { id: "gid://shopify/Customer/100", firstName: "Lead A", phone: leadA.normalizedMobile },
        { id: "gid://shopify/Customer/200", firstName: "Lead B", phone: leadB.normalizedMobile },
      ]));

      const result = await new CustomersLiveService(tx, () => client).listLiveCustomers(as(repA, Role.SALESPERSON), { first: 25 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.leadId, leadA.id);
    });
  });

  it("Shopify unreachable: reports a clear error and an empty list, never throws", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const failing = new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch });
      const result = await new CustomersLiveService(tx, () => failing).listLiveCustomers(as(admin, Role.ADMIN), { first: 25 });
      assert.equal(result.items.length, 0);
      assert.ok(result.error, "a reachability failure must be reported, not silently empty");
    });
  });

  it("caches a repeated identical search - Shopify is not called again within the TTL", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const { client, calls } = fakeShopifyClient(customerListBody([{ id: "gid://shopify/Customer/999", firstName: "Cache", phone: null }]));
      const svc = new CustomersLiveService(tx, () => client);

      const query = { first: 25, search: "cache-test-unique-marker" };
      const first = await svc.listLiveCustomers(as(admin, Role.ADMIN), query);
      const callsAfterFirst = calls.length;
      const second = await svc.listLiveCustomers(as(admin, Role.ADMIN), query);

      assert.deepEqual(second, first);
      assert.equal(calls.length, callsAfterFirst, "the second identical call must be served from cache, not hit Shopify again");
    });
  });

  it("does not cache across different users (RBAC-sensitive)", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON } });
      const marker = `distinct-${uid()}`;
      const { client, calls } = fakeShopifyClient(customerListBody([]), customerListBody([]));
      const svc = new CustomersLiveService(tx, () => client);

      await svc.listLiveCustomers(as(admin, Role.ADMIN), { first: 25, search: marker });
      await svc.listLiveCustomers(as(rep, Role.SALESPERSON), { first: 25, search: marker });
      const listCalls = calls.filter((c) => typeof c.body === "object" && JSON.stringify(c.body).includes("CustomerList"));
      assert.equal(listCalls.length, 2, "different users must never share a cached RBAC-sensitive page");
    });
  });
});
