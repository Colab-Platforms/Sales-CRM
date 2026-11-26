// The count and download against the real database queries (fake Shopify; everything inside one rolled-back transaction). Run with: npm run test:db
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { OrdersLiveBulkService } from "./orders.live.bulk.js";

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

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Orders count and download with real CRM queries", () => {
  it("filters on CRM details, resolves selected CRM ids (numeric and GID external ids) and names the filters in the file", async () => {
    await inRollback(async (tx) => {
      const seller = await tx.user.create({ data: { username: `bulk-${randomUUID()}`, name: "Bulk Seller", passwordHash: "x", role: Role.SALESPERSON } as never, select: { id: true } });
      const source = await tx.source.create({ data: { name: `Bulk source ${randomUUID()}` } as never, select: { id: true } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${randomUUID()}`, firstName: "Bulk", lastName: "Buyer", mobile: "9876500001", normalizedMobile: "+919876500001", ownerId: seller.id, sourceId: source.id }, select: { id: true } });
      const base = Math.floor(Math.random() * 1e9) + 7e12;
      const external = [base + 1, base + 2, base + 3].map(String); // the third is never synced into the CRM
      const make = (externalId: string, status: "CONFIRMED" | "CANCELLED") =>
        tx.order.create({ data: { orderNumber: `SHP-${externalId}`, leadId: lead.id, source: "SHOPIFY", status, totalAmount: "699.00", externalSource: "SHOPIFY", externalId }, select: { id: true } });
      const confirmed = await make(external[0]!, "CONFIRMED");
      const cancelled = await make(`gid://shopify/Order/${external[1]}`, "CANCELLED");

      const nodes = external.map((id, i) => ({
        id: `gid://shopify/Order/${id}`, name: `#B${i + 1}`, createdAt: `2026-10-0${i + 1}T10:00:00Z`, displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", tags: [], paymentGatewayNames: ["cod"],
        totalPriceSet: { shopMoney: { amount: "699.00", currencyCode: "INR" } }, lineItems: { nodes: [] }, transactions: [], fulfillments: [],
      }));
      const fetchImpl = (async (_url: string, init: { body: string }) => {
        const { query } = JSON.parse(init.body);
        if (query.includes("ConnectionCheck")) return json({ data: { shop: { name: "D", myshopifyDomain: "d.myshopify.com", currencyCode: "INR", ianaTimezone: "Asia/Kolkata" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } });
        if (query.includes("query Count")) return json({ data: { result: { count: nodes.length, precision: "EXACT" } } });
        return json({ data: { orders: { pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, edges: nodes.map((n) => ({ cursor: n.name })), nodes } } });
      }) as unknown as typeof fetch;
      const client = () => new ShopifyClient(loadShopifyConfig({ SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_faketoken", SHOPIFY_API_VERSION: "2026-01" }), { fetchImpl });
      const service = new OrdersLiveBulkService({ db: tx, getShopifyClient: client });
      const admin = { id: seller.id, username: "a", role: Role.ADMIN } as never;

      const filters = { salespersonId: [seller.id], leadSourceId: [source.id], status: ["CONFIRMED" as const, "CANCELLED" as const] };
      assert.deepEqual(await service.count(admin, filters), { status: "ready", total: 2 });
      assert.deepEqual(await service.count(admin, { ...filters, status: ["CANCELLED" as const] }), { status: "ready", total: 1 });

      const read = async (buffer: Buffer) => {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer as never);
        const column = (name: string) => (wb.getWorksheet(name)!.getColumn(1).values as unknown[]).slice(2).map(String);
        const summary = Object.fromEntries((wb.getWorksheet("Summary")!.getSheetValues() as unknown[][]).slice(2).filter(Boolean).map((r) => [r[1], r[2]]));
        return { ids: column("Orders"), summary };
      };
      const filtered = await service.exportFiltered(admin, filters);
      assert.ok(filtered.status === "ready");
      const f = await read(filtered.buffer);
      assert.deepEqual([...f.ids].sort(), ["#B1", "#B2"]);
      assert.equal(f.summary["Salesperson"], "Bulk Seller");
      assert.match(String(f.summary["Lead source"]), /^Bulk source/);

      const selected = await service.exportSelected(admin, [confirmed.id, cancelled.id, `shopify:${external[2]}`, randomUUID()]);
      assert.ok(selected.status === "ready");
      assert.deepEqual([selected.rows, selected.missing], [3, 1]);
      assert.deepEqual((await read(selected.buffer)).ids, ["#B3", "#B2", "#B1"]);

      assert.equal((await tx.order.count({ where: { leadId: lead.id } })), 2, "nothing was written");
    });
  });
});
