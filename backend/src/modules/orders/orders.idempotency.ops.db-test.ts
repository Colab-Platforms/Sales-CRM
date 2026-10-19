// Operational safety of the idempotency ledger: bounded retention, protection of anything still recoverable, Shopify-push lease expiry / takeover, restart recovery and
// concurrent retries. Every test runs in ONE transaction that is always rolled back (the cross-process proof is orders.idempotency.xproc.db-test.ts).
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyApiError, type ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "./orders.service.js";
import { idempotencyTuning } from "./orders.idempotency.js";
import { DEFAULT_PRUNE_BATCH, INTERRUPTED_RETENTION_DAYS, loadPruneConfig, MAX_PRUNE_BATCH, MIN_RETENTION_DAYS, pruneIdempotencyKeys } from "./orders.idempotency.prune.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const DAY = 86_400_000;
const NOW = new Date("2026-10-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const saved = { ...idempotencyTuning };
beforeEach(() => { idempotencyTuning.waitMs = 700; idempotencyTuning.replayWaitMs = 400; idempotencyTuning.pollMs = 50; });
afterEach(() => Object.assign(idempotencyTuning, saved));

/** A fake Shopify that records every orderCreate and answers lookups from what it created (like the real search by source identifier). */
function fakeShopify(opts: { mode?: "ok" | "lost" | "down" } = {}) {
  const created: { id: string; sourceIdentifier: string }[] = [];
  let mode = opts.mode ?? "ok";
  const client = {
    query: async (document: string, variables: Record<string, any>) => {
      if (/crmOrderBySource/.test(document)) {
        const ref = /source_identifier:"(.*)"/.exec(String(variables.query))?.[1];
        return { orders: { nodes: created.filter((c) => c.sourceIdentifier === ref).map((c) => ({ id: c.id, name: "#T" })) } };
      }
      if (/orderCreate/.test(document)) {
        if (mode === "down") throw new ShopifyApiError("Could not reach the store (test)");
        const id = `gid://shopify/Order/${uid().replace(/\D/g, "").slice(0, 10) || Date.now()}${created.length}`;
        created.push({ id, sourceIdentifier: variables.order.sourceIdentifier });
        if (mode === "lost") throw new ShopifyApiError("Shopify did not respond (test: answer lost)");
        return { orderCreate: { order: { id, name: "#T" }, userErrors: [] } };
      }
      return { order: { id: "gid://shopify/Order/1", tags: [] }, tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } };
    },
  } as unknown as ShopifyClient;
  return { client, created, setMode: (m: "ok" | "lost" | "down") => { mode = m; } };
}

async function world(tx: Prisma.TransactionClient, shop = fakeShopify()) {
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Ops", mobile: "9000000555", normalizedMobile: "+919000000555" }, select: { id: true } });
  const product = await tx.product.create({ data: { name: "Ops Tea", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "100.00" }, select: { id: true } });
  const orders = new OrdersService(tx as never, () => shop.client);
  const user = { id: admin.id, username: admin.username, role: Role.ADMIN };
  const input = (key: string, over: Record<string, unknown> = {}) => ({ leadId: lead.id, paymentMethod: "COD" as const, idempotencyKey: key, items: [{ productId: product.id, quantity: 1, unitPrice: "100.00" }], shippingAddress: { name: "Ops", line1: "1 Test St", city: "Pune", state: "Maharashtra", pincode: "411001", phone: "9000000555", houseNumber: "1 Test St", area: "Area" }, ...over });
  const row = (id: string) => tx.idempotencyKey.findFirstOrThrow({ where: { orderId: id } });
  return { admin, user, lead, product, orders, shop, input, row, tx };
}

/** Inserts a ledger row directly (so retention can be tested at exact ages). */
const ledger = (tx: Prisma.TransactionClient, userId: string, over: Partial<Prisma.IdempotencyKeyUncheckedCreateInput> & { age?: number }) => {
  const { age = 0, ...rest } = over;
  return tx.idempotencyKey.create({ data: { userId, operation: "ORDER_CREATE", key: `k-${uid()}`, requestHash: "h".repeat(64), status: "COMPLETED", createdAt: daysAgo(age), updatedAt: daysAgo(age), ...rest }, select: { id: true } });
};

describe("idempotency ledger retention", () => {
  it("configuration is OFF by default and bounded: hours opt-in, retention >= 2 days, batch <= 5000", () => {
    assert.equal(loadPruneConfig({}).everyHours, 0);
    assert.equal(loadPruneConfig({ IDEMPOTENCY_PRUNE_HOURS: "0" }).everyHours, 0);
    assert.equal(loadPruneConfig({ IDEMPOTENCY_PRUNE_HOURS: "abc" }).everyHours, 0);
    assert.equal(loadPruneConfig({ IDEMPOTENCY_PRUNE_HOURS: "24" }).everyHours, 24);
    assert.equal(loadPruneConfig({ IDEMPOTENCY_RETENTION_DAYS: "0" }).retentionDays, 30, "0 / invalid -> the default");
    assert.equal(loadPruneConfig({ IDEMPOTENCY_RETENTION_DAYS: "1" }).retentionDays, MIN_RETENTION_DAYS, "never below the minimum");
    assert.equal(loadPruneConfig({ IDEMPOTENCY_PRUNE_BATCH: "999999" }).batch, MAX_PRUNE_BATCH);
    assert.equal(loadPruneConfig({}).batch, DEFAULT_PRUNE_BATCH);
  });

  it("removes only FINISHED rows older than the retention, exactly at the boundary", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const old = await ledger(tx, w.admin.id, { age: 31 });
      const edge = await ledger(tx, w.admin.id, { age: 30.01 });
      const young = await ledger(tx, w.admin.id, { age: 29.9 });
      const fresh = await ledger(tx, w.admin.id, { age: 0 });
      const r = await pruneIdempotencyKeys(tx as never, { now: NOW, retentionDays: 30 });
      assert.equal(r.deleted, 2);
      const left = (await tx.idempotencyKey.findMany({ where: { id: { in: [old.id, edge.id, young.id, fresh.id] } }, select: { id: true } })).map((x) => x.id).sort();
      assert.deepEqual(left, [young.id, fresh.id].sort());
    });
  });

  it("IN-PROGRESS / interrupted rows are never removed while their order can still need reconciling (however old), and are removed once nothing is left to reconcile", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mk = async (key: string) => { const r = await w.orders.createManualOrder(w.user as never, w.input(key) as never); return r.order.id; };
      // two orders created, then their ledger rows made "interrupted" and ancient
      const unlinked = await mk(`ops-a-${uid()}`);
      const linked = await mk(`ops-b-${uid()}`);
      await tx.order.update({ where: { id: unlinked }, data: { externalId: null, externalNumber: null } });
      assert.ok((await tx.order.findUniqueOrThrow({ where: { id: linked }, select: { externalId: true } })).externalId, "the second order is linked to Shopify");
      const ancient = daysAgo(INTERRUPTED_RETENTION_DAYS + 200);
      await tx.idempotencyKey.updateMany({ where: { orderId: { in: [unlinked, linked] } }, data: { status: "ORDER_CREATED", createdAt: ancient, updatedAt: ancient } });
      const orphan = await ledger(tx, w.admin.id, { status: "ORDER_CREATED", orderId: uid(), age: INTERRUPTED_RETENTION_DAYS + 200 });
      const recent = await ledger(tx, w.admin.id, { status: "ORDER_CREATED", orderId: uid(), age: 5 });
      const r = await pruneIdempotencyKeys(tx as never, { now: new Date(), retentionDays: 30 });
      assert.equal(r.keptRecoverable, 1, "the unlinked order's row is kept");
      const left = new Set((await tx.idempotencyKey.findMany({ select: { orderId: true, id: true } })).map((x) => x.orderId ?? x.id));
      assert.ok(left.has(unlinked), "unlinked order: still protected");
      assert.ok(!left.has(linked), "already linked to Shopify: nothing to reconcile, removed");
      assert.ok(!(await tx.idempotencyKey.findUnique({ where: { id: orphan.id } })), "its order no longer exists: removed");
      assert.ok(await tx.idempotencyKey.findUnique({ where: { id: recent.id } }), "a recent interrupted row is never touched");
    });
  });

  it("a pass is BOUNDED by the batch size; the backlog is worked off over several passes", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (let i = 0; i < 7; i++) await ledger(tx, w.admin.id, { age: 40 });
      const a = await pruneIdempotencyKeys(tx as never, { now: NOW, retentionDays: 30, batch: 3 });
      assert.equal(a.deleted, 3);
      assert.equal(await tx.idempotencyKey.count({ where: { userId: w.admin.id } }), 4);
      await pruneIdempotencyKeys(tx as never, { now: NOW, retentionDays: 30, batch: 3 });
      await pruneIdempotencyKeys(tx as never, { now: NOW, retentionDays: 30, batch: 3 });
      assert.equal(await tx.idempotencyKey.count({ where: { userId: w.admin.id } }), 0);
    });
  });

  it("pruning never changes the answer for a key that is still retained: the same key still returns the original order", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `ops-keep-${uid()}`;
      const first = await w.orders.createManualOrder(w.user as never, w.input(key) as never);
      await pruneIdempotencyKeys(tx as never, { now: new Date(), retentionDays: 30 });
      const again = await w.orders.createManualOrder(w.user as never, w.input(key) as never);
      assert.equal(again.order.id, first.order.id);
      assert.equal(w.shop.created.length, 1);
    });
  });
});

describe("Shopify push lease: expiry, takeover, release", () => {
  const unlinkedOrder = async (w: Awaited<ReturnType<typeof world>>, key: string) => {
    w.shop.setMode("down");
    const r = await w.orders.createManualOrder(w.user as never, w.input(key) as never);
    w.shop.setMode("ok");
    return r.order.id;
  };
  const setClaim = (tx: Prisma.TransactionClient, orderId: string, ageSeconds: number) =>
    tx.$executeRaw`UPDATE orders SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{shopifyPushClaimedAt}', to_jsonb((now() - make_interval(secs => ${ageSeconds}))::text)) WHERE id = ${orderId}::uuid`;
  const meta = async (tx: Prisma.TransactionClient, id: string) => ((await tx.order.findUniqueOrThrow({ where: { id }, select: { metadata: true, externalId: true } })) as any);

  it("a LIVE claim (younger than the lease) blocks a second push, which gives up cleanly without creating anything; the holder's claim is untouched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const id = await unlinkedOrder(w, `ops-l1-${uid()}`);
      await setClaim(tx, id, 30);
      const before = w.shop.created.length;
      const r = await w.orders.pushOrderToShopify(w.user as never, id);
      assert.equal(r.status, "failed");
      assert.match(r.reason ?? "", /already running/);
      assert.equal(w.shop.created.length, before, "nothing created while another caller holds the claim");
      assert.ok((await meta(tx, id)).metadata.shopifyPushClaimedAt, "the other holder's claim is left in place");
    });
  });

  it("an EXPIRED claim (older than the lease) is taken over - and the takeover is treated as uncertain, so an order the dead holder already created in Shopify is FOUND, not duplicated", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      w.shop.setMode("lost"); // the dead holder had got Shopify to create the order, but never recorded it
      const first = await w.orders.createManualOrder(w.user as never, w.input(`ops-l2-${uid()}`) as never);
      w.shop.setMode("ok");
      assert.equal(w.shop.created.length, 1);
      const id = first.order.id;
      await tx.order.update({ where: { id }, data: { metadata: { ...(await meta(tx, id)).metadata, shopifyCreateUncertain: false } } }); // as if the holder died before flagging anything
      await setClaim(tx, id, idempotencyTuning.leaseSeconds + 60);
      const r = await w.orders.pushOrderToShopify(w.user as never, id);
      assert.ok(["created", "already_linked"].includes(r.status), JSON.stringify(r));
      assert.equal(w.shop.created.length, 1, "the order that already existed in Shopify was linked; no second one was created");
      const after = await meta(tx, id);
      assert.ok(after.externalId, "linked");
      assert.equal(after.metadata.shopifyPushClaimedAt, undefined, "the claim is released afterwards");
    });
  });

  it("the claim is RELEASED after a failure, so the very next retry can proceed immediately", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const id = await unlinkedOrder(w, `ops-l3-${uid()}`);
      assert.equal((await meta(tx, id)).metadata.shopifyPushClaimedAt, undefined);
      w.shop.setMode("down");
      assert.equal((await w.orders.pushOrderToShopify(w.user as never, id)).status, "failed");
      assert.equal((await meta(tx, id)).metadata.shopifyPushClaimedAt, undefined, "released even though the push failed");
      w.shop.setMode("ok");
      assert.equal((await w.orders.pushOrderToShopify(w.user as never, id)).status, "created");
    });
  });

  it("a claim older than the lease never lets a LINKED order be pushed again", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.orders.createManualOrder(w.user as never, w.input(`ops-l4-${uid()}`) as never);
      await setClaim(tx, r.order.id, 99_999);
      const again = await w.orders.pushOrderToShopify(w.user as never, r.order.id);
      assert.equal(again.status, "already_linked");
      assert.equal(w.shop.created.length, 1);
    });
  });
});

describe("restart recovery and concurrent retries", () => {
  it("restart recovery: a fresh service instance (new process) with the same key reconciles an order whose follow-ups never ran - one CRM order, one Shopify order", async () => {
    await inRollback(async (tx) => {
      const shop = fakeShopify({ mode: "down" });
      const w = await world(tx, shop);
      const key = `ops-r1-${uid()}`;
      const first = await w.orders.createManualOrder(w.user as never, w.input(key) as never);
      assert.equal(first.shopify.status, "failed");
      // simulate the crash: the follow-ups never completed
      await tx.idempotencyKey.updateMany({ where: { key }, data: { status: "ORDER_CREATED", result: undefined } });
      shop.setMode("ok");
      const restarted = new OrdersService(tx as never, () => shop.client); // a "new process": nothing in memory
      const retry = await restarted.createManualOrder(w.user as never, w.input(key) as never);
      assert.equal(retry.order.id, first.order.id);
      assert.equal(shop.created.length, 1);
      assert.equal((await w.row(first.order.id)).status, "COMPLETED");
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
    });
  });

  it("concurrent retries of an interrupted request finish it ONCE", async () => {
    await inRollback(async (tx) => {
      const shop = fakeShopify({ mode: "down" });
      const w = await world(tx, shop);
      const key = `ops-r2-${uid()}`;
      const first = await w.orders.createManualOrder(w.user as never, w.input(key) as never);
      await tx.idempotencyKey.updateMany({ where: { key }, data: { status: "ORDER_CREATED", result: undefined } });
      shop.setMode("ok");
      const retriers = [0, 1, 2, 3].map(() => new OrdersService(tx as never, () => shop.client).createManualOrder(w.user as never, w.input(key) as never));
      const results = await Promise.all(retriers);
      assert.equal(new Set(results.map((r) => r.order.id)).size, 1);
      assert.equal(results[0]!.order.id, first.order.id);
      assert.equal(shop.created.length, 1, "one Shopify order however many retries");
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
    });
  });

  it("same key + same payload returns the original result; a different payload is 422 - including after the row has been pruned-adjacent (still retained)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = `ops-r3-${uid()}`;
      const a = await w.orders.createManualOrder(w.user as never, w.input(key) as never);
      const b = await w.orders.createManualOrder(w.user as never, w.input(key) as never);
      assert.equal(a.order.id, b.order.id);
      await assert.rejects(() => w.orders.createManualOrder(w.user as never, w.input(key, { items: [{ productId: w.product.id, quantity: 2, unitPrice: "100.00" }] }) as never), (e: any) => e.statusCode === 422);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
    });
  });
});
