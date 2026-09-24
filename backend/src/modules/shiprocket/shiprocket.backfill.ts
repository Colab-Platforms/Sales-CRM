import { randomUUID } from "node:crypto";
import { ActivitySource, ActivityType, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { advisoryLock, ProviderHttpError, safeMessage, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { applyShipmentUpdate, shipmentOrderLockKey, SHIPMENT_REFERENCE_TYPE } from "./shiprocket.apply.js";
import type { ExistingShipment } from "./shiprocket.client.js";
import { mapShiprocketStatus } from "./shiprocket.events.js";

// Read-only Shiprocket -> CRM backfill: imports shipment/tracking data that ALREADY exists in the Shiprocket account
// into the CRM's Shipment table. Mirrors shopify.sync.ts's shape (window, pagination, dry run, report), but this one
// only ever reads Shiprocket - it never calls create-order, assign-awb, generate-pickup or generate-label. Every
// discovered row is matched to an existing CRM Shipment (by Shiprocket id, then AWB, then Shiprocket order id) for an
// update, or to an existing CRM Order (by channel order id) for a brand-new Shipment row - never to a new Order or
// Lead, and never to a Shopify-tagged Shipment row.

export interface ShiprocketApiForBackfill {
  listOrders(params: { page: number; perPage: number; from?: string; to?: string }): Promise<{ shipments: ExistingShipment[]; currentPage: number; lastPage: number | null; totalOrders: number | null }>;
  /** The existing, already-used-elsewhere read-only tracking lookup (the same one "Refresh tracking" calls) - never a write. */
  track(awb: string): Promise<{ currentStatus: string | null } | null>;
}

export interface BackfillOptions {
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
  limit: number | null; // null = --all
  dryRun: boolean;
}

export interface BackfillCounts {
  discovered: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface BackfillFailure {
  ref: string;
  reason: string;
}

export interface PreviewRow {
  shiprocketOrderId: string;
  awb: string | null;
  /** The raw status GET /orders itself reports - often just a numeric code (e.g. "7"), not descriptive text. */
  listStatus: string | null;
  /** Descriptive text from the existing track(awb) lookup, when one was attempted and succeeded. */
  trackingStatus: string | null;
  /** Set when a tracking lookup was attempted and failed - the real error, never a guess. */
  trackingError: string | null;
  /** What mapShiprocketStatus() resolved to from the best status text available - null when nothing mapped. */
  crmStatus: ShipmentStatus | null;
  channelOrderId: string | null;
  outcome: string;
}

export interface TrackingSummary {
  withAwb: number;
  succeeded: number;
  failed: number;
  /** Unique descriptive tracking texts actually seen, for a human to sanity-check the vocabulary. */
  descriptiveStatuses: string[];
  /** Descriptive tracking text that mapShiprocketStatus() does not recognise - never guessed, only reported. */
  unknownStatuses: string[];
}

export interface BackfillReport {
  connection: "PASS" | "FAIL";
  connectionError: string | null;
  windows: { from: string; to: string }[];
  counts: BackfillCounts;
  failures: BackfillFailure[];
  preview: PreviewRow[];
  databaseWrites: number;
  /** Real Shiprocket HTTP calls made (including retries) - GET /orders and the existing GET /courier/track/awb. Never a write. */
  apiCalls: { listOrders: number; track: number };
  tracking: TrackingSummary;
  /** How many discovered shipments would end up (or ended up) at each CRM ShipmentStatus; "UNMAPPED" = nothing mapped, so a new row falls back to CREATED and an existing row's status is left alone. */
  crmStatusCounts: Record<string, number>;
  elapsedMs: number;
  fatalError: string | null;
}

const MAX_WINDOW_DAYS = 30;
const PAGE_SIZE = 50;
const MAX_PAGE_ATTEMPTS = 3;
/** Small on purpose - item requires this so a backfill never hammers Shiprocket with concurrent tracking lookups. */
const TRACKING_CONCURRENCY = 3;

/** Never returns an empty string - the one thing item #16 of this feature exists to fix. */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) return message.split("\n")[0]!.trim() || message;
    return error.name || "Unknown error";
  }
  if (error === undefined || error === null) return "Unknown error";
  const text = String(error).trim();
  return text || "Unknown error";
}

const dayMs = 24 * 3_600_000;
const toIso = (d: Date) => d.toISOString().slice(0, 10);

/** Splits [since, until] into consecutive <=30-day chunks (inclusive) - Shiprocket's own documented limit on a from/to range. */
export function chunkWindow(since: string, until: string, maxDays = MAX_WINDOW_DAYS): { from: string; to: string }[] {
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const windows: { from: string; to: string }[] = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + (maxDays - 1) * dayMs, end.getTime()));
    windows.push({ from: toIso(cursor), to: toIso(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + dayMs);
  }
  return windows;
}

/** "#1050" / "1050" / "SHP-1050" all read as the same underlying order reference. */
export function normalizeOrderRef(ref: string): string {
  return ref.trim().replace(/^#/, "").replace(/^SHP-/i, "");
}

/** Every CRM order-number shape a Shiprocket channel_order_id could plausibly match, so a real match is never missed by formatting alone. */
export function orderRefCandidates(channelOrderId: string): string[] {
  const bare = normalizeOrderRef(channelOrderId);
  return [...new Set([channelOrderId, bare, `#${bare}`, `SHP-${bare}`])];
}

const ACTIVE_SHIPMENT_STATUSES = new Set<ShipmentStatus>(
  Object.values(ShipmentStatus).filter((s) => s !== ShipmentStatus.CANCELLED && s !== ShipmentStatus.RETURNED),
);

interface ApplyDeps {
  now: () => Date;
}

export type RowOutcome = "created" | "updated" | "skipped" | "failed";

/** The result of trying to get a real, descriptive status for one shipment via the existing track(awb) lookup. */
export interface TrackingLookup {
  /** false when there was no AWB to look up at all - status "cannot be verified through tracking", per spec, not a failure. */
  attempted: boolean;
  /** Descriptive text (e.g. "Delivered"), only set when a lookup was attempted and Shiprocket answered. */
  status: string | null;
  /** The real error, only set when a lookup was attempted and failed - never a guessed status alongside it. */
  error: string | null;
}

const NOT_APPLICABLE: TrackingLookup = { attempted: false, status: null, error: null };

/**
 * Looks up real tracking status for every AWB among `entries`, at most TRACKING_CONCURRENCY requests at a time - this
 * is what item #10 ("do not hammer Shiprocket") exists to bound. One lookup per unique AWB (a split shipment reported
 * twice reuses the same call). Every call is the existing, already-used read-only track(awb) - never a write.
 */
export async function resolveTracking(client: Pick<ShiprocketApiForBackfill, "track">, entries: ExistingShipment[]): Promise<{ lookups: Map<string, TrackingLookup>; calls: number }> {
  const uniqueAwbs = [...new Set(entries.map((e) => e.awb).filter((awb): awb is string => !!awb))];
  const lookups = new Map<string, TrackingLookup>();
  let calls = 0;
  let index = 0;
  async function worker(): Promise<void> {
    while (index < uniqueAwbs.length) {
      const awb = uniqueAwbs[index++]!;
      calls++;
      try {
        const tracking = await client.track(awb);
        lookups.set(awb, tracking?.currentStatus ? { attempted: true, status: tracking.currentStatus, error: null } : { attempted: true, status: null, error: "Shiprocket has no tracking information for this AWB yet" });
      } catch (error) {
        lookups.set(awb, { attempted: true, status: null, error: reasonOf(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(TRACKING_CONCURRENCY, uniqueAwbs.length) }, worker));
  return { lookups, calls };
}

export interface MatchApplyResult {
  outcome: RowOutcome;
  reason?: string;
  listStatus: string | null;
  trackingStatus: string | null;
  trackingError: string | null;
  crmStatus: ShipmentStatus | null;
}

/**
 * One discovered Shiprocket order/shipment, matched and (unless dryRun) applied. Matching order: an existing CRM
 * Shipment by Shiprocket shipment id, then by AWB, then by Shiprocket order id (all scoped to externalSource
 * SHIPROCKET, so a Shopify-derived row for the same parcel is never touched); only when none of those match is a
 * CRM Order looked up (by channel_order_id) to attach a brand-new Shipment row to.
 *
 * Status: GET /orders itself often reports only a numeric code (e.g. "7"), which mapShiprocketStatus() - built from
 * the tracking API's descriptive text - never recognises. `tracking.status`, when available, is tried FIRST; the raw
 * list status is only a fallback so nothing is lost when there is no AWB or the tracking lookup failed. Either way,
 * mapShiprocketStatus() itself is not touched or duplicated - never a new, invented numeric-code table.
 */
export async function matchAndApply(tx: Db, entry: ExistingShipment, tracking: TrackingLookup, opts: { dryRun: boolean }, deps: ApplyDeps): Promise<MatchApplyResult> {
  const identifiers: Prisma.ShipmentWhereInput[] = [];
  if (entry.shiprocketShipmentId) identifiers.push({ externalId: entry.shiprocketShipmentId });
  if (entry.awb) identifiers.push({ trackingNumber: entry.awb });
  identifiers.push({ providerOrderId: entry.shiprocketOrderId });

  const existing = await tx.shipment.findFirst({
    where: { externalSource: "SHIPROCKET", OR: identifiers },
    select: { id: true },
  });

  const providerStatus = tracking.status ?? entry.status;
  const mappedStatus = mapShiprocketStatus(providerStatus);
  const base = { listStatus: entry.status, trackingStatus: tracking.status, trackingError: tracking.error, crmStatus: mappedStatus };

  if (existing) {
    if (opts.dryRun) return { outcome: "updated", ...base };
    const result = await applyShipmentUpdate(
      tx,
      existing.id,
      { status: mappedStatus, providerStatus, awb: entry.awb, courier: entry.courierName, providerOrderId: entry.shiprocketOrderId, meta: { importedBy: "shiprocket:sync" } },
      { source: ActivitySource.SYSTEM, now: deps.now() },
    );
    return { outcome: result.outcome === "updated" ? "updated" : "skipped", ...base };
  }

  if (!entry.channelOrderId) return { outcome: "skipped", reason: "no channel order id to match against an existing CRM order", ...base };

  const candidates = orderRefCandidates(entry.channelOrderId);
  const order = await tx.order.findFirst({
    where: { OR: [{ orderNumber: { in: candidates } }, { externalNumber: { in: candidates } }] },
    select: { id: true, leadId: true, orderNumber: true, shipments: { where: { externalSource: "SHIPROCKET" }, select: { id: true, status: true } } },
  });
  if (!order) return { outcome: "skipped", reason: `no CRM order matches channel order id "${entry.channelOrderId}"`, ...base };

  // Never a second live Shiprocket shipment for the same order - the same rule shiprocket.shipments.service.ts's
  // own createShipment() enforces for a CRM-initiated shipment.
  if (order.shipments.some((s) => ACTIVE_SHIPMENT_STATUSES.has(s.status))) {
    return { outcome: "skipped", reason: `order ${order.orderNumber} already has a Shiprocket shipment in the CRM`, ...base };
  }

  if (opts.dryRun) return { outcome: "created", ...base };

  const now = deps.now();
  await advisoryLock(tx, shipmentOrderLockKey(order.id));
  const shipmentId = randomUUID();
  await tx.shipment.create({
    data: {
      id: shipmentId,
      orderId: order.id,
      status: mappedStatus ?? ShipmentStatus.CREATED,
      providerStatus,
      courier: entry.courierName,
      trackingNumber: entry.awb,
      externalSource: "SHIPROCKET",
      externalId: entry.shiprocketShipmentId ?? `sr-order:${entry.shiprocketOrderId}`,
      providerOrderId: entry.shiprocketOrderId,
      channelOrderId: entry.channelOrderId,
      expectedDeliveryAt: null,
      metadata: { shiprocket: { importedBy: "shiprocket:sync", importedAt: now.toISOString() } },
    },
  });
  await tx.activity.create({
    data: {
      leadId: order.leadId,
      orderId: order.id,
      actorId: null,
      actorRole: null,
      type: ActivityType.SHIPMENT_CREATED,
      referenceType: SHIPMENT_REFERENCE_TYPE,
      referenceId: shipmentId,
      source: ActivitySource.SYSTEM,
      title: `Existing Shiprocket shipment imported for order ${order.orderNumber}`,
      newValue: { status: mappedStatus ?? ShipmentStatus.CREATED, providerStatus, awb: entry.awb, courier: entry.courierName },
      metadata: { provider: "SHIPROCKET", providerShipmentId: entry.shiprocketShipmentId, importedBy: "shiprocket:sync" },
      createdAt: now,
    },
  });
  return { outcome: "created", ...base };
}

export interface BackfillDeps {
  client: ShiprocketApiForBackfill;
  runner: TxRunner;
  now?: () => Date;
  onProgress?: (discovered: number) => void;
  /** Pauses between retries of a throttled/failed page. Overridden in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One page, retried on a retryable provider error (429/5xx/timeout) before giving up on the whole run. `callCounter`
 * is incremented once per HTTP attempt (including retries and the final failing one) so the report can count real
 * Shiprocket calls made, not just successes - it is a plain mutable counter rather than a return value so the count
 * is preserved even when this ultimately throws.
 */
async function fetchPageWithRetry(client: ShiprocketApiForBackfill, params: { page: number; perPage: number; from: string; to: string }, sleep: (ms: number) => Promise<void>, callCounter: { count: number }) {
  for (let attempt = 1; ; attempt++) {
    callCounter.count++;
    try {
      return await client.listOrders(params);
    } catch (error) {
      const retryable = error instanceof ProviderHttpError && error.retryable;
      if (!retryable || attempt >= MAX_PAGE_ATTEMPTS) throw error;
      await sleep(Math.min(2 ** attempt * 1000, 10_000));
    }
  }
}

export async function runShiprocketBackfill(deps: BackfillDeps, options: BackfillOptions): Promise<BackfillReport> {
  const startedAt = performance.now();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const windows = chunkWindow(options.since, options.until);
  const report: BackfillReport = {
    connection: "FAIL",
    connectionError: null,
    windows,
    counts: { discovered: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
    failures: [],
    preview: [],
    databaseWrites: 0,
    apiCalls: { listOrders: 0, track: 0 },
    tracking: { withAwb: 0, succeeded: 0, failed: 0, descriptiveStatuses: [], unknownStatuses: [] },
    crmStatusCounts: {},
    elapsedMs: 0,
    fatalError: null,
  };
  if (windows.length === 0) {
    report.fatalError = "The window is empty: --since must not be after --until.";
    report.elapsedMs = performance.now() - startedAt;
    return report;
  }

  const descriptiveStatusesSeen = new Set<string>();
  const unknownStatusesSeen = new Set<string>();
  let remaining = options.limit ?? Number.POSITIVE_INFINITY;

  try {
    outer: for (const window of windows) {
      let page = 1;
      while (remaining > 0) {
        const perPage = Math.min(PAGE_SIZE, remaining === Number.POSITIVE_INFINITY ? PAGE_SIZE : remaining);
        const listOrdersCallCounter = { count: 0 };
        let result: Awaited<ReturnType<ShiprocketApiForBackfill["listOrders"]>>;
        try {
          result = await fetchPageWithRetry(deps.client, { page, perPage, from: window.from, to: window.to }, sleep, listOrdersCallCounter);
        } finally {
          report.apiCalls.listOrders += listOrdersCallCounter.count;
        }
        report.connection = "PASS"; // at least one call to Shiprocket succeeded
        if (result.shipments.length === 0) break; // this window is exhausted

        // Never resolve tracking (or apply) for more entries than --limit allows, even mid-page.
        const batch = remaining === Number.POSITIVE_INFINITY ? result.shipments : result.shipments.slice(0, remaining);

        const { lookups, calls } = await resolveTracking(deps.client, batch);
        report.apiCalls.track += calls;

        for (const entry of batch) {
          remaining--;
          report.counts.discovered++;
          deps.onProgress?.(report.counts.discovered);

          const tracking = entry.awb ? (lookups.get(entry.awb) ?? { attempted: true, status: null, error: "tracking lookup was not attempted" }) : NOT_APPLICABLE;
          if (entry.awb) {
            report.tracking.withAwb++;
            if (tracking.status) {
              report.tracking.succeeded++;
              descriptiveStatusesSeen.add(tracking.status);
              if (!mapShiprocketStatus(tracking.status)) unknownStatusesSeen.add(tracking.status);
            } else if (tracking.error) {
              report.tracking.failed++;
            }
          }

          try {
            const applied = await deps.runner.$transaction((tx) => matchAndApply(tx, entry, tracking, { dryRun: options.dryRun }, { now }));
            report.counts[applied.outcome]++;
            const crmStatusKey = applied.crmStatus ?? "UNMAPPED";
            report.crmStatusCounts[crmStatusKey] = (report.crmStatusCounts[crmStatusKey] ?? 0) + 1;
            if (options.dryRun && report.preview.length < 20) {
              report.preview.push({
                shiprocketOrderId: entry.shiprocketOrderId,
                awb: entry.awb,
                listStatus: applied.listStatus,
                trackingStatus: applied.trackingStatus,
                trackingError: applied.trackingError,
                crmStatus: applied.crmStatus,
                channelOrderId: entry.channelOrderId,
                outcome: applied.reason ? `${applied.outcome} - ${applied.reason}` : applied.outcome,
              });
            }
            if (applied.reason && applied.outcome === "skipped") report.failures.push({ ref: entry.shiprocketOrderId, reason: applied.reason });
          } catch (error) {
            report.counts.failed++;
            report.failures.push({ ref: entry.shiprocketOrderId, reason: reasonOf(error) });
          }
        }

        if (remaining <= 0) break outer;
        if (result.lastPage !== null && page >= result.lastPage) break;
        if (result.shipments.length < perPage) break; // short page: no more data even without a page count
        page++;
      }
    }
  } catch (error) {
    report.fatalError = safeMessage(reasonOf(error));
    if (report.connection !== "PASS") report.connectionError = report.fatalError;
  }

  report.tracking.descriptiveStatuses = [...descriptiveStatusesSeen];
  report.tracking.unknownStatuses = [...unknownStatusesSeen];
  report.databaseWrites = options.dryRun ? 0 : report.counts.created + report.counts.updated;
  report.elapsedMs = performance.now() - startedAt;
  return report;
}
