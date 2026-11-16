// Payment sync for a Shopify order that was CREATED paid (isolated DB only, one rolled-back transaction, Shopify mocked): no second payment call, repeatable, and an order that is NOT created-paid
// still takes the original mark-as-paid path. Run through run-iso.ps1.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Db } from "../integrations/integrations.common.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { syncShopifyPayment } from "./cashfree.payment-success.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
before(async () => {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("select current_database()::text as db");
  if (db !== "crm_iso") throw new Error(`GUARD: only against crm_iso (got ${db})`);
});
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const state = (o: { status: string; total: string; outstanding: string; received: string }) => ({ order: { id: "gid://shopify/Order/777", displayFinancialStatus: o.status, cancelledAt: null, currentTotalPriceSet: { shopMoney: { amount: o.total } }, totalOutstandingSet: { shopMoney: { amount: o.outstanding } }, totalReceivedSet: { shopMoney: { amount: o.received } } } });
function fake(read: () => unknown) {
  const calls: string[] = [];
  const client = { query: async (doc: string) => { const isPay = /orderMarkAsPaid/.test(doc); calls.push(isPay ? "markAsPaid" : "read"); return isPay ? { orderMarkAsPaid: { order: { id: "gid://shopify/Order/777", displayFinancialStatus: "PAID" }, userErrors: [] } } : read(); } } as unknown as ShopifyClient;
  return { client, calls };
}
async function order(tx: Db, meta: Record<string, unknown>) {
  const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "T", ownerId: rep.id } });
  const o = await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.SALESPERSON, status: OrderStatus.CONFIRMED, subtotal: "1249.00", totalAmount: "1249.00", externalSource: "SHOPIFY", externalId: "gid://shopify/Order/777", metadata: { paymentMode: "PREPAID", ...meta } as never } });
  await tx.payment.create({ data: { orderId: o.id, status: PaymentStatus.SUCCESS, method: PaymentMethod.OTHER, provider: "MANUAL", amount: "1249.00" } });
  return o;
}

describe("syncShopifyPayment for an order created paid", () => {
  it("records it as synced with NO payment call, and a repeat does nothing", async () => {
    await inRollback(async (tx) => {
      const f = fake(() => state({ status: "PAID", total: "1249.00", outstanding: "0.00", received: "1249.00" }));
      const o = await order(tx, { shopifyPaidAtCreation: { at: new Date().toISOString(), amount: "1249.00" }, shopifyTotals: { mirrored: true, total: "1249" } });
      const r = await syncShopifyPayment(tx, o.id, { source: ActivitySource.USER, getShopifyClient: () => f.client });
      assert.equal(r.status, "synced");
      assert.ok(!f.calls.includes("markAsPaid"), "no second payment is recorded in Shopify");
      const meta = (await tx.order.findUniqueOrThrow({ where: { id: o.id }, select: { metadata: true } })).metadata as Record<string, any>;
      assert.deepEqual([meta.shopifyPaymentSync.status, meta.shopifyPaymentSync.performed, meta.paymentMode], ["synced", "already_paid_at_creation", "PREPAID"]);
      const again = await syncShopifyPayment(tx, o.id, { source: ActivitySource.USER, getShopifyClient: () => f.client });
      assert.equal(again.status, "synced");
      assert.ok(!f.calls.includes("markAsPaid"));
    });
  });

  it("if Shopify does NOT show it fully paid, the normal mark-as-paid path still runs (nothing is assumed paid)", async () => {
    await inRollback(async (tx) => {
      const f = fake(() => state({ status: "PENDING", total: "1249.00", outstanding: "1249.00", received: "0.00" }));
      const o = await order(tx, { shopifyPaidAtCreation: { at: new Date().toISOString(), amount: "1249.00" }, shopifyTotals: { mirrored: true, total: "1249" } });
      await syncShopifyPayment(tx, o.id, { source: ActivitySource.USER, getShopifyClient: () => f.client });
      assert.ok(f.calls.includes("markAsPaid"));
    });
  });

  it("an order NOT created paid never triggers the extra read - the original path is unchanged", async () => {
    await inRollback(async (tx) => {
      const f = fake(() => state({ status: "PENDING", total: "1249.00", outstanding: "1249.00", received: "0.00" }));
      const o = await order(tx, {});
      await syncShopifyPayment(tx, o.id, { source: ActivitySource.USER, getShopifyClient: () => f.client });
      assert.deepEqual(f.calls.filter((c) => c === "markAsPaid"), ["markAsPaid"]);
    });
  });
});
