import { WebhookStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { LEASE_MS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import type { TxRunner } from "../integrations/integrations.common.js";
import { logger } from "@/utils/logger.js";
import { ingestionMetrics, type ReconcileSummary } from "./shiprocket.abandonment.metrics.js";
import { ABANDONMENT_MAX_ATTEMPTS, processClaimedAbandonmentEvent } from "./shiprocket.abandonment.processor.js";

// Recovery of Fastrr abandon-cart deliveries the CRM RECEIVED but could not save (they sit in webhook_events as FAILED with no retry left).
//
// This is a LOCAL reconciliation: it re-drives events that are already stored, through the same validated parser and the same save code the live path uses. Fastrr offers no read API in this
// codebase (there is no client for one, and the dashboard is not scraped), so events Fastrr never delivered cannot be fetched from here - see the report for the provider-side step.
//
// Safe by construction:
//  - bounded: a recent window (default 48 h, at most 7 days), a batch (default 50, at most 200) and a time budget per pass; nothing here is an unbounded historical import;
//  - the save is idempotent (same cart -> the same abandonment, updated in place) and an older event never overwrites newer data, so re-driving is harmless even if the live path got there first;
//  - events are processed oldest first, one at a time, each claimed atomically (a live worker that already holds one is simply skipped);
//  - it NEVER auto-assigns a recovered lead and never touches assignment history.

export const RECONCILE_DEFAULT_HOURS = 48;
export const RECONCILE_MAX_HOURS = 168;
export const RECONCILE_DEFAULT_BATCH = 50;
export const RECONCILE_MAX_BATCH = 200;
export const RECONCILE_TIME_BUDGET_MS = 25_000;

export interface ReconcileOptions {
  sinceHours?: number;
  limit?: number;
  timeBudgetMs?: number;
  now?: () => Date;
}

export interface ReconcileResult extends ReconcileSummary {
  /** Dead events still waiting in the window after this pass (run again to continue). */
  remaining: number;
  timedOut: boolean;
}

type EventDb = Pick<Prisma.TransactionClient, "webhookEvent">;

/** Events that have nothing left to retry them: FAILED with no next attempt, or past the attempt ceiling. */
const deadWhere = (provider: string, since: Date): Prisma.WebhookEventWhereInput => ({
  provider,
  eventType: "checkout.abandoned",
  status: WebhookStatus.FAILED,
  receivedAt: { gte: since },
  OR: [{ nextAttemptAt: null }, { attempts: { gte: ABANDONMENT_MAX_ATTEMPTS } }],
});

export async function countDeadAbandonmentEvents(db: EventDb, provider: string, sinceHours: number, now: Date = new Date()): Promise<number> {
  return db.webhookEvent.count({ where: deadWhere(provider, new Date(now.getTime() - sinceHours * 3_600_000)) });
}

export async function reconcileFailedAbandonmentEvents(
  deps: { db: EventDb; runner: TxRunner; store: WebhookStore; provider: string },
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const now = options.now ?? (() => new Date());
  const hours = Math.min(RECONCILE_MAX_HOURS, Math.max(1, Math.floor(options.sinceHours ?? RECONCILE_DEFAULT_HOURS)));
  const limit = Math.min(RECONCILE_MAX_BATCH, Math.max(1, Math.floor(options.limit ?? RECONCILE_DEFAULT_BATCH)));
  const budget = options.timeBudgetMs ?? RECONCILE_TIME_BUDGET_MS;
  const since = new Date(now().getTime() - hours * 3_600_000);
  const started = Date.now();

  const candidates = await deps.db.webhookEvent.findMany({ where: deadWhere(deps.provider, since), orderBy: { receivedAt: "asc" }, take: limit, select: { id: true } });
  const summary: ReconcileSummary = { at: now().toISOString(), examined: 0, recovered: 0, failedAgain: 0, skipped: 0 };
  let timedOut = false;

  for (const { id } of candidates) {
    if (Date.now() - started > budget) { timedOut = true; break; }
    summary.examined++;
    // Atomic claim: only a still-dead FAILED event can be taken, so a live worker (or a second reconcile) holding it makes this a no-op.
    const claimed = await deps.db.webhookEvent.updateMany({
      where: { id, provider: deps.provider, status: WebhookStatus.FAILED, OR: [{ nextAttemptAt: null }, { attempts: { gte: ABANDONMENT_MAX_ATTEMPTS } }] },
      data: { status: WebhookStatus.PROCESSING, nextAttemptAt: new Date(now().getTime() + LEASE_MS) },
    });
    if (claimed.count === 0) { summary.skipped++; continue; }
    const row = await deps.db.webhookEvent.findUnique({ where: { id }, select: { id: true, payload: true, attempts: true } });
    if (!row) { summary.skipped++; continue; }
    const outcome = await processClaimedAbandonmentEvent({ id: row.id, payload: row.payload, attempts: row.attempts }, { store: deps.store, runner: deps.runner, now, autoAssign: false });
    if (outcome === "processed" || outcome === "ignored") {
      summary.recovered++;
      ingestionMetrics.inc("recoveredByReconcile");
    } else summary.failedAgain++;
  }

  const remaining = await countDeadAbandonmentEvents(deps.db, deps.provider, hours, now());
  ingestionMetrics.setLastReconcile(summary);
  logger.info(`fastrr.reconcile examined=${summary.examined} recovered=${summary.recovered} failed_again=${summary.failedAgain} skipped=${summary.skipped} remaining=${remaining} window_h=${hours}`);
  return { ...summary, remaining, timedOut };
}
