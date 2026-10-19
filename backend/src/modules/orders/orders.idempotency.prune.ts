import { logger } from "@/utils/logger.js";
import { prisma } from "@/lib/prisma.js";
import { IDEMPOTENCY_COMPLETED, ORDER_CREATE_OPERATION } from "./orders.idempotency.js";

// Bounded retention for the idempotency ledger (prisma/schema/idempotency.prisma). A row exists to stop a retried request from creating a second order, so it is
// only removed once no retry can plausibly still arrive AND nothing is left to reconcile.
//   IDEMPOTENCY_PRUNE_HOURS     how often to prune, in hours. OPT-IN: unset or 0 = off (same convention as CASHFREE_RECONCILE_MINUTES).
//   IDEMPOTENCY_RETENTION_DAYS  how long a COMPLETED row is kept (default 30, never below 2).
//   IDEMPOTENCY_PRUNE_BATCH     rows removed per pass (default 500, never above 5000) - a backlog is worked off over several passes, never in one huge delete.
// What is NEVER removed: a row whose order may still need reconciling (status ORDER_CREATED and the order exists and is not yet linked to Shopify), and anything younger
// than its retention.

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 2;
export const DEFAULT_PRUNE_BATCH = 500;
export const MAX_PRUNE_BATCH = 5000;
/** An interrupted (non-COMPLETED) row is only considered after this many days - and then only when there is nothing left to reconcile. */
export const INTERRUPTED_RETENTION_DAYS = 90;

type Env = Record<string, string | undefined>;
const num = (raw: string | undefined) => {
  const n = Number((raw ?? "").trim());
  return (raw ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
};

export function loadPruneConfig(env: Env = process.env): { everyHours: number; retentionDays: number; batch: number } {
  const hours = num(env.IDEMPOTENCY_PRUNE_HOURS);
  const days = num(env.IDEMPOTENCY_RETENTION_DAYS);
  const batch = num(env.IDEMPOTENCY_PRUNE_BATCH);
  return {
    everyHours: hours !== null && hours > 0 ? hours : 0,
    retentionDays: Math.max(MIN_RETENTION_DAYS, days !== null && days > 0 ? Math.floor(days) : DEFAULT_RETENTION_DAYS),
    batch: Math.min(MAX_PRUNE_BATCH, batch !== null && batch > 0 ? Math.floor(batch) : DEFAULT_PRUNE_BATCH),
  };
}

type Db = Pick<typeof prisma, "idempotencyKey" | "order">;
export interface PruneResult { deleted: number; keptRecoverable: number }

const DAY = 86_400_000;

export async function pruneIdempotencyKeys(db: Db, opts: { now?: Date; retentionDays?: number; batch?: number } = {}): Promise<PruneResult> {
  const now = opts.now ?? new Date();
  const retentionDays = Math.max(MIN_RETENTION_DAYS, opts.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const batch = Math.min(MAX_PRUNE_BATCH, Math.max(1, opts.batch ?? DEFAULT_PRUNE_BATCH));
  const result: PruneResult = { deleted: 0, keptRecoverable: 0 };

  // 1) Finished requests past their retention.
  const finished = await db.idempotencyKey.findMany({
    where: { operation: ORDER_CREATE_OPERATION, status: IDEMPOTENCY_COMPLETED, updatedAt: { lt: new Date(now.getTime() - retentionDays * DAY) } },
    orderBy: { updatedAt: "asc" },
    take: batch,
    select: { id: true },
  });
  if (finished.length > 0) result.deleted += (await db.idempotencyKey.deleteMany({ where: { id: { in: finished.map((r) => r.id) }, status: IDEMPOTENCY_COMPLETED } })).count;

  // 2) Interrupted requests (order committed, follow-ups unfinished): only after a long time, and only when there is nothing left to reconcile - the order is
  //    gone, or it is already linked to Shopify. Otherwise the row is kept: it is what lets a late retry finish the original operation instead of repeating it.
  const room = batch - result.deleted;
  if (room > 0) {
    const interrupted = await db.idempotencyKey.findMany({
      where: { operation: ORDER_CREATE_OPERATION, status: { not: IDEMPOTENCY_COMPLETED }, createdAt: { lt: new Date(now.getTime() - Math.max(INTERRUPTED_RETENTION_DAYS, retentionDays) * DAY) } },
      orderBy: { createdAt: "asc" },
      take: room,
      select: { id: true, orderId: true },
    });
    for (const row of interrupted) {
      const order = row.orderId ? await db.order.findUnique({ where: { id: row.orderId }, select: { externalId: true } }) : null;
      const nothingToReconcile = !order || order.externalId !== null;
      if (!nothingToReconcile) {
        result.keptRecoverable++;
        continue;
      }
      result.deleted += (await db.idempotencyKey.deleteMany({ where: { id: row.id, status: { not: IDEMPOTENCY_COMPLETED } } })).count;
    }
  }
  return result;
}

/** Starts the periodic prune - only when IDEMPOTENCY_PRUNE_HOURS is set. Never overlaps itself; one bounded pass per tick. */
export function startIdempotencyPruneJob() {
  const { everyHours, retentionDays, batch } = loadPruneConfig();
  if (everyHours === 0) return null;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await pruneIdempotencyKeys(prisma, { retentionDays, batch });
      if (r.deleted > 0 || r.keptRecoverable > 0) logger.info(`Idempotency prune: ${r.deleted} removed, ${r.keptRecoverable} kept (still recoverable)`);
    } catch (error) {
      logger.error("Idempotency prune failed", error);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 120_000);
  const timer = setInterval(() => void run(), everyHours * 3_600_000);
  first.unref();
  timer.unref();
  logger.info(`Idempotency prune started (every ${everyHours} h, retention ${retentionDays} d, batch ${batch})`);
  return { tick: run, stop: () => { clearTimeout(first); clearInterval(timer); } };
}
