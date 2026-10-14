// Fastrr abandon-cart ingestion reliability against the real schema: a slow/failed save is retried and never lost, auto-assignment can no longer fail a save, dead events are recovered
// by a bounded pass that never assigns, older events never overwrite newer ones, and the health numbers reconcile. Every test runs in ONE transaction that is always rolled back.
// All payloads are SYNTHETIC fixtures shaped like live deliveries.
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role, WebhookStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { ABANDONMENT_MAX_ATTEMPTS, ASSIGN_TX_OPTIONS, SAVE_TX_OPTIONS, abandonmentBackoffMs, processAbandonmentEvent } from "./shiprocket.abandonment.processor.js";
import { reconcileFailedAbandonmentEvents } from "./shiprocket.abandonment.reconcile.js";
import { handleAbandonmentWebhook } from "./shiprocket.abandonment.webhook.handler.js";
import { ingestionMetrics } from "./shiprocket.abandonment.metrics.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { getIngestionStatus } from "../abandonment/abandonment.ingestion-status.js";
import AbandonmentService from "../abandonment/abandonment.service.js";

class Rollback extends Error {}
type Db = Prisma.TransactionClient;
async function inRollback(fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());
beforeEach(() => ingestionMetrics.reset());

const uid = () => randomUUID();
const PROVIDER = "SHIPROCKET_CHECKOUT";
const istStamp = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 23); // the provider's own shape: ISO, IST wall time, no zone
const cart = (over: Record<string, unknown> = {}, at = new Date()) => ({
  cart_id: `cart-${uid()}`, phone_number: `9${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`, email: null, first_name: "Test", last_name: "Cart", total_price: "999", currency: "INR",
  source_name: "fastrr", latest_stage: "ORDER_SCREEN", created_at: istStamp(at), updated_at: istStamp(at),
  items: [{ product_id: "1", variant_id: "2", sku: "S", name: "Item", price: "999", quantity: 1 }],
  shipping_address: { first_name: "Test", address1: "1 Test Rd", city: "Pune", state: "MH", zip: "411001", phone: "9000000000" }, ...over,
});

/** A runner over the test transaction that records the options every $transaction was given, and can be told to fail specific calls (like Prisma's "expired transaction"). */
function runnerOver(tx: Db, behaviour: { failCalls?: Set<number> } = {}) {
  const calls: { timeout?: number; maxWait?: number }[] = [];
  let n = 0;
  return {
    calls,
    $transaction: async <T,>(fn: (t: Db) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T> => {
      n += 1;
      calls.push(options ?? {});
      if (behaviour.failCalls?.has(n)) throw new Error("Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5400 ms passed since the start of the transaction.");
      return fn(tx);
    },
  };
}

async function world(tx: Db, behaviour: { failCalls?: Set<number> } = {}) {
  const store = createPrismaWebhookStore(tx, PROVIDER, { maxAttempts: ABANDONMENT_MAX_ATTEMPTS });
  const runner = runnerOver(tx, behaviour);
  const deliver = async (payload: unknown, opts: { receivedAt?: Date } = {}) => {
    const { id } = await store.record({ eventType: "checkout.abandoned", externalEventId: uid(), payload });
    if (opts.receivedAt) await tx.webhookEvent.update({ where: { id }, data: { receivedAt: opts.receivedAt } });
    return id;
  };
  const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid().slice(0, 8)}`, role: Role.ADMIN } });
  const mgr = await tx.user.create({ data: { name: "Mgr", username: `m-${uid().slice(0, 8)}`, role: Role.MANAGER } });
  const enableManagerAutoAssign = async () => {
    await tx.managerAutoAssignConfig.deleteMany();
    await tx.managerAutoAssignTarget.deleteMany();
    await tx.managerAutoAssignConfig.create({ data: { enabled: true } });
    await tx.managerAutoAssignTarget.create({ data: { managerId: mgr.id } });
  };
  const event = (id: string) => tx.webhookEvent.findUniqueOrThrow({ where: { id }, select: { status: true, attempts: true, nextAttemptAt: true, errorMessage: true, processedAt: true } });
  const abandonments = (cartId: string) => tx.abandonment.findMany({ where: { referenceId: cartId }, select: { id: true, leadId: true, detectedAt: true, cartSnapshot: true, lead: { select: { assignedManagerId: true, ownerId: true } } } });
  return { tx, store, runner, deliver, admin, mgr, enableManagerAutoAssign, event, abandonments };
}

describe("the save: explicit timeout, auto-assignment separated", () => {
  it("saves a delivery with an explicit 30 s transaction timeout (not Prisma's 5 s default) and runs auto-assignment as its OWN, second transaction", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = cart();
      const id = await w.deliver(c);
      assert.equal(await processAbandonmentEvent(id, { store: w.store, runner: w.runner as never }), "processed");
      assert.deepEqual(w.runner.calls, [SAVE_TX_OPTIONS, ASSIGN_TX_OPTIONS]);
      assert.ok(SAVE_TX_OPTIONS.timeout >= 30_000 && SAVE_TX_OPTIONS.timeout > 5_000);
      assert.equal((await w.event(id)).status, WebhookStatus.PROCESSED);
      assert.equal((await w.abandonments(c.cart_id as string)).length, 1);
    });
  });

  it("a normal new checkout is still auto-assigned to the opted-in manager (behaviour preserved)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.enableManagerAutoAssign();
      const c = cart();
      await processAbandonmentEvent(await w.deliver(c), { store: w.store, runner: w.runner as never });
      const [a] = await w.abandonments(c.cart_id as string);
      assert.equal(a!.lead.assignedManagerId, w.mgr.id);
    });
  });

  it("a FAILED or timed-out auto-assignment can no longer fail the save: the event is PROCESSED, the abandonment is kept, the lead is simply unassigned", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { failCalls: new Set([2]) }); // the 2nd transaction (assignment) dies
      await w.enableManagerAutoAssign();
      const c = cart();
      const id = await w.deliver(c);
      assert.equal(await processAbandonmentEvent(id, { store: w.store, runner: w.runner as never }), "processed");
      assert.equal((await w.event(id)).status, WebhookStatus.PROCESSED);
      const [a] = await w.abandonments(c.cart_id as string);
      assert.ok(a, "the checkout was saved");
      assert.equal(a!.lead.assignedManagerId, null, "unassigned - visible on the distribution dashboard");
      assert.equal(ingestionMetrics.snapshot().counters.autoAssignFailed, 1);
    });
  });
});

describe("failed saves are retried durably and never lost", () => {
  it("a save that times out leaves the event FAILED with a retry time; the retry saves it - exactly one abandonment", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { failCalls: new Set([1]) }); // the SAVE transaction times out on the first attempt
      const c = cart();
      const id = await w.deliver(c);
      const t0 = new Date();
      assert.equal(await processAbandonmentEvent(id, { store: w.store, runner: w.runner as never, now: () => t0 }), "retry");
      const failed = await w.event(id);
      assert.equal(failed.status, WebhookStatus.FAILED);
      assert.match(failed.errorMessage ?? "", /expired transaction/);
      assert.ok(failed.nextAttemptAt && failed.nextAttemptAt.getTime() > t0.getTime());
      assert.equal((await w.abandonments(c.cart_id as string)).length, 0, "nothing half-saved");
      assert.deepEqual(await w.store.due(t0, 10), [], "not due yet");
      const later = new Date(t0.getTime() + 2 * 60_000);
      assert.deepEqual(await w.store.due(later, 10), [id], "due after its backoff");
      assert.equal(await processAbandonmentEvent(id, { store: w.store, runner: w.runner as never, now: () => later }), "processed");
      assert.equal((await w.abandonments(c.cart_id as string)).length, 1);
      assert.equal((await w.event(id)).attempts, 2);
    });
  });

  it("the retry policy gives a delivery ~11 hours (24 attempts, backoff capped at 30 min) before it is declared dead; the shared ceiling of 8 is not used for this provider", async () => {
    assert.equal(ABANDONMENT_MAX_ATTEMPTS, 24);
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((a) => abandonmentBackoffMs(a) / 60_000), [1, 2, 4, 8, 16, 30, 30, 30]);
    const hours = Array.from({ length: ABANDONMENT_MAX_ATTEMPTS - 1 }, (_, i) => abandonmentBackoffMs(i + 1)).reduce((a, b) => a + b, 0) / 3_600_000;
    assert.ok(hours > 9 && hours < 13, `~${hours.toFixed(1)} h of retries`);
    await inRollback(async (tx) => {
      const w = await world(tx, { failCalls: new Set([1]) });
      const id = await w.deliver(cart());
      await tx.webhookEvent.update({ where: { id }, data: { attempts: 8, status: WebhookStatus.FAILED, nextAttemptAt: new Date(Date.now() - 1000) } });
      assert.ok((await w.store.due(new Date(), 10)).includes(id), "attempt 8 is no longer the end of the line");
    });
  });

  it("at the ceiling the delivery is declared dead (no retry time) and counted", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { failCalls: new Set([1]) });
      const id = await w.deliver(cart());
      await tx.webhookEvent.update({ where: { id }, data: { attempts: ABANDONMENT_MAX_ATTEMPTS - 1 } });
      assert.equal(await processAbandonmentEvent(id, { store: w.store, runner: w.runner as never }), "failed");
      const e = await w.event(id);
      assert.equal(e.status, WebhookStatus.FAILED);
      assert.equal(e.nextAttemptAt, null);
      assert.equal(ingestionMetrics.snapshot().counters.exhausted, 1);
    });
  });
});

describe("reconciliation of dead deliveries", () => {
  const dead = async (w: Awaited<ReturnType<typeof world>>, payload: unknown, receivedAgoH = 1, attempts = 8) => {
    const id = await w.deliver(payload, { receivedAt: new Date(Date.now() - receivedAgoH * 3_600_000) });
    await w.tx.webhookEvent.update({ where: { id }, data: { status: WebhookStatus.FAILED, attempts, nextAttemptAt: null, errorMessage: "Transaction API error: expired transaction" } });
    return id;
  };
  const run = (w: Awaited<ReturnType<typeof world>>, options = {}) => reconcileFailedAbandonmentEvents({ db: w.tx, runner: w.runner as never, store: w.store, provider: PROVIDER }, options);

  it("recovers dead deliveries into abandoned leads, oldest first, and NEVER auto-assigns them (even with auto-assign switched on)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.enableManagerAutoAssign();
      const a = cart(), b = cart();
      const ida = await dead(w, a, 3), idb = await dead(w, b, 2);
      const r = await run(w);
      assert.deepEqual([r.examined, r.recovered, r.failedAgain, r.skipped, r.remaining], [2, 2, 0, 0, 0]);
      for (const id of [ida, idb]) assert.equal((await w.event(id)).status, WebhookStatus.PROCESSED);
      for (const c of [a, b]) {
        const [row] = await w.abandonments(c.cart_id as string);
        assert.ok(row, "saved");
        assert.deepEqual([row!.lead.assignedManagerId, row!.lead.ownerId], [null, null], "a recovered lead is never auto-assigned");
      }
      assert.equal(await tx.leadAssignment.count({ where: { leadId: { in: (await w.abandonments(a.cart_id as string)).map((x) => x.leadId) } } }), 0, "no assignment history created");
    });
  });

  it("is idempotent and does not duplicate: a second pass finds nothing; a cart the live path already saved is updated in place, not duplicated", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = cart();
      await processAbandonmentEvent(await w.deliver(c), { store: w.store, runner: w.runner as never });
      await dead(w, c, 1);
      const r1 = await run(w);
      assert.equal(r1.recovered, 1);
      assert.equal((await w.abandonments(c.cart_id as string)).length, 1, "one abandonment for the cart");
      const r2 = await run(w);
      assert.deepEqual([r2.examined, r2.recovered], [0, 0]);
    });
  });

  it("an OLDER dead event never overwrites a newer checkout that was saved after it", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const id = `cart-${uid()}`;
      const phone = "9000000999";
      const t = Date.now();
      const newer = cart({ cart_id: id, phone_number: phone, shipping_address: { first_name: "N", address1: "New Rd", city: "Nagpur", state: "MH", zip: "440001", phone }, items: [{ name: "Newer Item", quantity: 2, price: "5" }] }, new Date(t));
      const older = cart({ cart_id: id, phone_number: phone, shipping_address: { first_name: "O", address1: "Old Rd", city: "Pune", state: "MH", zip: "411001", phone }, items: [{ name: "Older Item", quantity: 9, price: "1" }] }, new Date(t - 2 * 3_600_000));
      await processAbandonmentEvent(await w.deliver(newer), { store: w.store, runner: w.runner as never });
      await dead(w, older, 2);
      await run(w);
      const [row] = await w.abandonments(id);
      const snap = row!.cartSnapshot as any;
      assert.equal(snap.shippingAddress.city, "Nagpur");
      assert.deepEqual(snap.lines.map((l: any) => l.name), ["Newer Item"]);
    });
  });

  it("is BOUNDED: only the requested window, at most `limit` per pass (the rest reported as remaining), and a window above 7 days is capped", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      for (let i = 0; i < 5; i++) await dead(w, cart(), 1 + i * 0.1);
      const outside = cart();
      await dead(w, outside, 100); // 100 h ago: outside the default 48 h window
      const r = await run(w, { limit: 3 });
      assert.deepEqual([r.examined, r.recovered, r.remaining], [3, 3, 2]);
      assert.equal((await w.abandonments(outside.cart_id as string)).length, 0, "outside the window: untouched");
      const r2 = await run(w, { sinceHours: 99999, limit: 50 });
      assert.equal(r2.recovered, 3, "the remaining 2 plus the 100 h one (window capped at 168 h, which still includes it)");
    });
  });

  it("an event another worker already holds is skipped, not double-processed", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const c = cart();
      const id = await dead(w, c, 1);
      await tx.webhookEvent.update({ where: { id }, data: { status: WebhookStatus.PROCESSING, nextAttemptAt: new Date(Date.now() + 60_000) } }); // a live worker holds it
      const r = await run(w);
      assert.deepEqual([r.examined, r.recovered], [0, 0], "a held event is not even a candidate");
      assert.equal((await w.abandonments(c.cart_id as string)).length, 0);
    });
  });

  it("an event that fails again stays failed and is reported, never silently dropped", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx, { failCalls: new Set([1]) });
      const c = cart();
      const id = await dead(w, c, 1);
      const r = await run(w);
      assert.deepEqual([r.recovered, r.failedAgain], [0, 1]);
      assert.equal((await w.event(id)).status, WebhookStatus.FAILED);
      assert.ok((await w.event(id)).nextAttemptAt, "it is back on the retry schedule");
    });
  });
});

describe("ingestion endpoints' counters and authorization", () => {
  const cfg = { secret: "s3cret-test" } as const;
  it("counts unauthorized, invalid, duplicate and unusable deliveries - counts only", async () => {
    const { store } = memoryStore();
    const scheduled: string[] = [];
    const deps = { config: cfg, store, schedule: (id: string) => void scheduled.push(id) };
    const good = Buffer.from(JSON.stringify(cart()));
    assert.equal((await handleAbandonmentWebhook({ rawBody: good, headers: {} }, deps)).status, 401);
    assert.equal((await handleAbandonmentWebhook({ rawBody: Buffer.from("{nope"), headers: { "x-webhook-secret": cfg.secret } }, deps)).status, 400);
    assert.equal((await handleAbandonmentWebhook({ rawBody: good, headers: { "x-webhook-secret": cfg.secret } }, deps)).message, "Received");
    assert.equal((await handleAbandonmentWebhook({ rawBody: good, headers: { "x-webhook-secret": cfg.secret } }, deps)).message, "Duplicate delivery ignored");
    assert.equal((await handleAbandonmentWebhook({ rawBody: Buffer.from(JSON.stringify({ cart_id: "x" })), headers: { "x-webhook-secret": cfg.secret } }, deps)).message.startsWith("Delivery has no usable contact"), true);
    const c = ingestionMetrics.snapshot().counters;
    assert.deepEqual([c.unauthorized, c.invalidBody, c.received, c.duplicates, c.unusableNoContact], [1, 1, 2, 1, 1]);
    assert.equal(scheduled.length, 1);
  });

  it("acknowledges only after the delivery is RECORDED, and answers promptly without doing the save", async () => {
    const { store, rows } = memoryStore();
    let scheduledBeforeRecord = false;
    const deps = { config: cfg, store, schedule: () => { scheduledBeforeRecord = rows.length === 0; } };
    const t0 = Date.now();
    const r = await handleAbandonmentWebhook({ rawBody: Buffer.from(JSON.stringify(cart())), headers: { "x-webhook-secret": cfg.secret } }, deps);
    assert.equal(r.status, 200);
    assert.equal(rows.length, 1, "recorded before answering");
    assert.equal(scheduledBeforeRecord, false, "processing is scheduled only after the record exists");
    assert.ok(Date.now() - t0 < 500);
  });
});

describe("ingestion health (counts and times only)", () => {
  // "Now" = 2026-10-13 10:30 IST. Today (IST) = [2026-10-12T18:30Z, 2026-10-13T18:30Z).
  const NOW = new Date("2026-10-13T05:00:00Z");
  const T_START = new Date("2026-10-12T18:30:00Z");
  const seed = async (w: Awaited<ReturnType<typeof world>>, payload: Record<string, unknown>, o: { received: Date; status: WebhookStatus; attempts?: number; processedAfterS?: number; next?: Date | null; lagS?: number }) => {
    // the provider's own event time is always `lagS` (default 60 s) before the CRM received it
    const id = await w.deliver({ ...payload, updated_at: provider(o.received, o.lagS ?? 60) }, { receivedAt: o.received });
    await w.tx.webhookEvent.update({ where: { id }, data: { status: o.status, attempts: o.attempts ?? (o.status === "PROCESSED" ? 1 : 0), processedAt: o.status === "PROCESSED" ? new Date(o.received.getTime() + (o.processedAfterS ?? 3) * 1000) : null, nextAttemptAt: o.next ?? null } });
    return id;
  };
  const provider = (received: Date, lagS: number) => istStamp(new Date(received.getTime() - lagS * 1000));

  it("splits IST days exactly at midnight; reconciles received -> saved -> not saved; reports lag percentiles; never exposes personal data", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const status = (p: "today" | "yesterday" | "all") => getIngestionStatus(tx, { id: w.admin.id, username: "a", role: Role.ADMIN }, p, NOW);
      const saved = cart({ phone_number: "9000011111" });
      const rA = new Date(T_START.getTime() + 60_000);
      // today: one saved cart (abandonment exists), one failed cart (dead), one retryable, one pending, one ignored (no contact)
      const idSaved = await seed(w, saved, { received: rA, status: WebhookStatus.PROCESSED, processedAfterS: 4, lagS: 66 });
      await processAbandonmentEvent(idSaved, { store: w.store, runner: w.runner as never }).catch(() => undefined);
      await tx.abandonment.create({ data: { leadId: (await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "X", mobile: "9000011111", normalizedMobile: "+919000011111" }, select: { id: true } })).id, type: "CHECKOUT", detectedAt: rA, referenceId: saved.cart_id as string } });
      await seed(w, cart(), { received: new Date(rA.getTime() + 1000), status: WebhookStatus.FAILED, attempts: 24, next: null, lagS: 120 });
      await seed(w, cart(), { received: new Date(rA.getTime() + 2000), status: WebhookStatus.FAILED, attempts: 3, next: new Date(NOW.getTime() + 60_000) });
      await seed(w, cart(), { received: new Date(NOW.getTime() - 600_000), status: WebhookStatus.RECEIVED });
      await seed(w, { cart_id: `cart-${uid()}`, items: [] }, { received: new Date(rA.getTime() + 3000), status: WebhookStatus.IGNORED });
      // yesterday: 2 processed; exactly one at the last millisecond of yesterday and one exactly at today's midnight
      await seed(w, cart(), { received: new Date(T_START.getTime() - 1), status: WebhookStatus.PROCESSED });
      await seed(w, cart(), { received: new Date(T_START.getTime() - 3_600_000), status: WebhookStatus.PROCESSED });
      await seed(w, cart(), { received: new Date(T_START.getTime()), status: WebhookStatus.PROCESSED });

      const t = await status("today");
      assert.equal(t.received.events, 6, "6 events received today (the one at exactly 00:00 IST is today's)");
      assert.deepEqual(t.byStatus, { processed: 2, ignoredNoContact: 1, failed: 2, pending: 1 });
      assert.deepEqual(t.failed, { retryable: 1, exhausted: 1 });
      assert.equal(t.carts.received, 6);
      assert.equal(t.carts.saved, 1);
      assert.equal(t.carts.ignoredNoContact, 1);
      assert.equal(t.carts.notSaved, 4, "6 carts - 1 saved - 1 ignored (no contact) = 4 received but NOT saved");
      assert.ok(t.latency.providerToReceipt.samples >= 2 && t.latency.providerToReceipt.p50! >= 60 && t.latency.providerToReceipt.max! >= 119, JSON.stringify(t.latency.providerToReceipt));
      assert.ok(t.latency.receiptToSaved.samples >= 1 && t.latency.receiptToSaved.p50! >= 3);
      assert.ok(t.backlog.pending >= 1 && t.backlog.retryable >= 1 && t.backlog.exhausted7d >= 1 && t.backlog.oldestPendingAgeSeconds! >= 600);
      const y = await status("yesterday");
      assert.equal(y.received.events, 2, "the event 1 ms before midnight and the one an hour earlier are yesterday's");
      const all = await status("all");
      assert.equal(all.received.events, 8);
      const text = JSON.stringify([t, y, all]);
      for (const secret of ["9000011111", String(saved.cart_id), "Test", "Pune", "411001", "s3cret"]) assert.ok(!text.includes(secret), `no ${secret}`);
    });
  });

  it("who may see it: admin, manager and HR can; a telecaller cannot; only an admin can re-process", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const svc = new AbandonmentService(tx as never);
      for (const role of [Role.ADMIN, Role.MANAGER, Role.HR]) assert.ok((await svc.getIngestionStatus({ id: uid(), username: "x", role }, "today")).timezone);
      await assert.rejects(() => svc.getIngestionStatus({ id: uid(), username: "x", role: Role.SALESPERSON }, "today"), (e: any) => e.statusCode === 403);
      for (const role of [Role.MANAGER, Role.HR, Role.SALESPERSON]) await assert.rejects(() => svc.reconcileIngestion({ id: uid(), username: "x", role }, {}), (e: any) => e.statusCode === 403);
      const ok = await svc.reconcileIngestion({ id: w.admin.id, username: "a", role: Role.ADMIN }, { limit: 1 });
      assert.equal(typeof ok.remaining, "number");
    });
  });
});
