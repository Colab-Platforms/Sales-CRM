// Worker for the cross-process idempotency tests (orders.idempotency.xproc.db-test.ts). It is its OWN OS process with its OWN Prisma client and connection
// pool - exactly what a second backend server/worker is - and talks to a SHARED file-backed fake Shopify so the test can count how many Shopify orders
// were really created across processes. Never started by the application. Refuses to run unless the database is the isolated test database.
import fs from "node:fs";
import { prisma } from "../../lib/prisma.js";
import { ShopifyApiError, type ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "./orders.service.js";

interface Job {
  user: { id: string; username: string; role: string };
  /** "create" = createManualOrder, "push" = pushOrderToShopify(orderId) */
  action: "create" | "push";
  input?: Record<string, unknown>;
  orderId?: string;
  startAt: number;
  shopifyFile: string;
  /** ok | lost (Shopify creates the order but the answer never arrives) | slow (ok, 1.5s) */
  shopify: "ok" | "lost" | "slow";
  /** crash (exit without answering) right after the CRM order is committed, before the Shopify step */
  crashBeforeShopify?: boolean;
}

if (!/127\.0\.0\.1:5544\/crm_iso/.test(process.env.DATABASE_URL ?? "")) {
  console.log(JSON.stringify({ error: "GUARD: not the isolated test database" }));
  process.exit(3);
}
const job = JSON.parse(process.argv[2]!) as Job;

const read = () => (fs.existsSync(job.shopifyFile) ? fs.readFileSync(job.shopifyFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sourceIdentifier: string; id: string }) : []);
const shopify = {
  query: async (document: string, variables: Record<string, any>) => {
    if (/crmOrderBySource/.test(document)) {
      const ref = /source_identifier:"(.*)"/.exec(String(variables.query))?.[1];
      return { orders: { nodes: read().filter((o) => o.sourceIdentifier === ref).map((o) => ({ id: o.id, name: "#XP" })) } };
    }
    if (/orderCreate/.test(document)) {
      if (job.shopify === "slow") await new Promise((r) => setTimeout(r, 1500));
      const id = `gid://shopify/Order/${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      fs.appendFileSync(job.shopifyFile, JSON.stringify({ sourceIdentifier: variables.order.sourceIdentifier, id, pid: process.pid }) + "\n");
      if (job.shopify === "lost") throw new ShopifyApiError("Shopify did not respond (test: the answer was lost)");
      return { orderCreate: { order: { id, name: "#XP" }, userErrors: [] } };
    }
    return { order: { id: "gid://shopify/Order/1", tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
  },
} as unknown as ShopifyClient;

const service = new OrdersService(prisma as never, () => shopify);
if (job.crashBeforeShopify) {
  (service as any).pushOrderToShopify = async () => process.exit(9); // the process dies after the order is committed
}

const wait = job.startAt - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));
try {
  const user = job.user as never;
  if (job.action === "create") {
    const r = await service.createManualOrder(user, job.input as never);
    console.log(JSON.stringify({ ok: true, orderId: r.order.id, shopify: r.shopify.status }));
  } else {
    const r = await service.pushOrderToShopify(user, job.orderId!);
    console.log(JSON.stringify({ ok: true, shopify: r.status, reason: r.reason }));
  }
} catch (error: any) {
  console.log(JSON.stringify({ ok: false, status: error?.statusCode ?? null, message: String(error?.message ?? error).slice(0, 200) }));
}
await prisma.$disconnect();
process.exit(0);
