import { Prisma } from "../../../generated/prisma/client.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import type { DbClient } from "@/lib/leadScope.js";
import { abandonmentDateRangeBounds } from "./abandonment.filters.js";
import { ABANDONMENT_MAX_ATTEMPTS } from "../shiprocket/shiprocket.abandonment.processor.js";
import { ingestionMetrics } from "../shiprocket/shiprocket.abandonment.metrics.js";
import type { AbandonmentDateRange } from "./abandonment.types.js";

// Health of the Fastrr abandon-cart ingestion, from the webhook_events table (durable) plus this process's in-memory counters (since start, labelled as such).
// COUNTS AND TIMES ONLY: no event body, no cart id, no name / phone / email / address, and no secret ever leaves this module.

export const FASTRR_PROVIDER = "SHIPROCKET_CHECKOUT";
const TS = Prisma.sql`'^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?$'`;

export interface IngestionStatus {
  period: AbandonmentDateRange;
  timezone: "IST (UTC+05:30)";
  now: string;
  /** Durable, from the database. */
  lastReceivedAt: string | null;
  lastProcessedAt: string | null;
  lastFailedAt: string | null;
  secondsSinceLastReceived: number | null;
  received: { events: number; distinctCarts: number };
  byStatus: { processed: number; ignoredNoContact: number; failed: number; pending: number };
  failed: { retryable: number; exhausted: number };
  /** Processed on a later attempt (a transient failure that recovered by retry or reconciliation). */
  processedAfterRetry: number;
  carts: {
    received: number;
    saved: number;
    /** Received but not saved as an abandoned lead: failed, still pending, or lost after exhausting retries. THE number to watch. */
    notSaved: number;
    ignoredNoContact: number;
  };
  /** Seconds. provider -> CRM receipt compares the provider's own event time (IST) with when the CRM received it; receipt -> saved is the CRM's processing time. */
  latency: {
    providerToReceipt: { samples: number; p50: number | null; p90: number | null; max: number | null };
    receiptToSaved: { samples: number; p50: number | null; p90: number | null; max: number | null };
  };
  /** Right now, whatever the period. */
  backlog: { pending: number; retryable: number; exhausted7d: number; oldestPendingAgeSeconds: number | null };
  /** Since this server process started - resets on a restart/deploy. */
  process: { since: string; received: number; duplicates: number; unauthorized: number; invalidBody: number; notConfigured: number; unusableNoContact: number; processed: number; failedAttempts: number; exhausted: number; autoAssignFailed: number; recoveredByReconcile: number };
  lastReconcile: { at: string; examined: number; recovered: number; failedAgain: number; skipped: number } | null;
}

interface Row {
  events: number; carts: number; processed: number; ignored: number; failed: number; pending: number; exhausted: number; retryable: number; after_retry: number;
  last_received: Date | null; last_processed: Date | null; last_failed: Date | null;
  prov_n: number; prov_p50: number | null; prov_p90: number | null; prov_max: number | null;
  proc_n: number; proc_p50: number | null; proc_p90: number | null; proc_max: number | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const r1 = (n: number | null) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);

export async function getIngestionStatus(db: DbClient, user: AuthUser, period: AbandonmentDateRange, now: Date = new Date()): Promise<IngestionStatus> {
  if (user.role !== Role.ADMIN && user.role !== Role.MANAGER && user.role !== Role.HR) {
    throw Object.assign(new Error("You do not have permission to view ingestion health"), { statusCode: 403 });
  }
  const bounds = abandonmentDateRangeBounds(period, now);
  const periodSql = bounds ? Prisma.sql`AND e.received_at >= ${bounds.gte} AND e.received_at < ${bounds.lt}` : Prisma.empty;
  const base = Prisma.sql`
    SELECT e.id, e.status, e.attempts, e.next_attempt_at, e.received_at, e.processed_at, e.payload->>'cart_id' AS cart,
           CASE WHEN e.payload->>'updated_at' ~ ${TS} THEN (replace(e.payload->>'updated_at', ' ', 'T')::timestamp - interval '5 hours 30 minutes') END AS provider_at
    FROM webhook_events e
    WHERE e.provider = ${FASTRR_PROVIDER} AND e.event_type = 'checkout.abandoned' ${periodSql}`;

  const [row] = await db.$queryRaw<Row[]>`
    WITH ev AS (${base})
    SELECT count(*)::int AS events, count(DISTINCT cart)::int AS carts,
      (count(*) FILTER (WHERE status = 'PROCESSED'))::int AS processed, (count(*) FILTER (WHERE status = 'IGNORED'))::int AS ignored,
      (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed, (count(*) FILTER (WHERE status IN ('RECEIVED','PROCESSING')))::int AS pending,
      (count(*) FILTER (WHERE status = 'FAILED' AND (next_attempt_at IS NULL OR attempts >= ${ABANDONMENT_MAX_ATTEMPTS})))::int AS exhausted,
      (count(*) FILTER (WHERE status = 'FAILED' AND next_attempt_at IS NOT NULL AND attempts < ${ABANDONMENT_MAX_ATTEMPTS}))::int AS retryable,
      (count(*) FILTER (WHERE status = 'PROCESSED' AND attempts > 1))::int AS after_retry,
      max(received_at) AS last_received, max(processed_at) FILTER (WHERE status = 'PROCESSED') AS last_processed, max(received_at) FILTER (WHERE status = 'FAILED') AS last_failed,
      (count(*) FILTER (WHERE provider_at IS NOT NULL))::int AS prov_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (received_at - provider_at))) FILTER (WHERE provider_at IS NOT NULL) AS prov_p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (received_at - provider_at))) FILTER (WHERE provider_at IS NOT NULL) AS prov_p90,
      max(extract(epoch FROM (received_at - provider_at))) FILTER (WHERE provider_at IS NOT NULL) AS prov_max,
      (count(*) FILTER (WHERE status = 'PROCESSED' AND processed_at IS NOT NULL))::int AS proc_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (processed_at - received_at))) FILTER (WHERE status = 'PROCESSED' AND processed_at IS NOT NULL) AS proc_p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (processed_at - received_at))) FILTER (WHERE status = 'PROCESSED' AND processed_at IS NOT NULL) AS proc_p90,
      max(extract(epoch FROM (processed_at - received_at))) FILTER (WHERE status = 'PROCESSED' AND processed_at IS NOT NULL) AS proc_max
    FROM ev`;

  const [carts] = await db.$queryRaw<{ saved: number; ignored_only: number }[]>`
    WITH ev AS (${base}),
    c AS (SELECT cart, bool_and(status = 'IGNORED') AS all_ignored, EXISTS (SELECT 1 FROM abandonments a WHERE a.reference_id = ev.cart) AS persisted FROM ev WHERE cart IS NOT NULL GROUP BY cart)
    SELECT (count(*) FILTER (WHERE persisted))::int AS saved, (count(*) FILTER (WHERE all_ignored AND NOT persisted))::int AS ignored_only FROM c`;

  const [live] = await db.$queryRaw<{ pending: number; retryable: number; exhausted7d: number; oldest: Date | null; last_received: Date | null }[]>`
    SELECT (count(*) FILTER (WHERE status IN ('RECEIVED','PROCESSING')))::int AS pending,
           (count(*) FILTER (WHERE status = 'FAILED' AND next_attempt_at IS NOT NULL AND attempts < ${ABANDONMENT_MAX_ATTEMPTS}))::int AS retryable,
           (count(*) FILTER (WHERE status = 'FAILED' AND (next_attempt_at IS NULL OR attempts >= ${ABANDONMENT_MAX_ATTEMPTS}) AND received_at > ${new Date(now.getTime() - 7 * 86_400_000)}))::int AS exhausted7d,
           min(received_at) FILTER (WHERE status IN ('RECEIVED','PROCESSING') OR (status = 'FAILED' AND next_attempt_at IS NOT NULL AND attempts < ${ABANDONMENT_MAX_ATTEMPTS})) AS oldest,
           max(received_at) AS last_received
    FROM webhook_events WHERE provider = ${FASTRR_PROVIDER} AND event_type = 'checkout.abandoned' AND received_at > ${new Date(now.getTime() - 30 * 86_400_000)}`;

  const m = ingestionMetrics.snapshot();
  const savedCarts = carts?.saved ?? 0;
  const ignoredOnly = carts?.ignored_only ?? 0;
  const lastReceived = live?.last_received ?? row?.last_received ?? null;
  return {
    period,
    timezone: "IST (UTC+05:30)",
    now: now.toISOString(),
    lastReceivedAt: iso(lastReceived),
    lastProcessedAt: iso(row?.last_processed ?? null),
    lastFailedAt: iso(row?.last_failed ?? null),
    secondsSinceLastReceived: lastReceived ? Math.max(0, Math.round((now.getTime() - new Date(lastReceived).getTime()) / 1000)) : null,
    received: { events: row?.events ?? 0, distinctCarts: row?.carts ?? 0 },
    byStatus: { processed: row?.processed ?? 0, ignoredNoContact: row?.ignored ?? 0, failed: row?.failed ?? 0, pending: row?.pending ?? 0 },
    failed: { retryable: row?.retryable ?? 0, exhausted: row?.exhausted ?? 0 },
    processedAfterRetry: row?.after_retry ?? 0,
    carts: { received: row?.carts ?? 0, saved: savedCarts, notSaved: Math.max(0, (row?.carts ?? 0) - savedCarts - ignoredOnly), ignoredNoContact: ignoredOnly },
    latency: {
      providerToReceipt: { samples: row?.prov_n ?? 0, p50: r1(row?.prov_p50 ?? null), p90: r1(row?.prov_p90 ?? null), max: r1(row?.prov_max ?? null) },
      receiptToSaved: { samples: row?.proc_n ?? 0, p50: r1(row?.proc_p50 ?? null), p90: r1(row?.proc_p90 ?? null), max: r1(row?.proc_max ?? null) },
    },
    backlog: { pending: live?.pending ?? 0, retryable: live?.retryable ?? 0, exhausted7d: live?.exhausted7d ?? 0, oldestPendingAgeSeconds: live?.oldest ? Math.max(0, Math.round((now.getTime() - new Date(live.oldest).getTime()) / 1000)) : null },
    process: { since: m.sinceProcessStart, ...m.counters },
    lastReconcile: m.lastReconcile,
  };
}
