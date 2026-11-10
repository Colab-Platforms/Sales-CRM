// Database tests: reconciliation of existing Shiprocket orders with their Shopify orders. Run with: npm run test:db  (ISOLATED database only)
// Each test runs in one transaction that is rolled back. Shopify and Shiprocket are never contacted: the only Shiprocket stand-in is a READ-ONLY search function, so creating, updating or cancelling
// a Shiprocket order is impossible here by construction.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { formatReconcileReport, reconcileShiprocketOrders } from "./shiprocket.reconcile.js";
import { readShiprocketSync } from "./shiprocket.sync-record.js";
import { processShiprocketEvent } from "./shiprocket.webhook.processor.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";
import type { ShiprocketOrderLookup } from "./shiprocket.client.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try { await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 }); } catch (error) { if (!(error instanceof Rollback)) throw error; }
}
after(() => prisma.$disconnect());
const uid = () => randomUUID();

async function seed(tx: Prisma.TransactionClient) {
  const user = await tx.user.create({ data: { name: "T", username: `u-${uid()}`, role: Role.SALESPERSON }, select: { id: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Rahul", lastName: "V", mobile: "9876500000", normalizedMobile: "+919876500000", ownerId: user.id }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "P", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "449.00" }, select: { id: true } });
  let n = 0;
  type Opts = { source?: "SALESPERSON" | "SHOPIFY"; shopify?: boolean; ref?: "crm" | "shopify" | string; providerOrderId?: string | null; shipmentId?: string | null; awb?: string | null; syncRecord?: Record<string, unknown> };
  const order = async (o: Opts = {}) => {
    n++;
    const number = `CRM-RC${n}-${uid().slice(0, 4)}`;
    const shopifyName = `#AWL2000${n}`;
    const row = await tx.order.create({
      data: {
        orderNumber: number, leadId: lead.id, status: "CONFIRMED", source: o.source ?? "SALESPERSON", currency: "INR", subtotal: "449.00", totalAmount: "449.00",
        ...(o.shopify === false ? {} : { externalSource: "SHOPIFY" as const, externalId: `${7000 + n}`, externalNumber: shopifyName }),
        metadata: (o.syncRecord ? { shiprocketSync: o.syncRecord } : {}) as never,
        items: { create: [{ productNameSnapshot: "P", quantity: 1, unitPrice: "449.00", totalPrice: "449.00", productId: product.id }] },
      },
      select: { id: true, orderNumber: true, externalNumber: true },
    });
    return { ...row, shopifyBare: shopifyName.slice(1) };
  };
  const shipment = (orderId: string, o: { ref: string | null; providerOrderId?: string | null; externalId?: string | null; awb?: string | null; status?: "CREATED" | "AWB_ASSIGNED" | "IN_TRANSIT"; metadata?: Record<string, unknown> }) =>
    tx.shipment.create({
      data: {
        orderId, externalSource: "SHIPROCKET", status: o.status ?? "AWB_ASSIGNED", externalId: o.externalId === undefined ? `SRS-${uid().slice(0, 6)}` : o.externalId, providerOrderId: o.providerOrderId === undefined ? `SR-${uid().slice(0, 6)}` : o.providerOrderId,
        channelOrderId: o.ref, trackingNumber: o.awb === undefined ? `AWB-${uid().slice(0, 6)}` : o.awb, courier: "Delhivery", trackingUrl: "https://track.example/AWB", providerStatus: "PICKUP SCHEDULED", metadata: (o.metadata ?? { shiprocket: { created: true } }) as never,
      },
      select: { id: true, externalId: true, providerOrderId: true, trackingNumber: true },
    });
  return { tx, order, shipment, lead };
}

const snapshot = async (tx: Prisma.TransactionClient, ids: string[]) => JSON.stringify({
  orders: await tx.order.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } }),
  shipments: await tx.shipment.findMany({ where: { orderId: { in: ids } }, orderBy: { id: "asc" } }),
});

describe("reconciliation of existing Shiprocket orders", () => {
  it("dry run reports every category and changes nothing; apply writes only the verified mapping, leaving the shipment untouched; a second apply is a no-op", async () => {
    await inRollback(async (tx) => {
      const w = await seed(tx);
      const a = await w.order(); const sa = await w.shipment(a.id, { ref: a.orderNumber });                                  // CRM reference -> needs mapping
      const b = await w.order(); const sb = await w.shipment(b.id, { ref: b.shopifyBare });                                 // Shiprocket already shows the Shopify number, mapping missing
      const done = await w.order({ syncRecord: {} }); const sd = await w.shipment(done.id, { ref: done.shopifyBare });
      await tx.shipment.update({ where: { id: sd.id }, data: { metadata: { shiprocket: { created: true, shopifyOrderId: `${7003}`, shopifyOrderName: "#AWL20003", crmOrderNumber: done.orderNumber } } } });
      await tx.$executeRaw`UPDATE orders SET metadata = jsonb_build_object('shiprocketSync', jsonb_build_object('status','SYNCED','crmOrderNumber', ${done.orderNumber}::text, 'shopifyOrderId', external_id, 'shopifyOrderName', external_number, 'shiprocketOrderId', ${sd.providerOrderId}::text)) WHERE id = ${done.id}::uuid`;
      const dup = await w.order(); await w.shipment(dup.id, { ref: dup.orderNumber }); await w.shipment(dup.id, { ref: `${dup.orderNumber}-x2` });   // two live shipments
      const pend = await w.order(); await w.shipment(pend.id, { ref: pend.orderNumber, externalId: "pending:abc", providerOrderId: null });         // never answered
      const odd = await w.order(); await w.shipment(odd.id, { ref: `${odd.orderNumber}X` });                                                     // similar, not equal
      const fromShopify = await w.order({ source: "SHOPIFY" }); await w.shipment(fromShopify.id, { ref: fromShopify.orderNumber });               // Shopify-originated: never touched
      const noShopify = await w.order({ shopify: false }); await w.shipment(noShopify.id, { ref: noShopify.orderNumber });                       // not linked to Shopify: out of scope
      const ids = [a, b, done, dup, pend, odd, fromShopify, noShopify].map((o) => o.id);
      const mine = (r: Awaited<ReturnType<typeof reconcileShiprocketOrders>>) => r.rows.filter((x) => ids.includes(x.orderId));

      const before = await snapshot(tx, ids);
      const dry = await reconcileShiprocketOrders(tx as never, {});
      assert.equal(dry.dryRun, true);
      assert.equal(await snapshot(tx, ids), before, "a dry run writes nothing");
      const state = Object.fromEntries(mine(dry).map((x) => [x.crmOrderNumber, x.state]));
      assert.equal(state[a.orderNumber], "NEEDS_MAPPING");
      assert.equal(state[b.orderNumber], "NEEDS_MAPPING");
      assert.equal(state[done.orderNumber], "ALREADY_CORRECT");
      assert.equal(state[dup.orderNumber], "DUPLICATE");
      assert.equal(state[pend.orderNumber], "UNMATCHED");
      assert.equal(state[odd.orderNumber], "UNMATCHED", "a similar-looking reference is never matched");
      assert.equal(state[fromShopify.orderNumber], undefined, "a Shopify-originated order is not examined");
      assert.equal(state[noShopify.orderNumber], undefined);
      assert.equal(mine(dry).find((x) => x.orderId === a.id)!.referenceUnchanged, true, "the CRM reference is still what Shiprocket shows");
      assert.equal(mine(dry).find((x) => x.orderId === b.id)!.referenceUnchanged, false);
      assert.match(formatReconcileReport(dry), /DRY RUN/);
      if (process.env.SHOW_RECONCILE_REPORT) console.log(formatReconcileReport(dry));

      const shipBefore = await tx.shipment.findUniqueOrThrow({ where: { id: sa.id } });
      const orderBefore = await tx.order.findUniqueOrThrow({ where: { id: a.id } });
      const applied = await reconcileShiprocketOrders(tx as never, { apply: true });
      assert.equal(mine(applied).filter((x) => x.applied).length, 2, "exactly the two verified matches were written");

      const shipAfter = await tx.shipment.findUniqueOrThrow({ where: { id: sa.id } });
      const { metadata: mBefore, updatedAt: _u1, ...restBefore } = shipBefore as Record<string, unknown>;
      const { metadata: mAfter, updatedAt: _u2, ...restAfter } = shipAfter as Record<string, unknown>;
      assert.deepEqual(restAfter, restBefore, "AWB, courier, tracking URL, status, provider status, Shiprocket ids and the Shiprocket reference are unchanged");
      const sm = (mAfter as { shiprocket: Record<string, string> }).shiprocket;
      assert.deepEqual([sm.crmOrderNumber, sm.shopifyOrderId, sm.shopifyOrderName, sm.shiprocketReference, sm.created as unknown], [a.orderNumber, `${7001}`, a.externalNumber, a.orderNumber, true]);
      const orderAfter = await tx.order.findUniqueOrThrow({ where: { id: a.id } });
      assert.deepEqual({ ...orderAfter, metadata: null, updatedAt: null }, { ...orderBefore, metadata: null, updatedAt: null }, "the order itself (status, amounts, payment) is unchanged");
      const rec = readShiprocketSync(orderAfter.metadata)!;
      assert.deepEqual([rec.crmOrderNumber, rec.shopifyOrderId, rec.shopifyOrderName, rec.shiprocketOrderId], [a.orderNumber, "7001", a.externalNumber, sa.providerOrderId]);

      // duplicate / unmatched / out-of-scope orders were not written
      for (const o of [dup, pend, odd, fromShopify, noShopify]) {
        const m = (await tx.order.findUniqueOrThrow({ where: { id: o.id }, select: { metadata: true } })).metadata as Record<string, unknown> | null;
        assert.equal(readShiprocketSync(m)?.shopifyOrderId ?? null, null);
      }
      // running it again changes nothing and reports the two as complete
      const afterApply = await snapshot(tx, ids);
      const again = await reconcileShiprocketOrders(tx as never, { apply: true });
      assert.equal(mine(again).filter((x) => x.applied).length, 0);
      assert.equal(await snapshot(tx, ids), afterApply);
      assert.equal(mine(again).find((x) => x.orderId === a.id)!.state, "ALREADY_CORRECT");
      void sb;
    });
  });

  it("with Shiprocket asked read-only: a confirmation is required, a different AWB or an unknown order is unmatched, and a second live order for the same sale is reported as a duplicate (never touched)", async () => {
    await inRollback(async (tx) => {
      const w = await seed(tx);
      const ok = await w.order(); const sOk = await w.shipment(ok.id, { ref: ok.orderNumber });
      const wrongAwb = await w.order(); await w.shipment(wrongAwb.id, { ref: wrongAwb.orderNumber });
      const unknown = await w.order(); await w.shipment(unknown.id, { ref: unknown.orderNumber });
      const twin = await w.order(); const sTwin = await w.shipment(twin.id, { ref: twin.orderNumber });
      const ids = [ok, wrongAwb, unknown, twin].map((o) => o.id);
      const rowsOf = await tx.shipment.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, providerOrderId: true, trackingNumber: true, channelOrderId: true } });
      const of = (orderId: string) => rowsOf.find((r) => r.orderId === orderId)!;
      const searches: string[] = [];
      const entry = (ref: string, id: string, awb: string | null, status = "NEW"): ShiprocketOrderLookup => ({ shiprocketOrderId: id, channelOrderId: ref, status, paymentMethod: "COD", totalCents: 44900, awb, courier: null });
      const lookup = async (id: string) => {
        searches.push(id);
        const bare = id.toLowerCase();
        return [
          entry(ok.orderNumber, of(ok.id).providerOrderId!, of(ok.id).trackingNumber),
          entry(wrongAwb.orderNumber, of(wrongAwb.id).providerOrderId!, "SOME-OTHER-AWB"),
          entry(twin.orderNumber, of(twin.id).providerOrderId!, of(twin.id).trackingNumber),
          entry(twin.shopifyBare, "SR-IMPORTED-1", null),   // the order Shiprocket's Shopify channel imported for the same sale
        ].filter((e) => e.channelOrderId.toLowerCase() === bare);
      };
      const before = await snapshot(tx, ids);
      const report = await reconcileShiprocketOrders(tx as never, { lookup });
      const st = Object.fromEntries(report.rows.filter((r) => ids.includes(r.orderId)).map((r) => [r.crmOrderNumber, r]));
      assert.equal(st[ok.orderNumber]!.state, "NEEDS_MAPPING");
      assert.equal(st[wrongAwb.orderNumber]!.state, "UNMATCHED");
      assert.match(st[wrongAwb.orderNumber]!.reason, /different AWB/);
      assert.equal(st[unknown.orderNumber]!.state, "UNMATCHED");
      assert.equal(st[twin.orderNumber]!.state, "DUPLICATE");
      assert.match(st[twin.orderNumber]!.reason, /SR-IMPORTED-1/);
      assert.ok(searches.length > 0);
      assert.equal(await snapshot(tx, ids), before, "nothing changed in the dry run");
      const applied = await reconcileShiprocketOrders(tx as never, { lookup, apply: true });
      assert.equal(applied.rows.filter((r) => ids.includes(r.orderId) && r.applied).length, 1, "only the confirmed match was written");
      void sOk; void sTwin;
    });
  });

  it("after reconciliation, tracking webhooks (carrying the CRM reference or the Shopify number) still update the same CRM order's one shipment and create none", async () => {
    await inRollback(async (tx) => {
      const w = await seed(tx);
      const o = await w.order(); const s = await w.shipment(o.id, { ref: o.orderNumber, awb: "AWB-100" });
      await reconcileShiprocketOrders(tx as never, { apply: true });
      const events = new Map<string, { payload: unknown; attempts: number; done: boolean }>();
      const store: WebhookStore = {
        record: async (e) => { events.set(e.externalEventId, { payload: e.payload, attempts: 0, done: false }); return { id: e.externalEventId, duplicate: false }; },
        claim: async (id) => { const e = events.get(id)!; if (e.done) return null; e.attempts++; return { id, payload: e.payload, attempts: e.attempts } as never; },
        complete: async (id) => { events.get(id)!.done = true; }, fail: async () => undefined, due: async () => [],
      };
      const runner = { $transaction: async <T,>(cb: (t: never) => Promise<T>) => cb(tx as never) } as never;
      const deliver = async (id: string, payload: Record<string, unknown>) => { await store.record({ eventType: "tracking", externalEventId: id, payload }); return processShiprocketEvent(id, { store, runner }); };

      assert.equal(await deliver("t1", { order_id: o.orderNumber, awb: "AWB-100", current_status: "IN TRANSIT" }), "processed");
      assert.equal(await deliver("t2", { order_id: o.shopifyBare, current_status: "OUT FOR DELIVERY" }), "processed");
      assert.equal(await deliver("t3", { awb: "AWB-100", current_status: "DELIVERED" }), "processed");
      const ships = await tx.shipment.findMany({ where: { orderId: o.id }, select: { id: true, status: true, trackingNumber: true, channelOrderId: true } });
      assert.equal(ships.length, 1);
      assert.deepEqual([ships[0]!.id, ships[0]!.status, ships[0]!.trackingNumber, ships[0]!.channelOrderId], [s.id ?? ships[0]!.id, "DELIVERED", "AWB-100", o.orderNumber]);
      const rec = readShiprocketSync((await tx.order.findUniqueOrThrow({ where: { id: o.id }, select: { metadata: true } })).metadata)!;
      assert.equal(rec.shopifyOrderName, o.externalNumber, "the mapping survives the tracking updates");
    });
  });
});
