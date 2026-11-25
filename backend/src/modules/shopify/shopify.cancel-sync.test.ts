import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyShopifyCancellations, CANCEL_SKIPS, loadCancelSyncConfig, type CancelSyncDb } from "./shopify.cancel-sync.js";

type Row = { id: string; leadId: string; externalId: string | null; orderNumber: string; externalNumber: string | null; status: string; metadata: unknown; cancelledAt?: Date };

function fake(rows: Row[]) {
  const writes: { id: string; data: Record<string, any> }[] = [];
  const activities: Record<string, any>[] = [];
  const db = {
    order: {
      findMany: async (a: any) => {
        const wanted = new Set<string>(a.where.externalId.in);
        return rows.filter((r) => r.externalId && wanted.has(r.externalId)) as any;
      },
      updateMany: async (a: any) => {
        const r = rows.find((x) => x.id === a.where.id && x.status === a.where.status);
        if (!r) return { count: 0 };
        Object.assign(r, a.data);
        writes.push({ id: r.id, data: a.data });
        return { count: 1 };
      },
    },
    activity: { create: async (a: any) => void activities.push(a.data) },
  } as unknown as CancelSyncDb;
  return { db, writes, activities, rows };
}
const row = (n: number, status: string, over: Partial<Row> = {}): Row => ({ id: `o${n}`, leadId: `l${n}`, externalId: String(1000 + n), orderNumber: `CRM-${n}`, externalNumber: `#AW${n}`, status, metadata: { createdBy: "x", discount: { code: "A" } }, ...over });
const shop = (n: number, at = "2026-11-22T08:55:53Z") => ({ externalId: String(1000 + n), cancelledAt: at });
const NOW = () => new Date("2026-11-22T09:00:00Z");

describe("Shopify cancellation -> CRM order status", () => {
  it("a CRM order that Shopify cancelled and the CRM still holds as CONFIRMED becomes CANCELLED, with the cancel time, the previous status kept and an activity recorded", async () => {
    const f = fake([row(1, "CONFIRMED")]);
    const r = await applyShopifyCancellations(f.db, [shop(1)], { now: NOW });
    assert.deepEqual([r.shopifyCancelled, r.cancelled, r.alreadyCancelled, r.notInCrm], [1, 1, 0, 0]);
    const o = f.rows[0]!;
    assert.equal(o.status, "CANCELLED");
    assert.equal(o.cancelledAt?.toISOString(), "2026-11-22T08:55:53.000Z", "Shopify's own cancel time");
    const m = o.metadata as any;
    assert.equal(m.preCancelStatus, "CONFIRMED", "the CRM's own undo-cancellation can restore it");
    assert.equal(m.shopifyCancelSync.previousStatus, "CONFIRMED");
    assert.deepEqual([m.createdBy, m.discount.code], ["x", "A"], "other CRM metadata is kept");
    assert.equal(f.activities.length, 1);
    assert.deepEqual([f.activities[0]!.type, f.activities[0]!.orderId, f.activities[0]!.oldValue.status], ["ORDER_CANCELLED", "o1", "CONFIRMED"]);
  });

  it("every live status is cancelled (PENDING_PAYMENT, PROCESSING, SHIPPED ...); CANCELLED / RETURNED / REFUNDED are left exactly as they are", async () => {
    const live = ["PENDING_PAYMENT", "CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
    const f = fake([...live.map((s, i) => row(i + 1, s)), row(20, "CANCELLED"), row(21, "RETURNED"), row(22, "REFUNDED")]);
    const r = await applyShopifyCancellations(f.db, [...live.map((_, i) => shop(i + 1)), shop(20), shop(21), shop(22)], { now: NOW });
    assert.deepEqual([r.cancelled, r.alreadyCancelled], [6, 1]);
    assert.deepEqual(f.rows.slice(0, 6).map((x) => x.status), Array(6).fill("CANCELLED"));
    assert.deepEqual(f.rows.slice(6).map((x) => x.status), ["CANCELLED", "RETURNED", "REFUNDED"]);
    assert.equal(f.writes.length, 6);
    assert.deepEqual(CANCEL_SKIPS.sort(), ["CANCELLED", "REFUNDED", "RETURNED"]);
  });

  it("a website order the CRM does not hold is ignored: nothing is imported or created", async () => {
    const f = fake([row(1, "CONFIRMED")]);
    const r = await applyShopifyCancellations(f.db, [shop(1), shop(99)], { now: NOW });
    assert.deepEqual([r.cancelled, r.notInCrm], [1, 1]);
    assert.equal(f.rows.length, 1);
  });

  it("running it again changes nothing (idempotent), and never writes a second activity", async () => {
    const f = fake([row(1, "CONFIRMED")]);
    await applyShopifyCancellations(f.db, [shop(1)], { now: NOW });
    const again = await applyShopifyCancellations(f.db, [shop(1)], { now: NOW });
    assert.deepEqual([again.cancelled, again.alreadyCancelled], [0, 1]);
    assert.equal(f.writes.length, 1);
    assert.equal(f.activities.length, 1);
  });

  it("a dry run reports the order numbers and writes nothing", async () => {
    const f = fake([row(1, "CONFIRMED"), row(2, "CANCELLED")]);
    const r = await applyShopifyCancellations(f.db, [shop(1), shop(2)], { dryRun: true, now: NOW });
    assert.deepEqual([r.cancelled, r.alreadyCancelled, r.orderNumbers], [1, 1, ["CRM-1"]]);
    assert.deepEqual([f.rows[0]!.status, f.writes.length, f.activities.length], ["CONFIRMED", 0, 0]);
  });

  it("if the CRM cancelled the order between the read and the write, nothing is overwritten and no activity is added", async () => {
    const f = fake([row(1, "CONFIRMED")]);
    const original = f.db.order.findMany;
    f.db.order.findMany = async (a: unknown) => {
      const out = await original(a);
      f.rows[0]!.status = "CANCELLED"; // another process cancels it right after we read it
      return out.map((x) => ({ ...x, status: "CONFIRMED" as never }));
    };
    const r = await applyShopifyCancellations(f.db, [shop(1)], { now: NOW });
    assert.deepEqual([r.cancelled, f.writes.length, f.activities.length], [0, 0, 0]);
  });

  it("an existing preCancelStatus (from a CRM cancellation that was undone) is not overwritten", async () => {
    const f = fake([row(1, "PROCESSING", { metadata: { preCancelStatus: "CONFIRMED" } })]);
    await applyShopifyCancellations(f.db, [shop(1)], { now: NOW });
    assert.equal((f.rows[0]!.metadata as any).preCancelStatus, "CONFIRMED");
  });

  it("the legacy GID form of the id is found too", async () => {
    const f = fake([row(1, "CONFIRMED", { externalId: "gid://shopify/Order/1001" })]);
    const r = await applyShopifyCancellations(f.db, [shop(1)], { now: NOW });
    assert.equal(r.cancelled, 1);
  });
});

describe("cancel sync configuration", () => {
  it("is on by default (15 min, 6 h look-back: short, so a deploy never rewrites old history) and off with 0", () => {
    assert.deepEqual(loadCancelSyncConfig({}), { intervalMinutes: 15, lookbackHours: 6 });
    assert.equal(loadCancelSyncConfig({ SHOPIFY_CANCEL_SYNC_POLL_MINUTES: "0" }), null);
    assert.deepEqual(loadCancelSyncConfig({ SHOPIFY_CANCEL_SYNC_POLL_MINUTES: "5", SHOPIFY_CANCEL_SYNC_LOOKBACK_HOURS: "99999" }), { intervalMinutes: 5, lookbackHours: 336 });
    assert.deepEqual(loadCancelSyncConfig({ SHOPIFY_CANCEL_SYNC_POLL_MINUTES: "abc" }), { intervalMinutes: 15, lookbackHours: 6 });
  });
});
