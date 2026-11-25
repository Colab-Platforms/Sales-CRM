import type { Prisma } from "../../../generated/prisma/client.js";
import { ActivitySource, ActivityType, OrderStatus } from "../../../generated/prisma/enums.js";
import { logger } from "@/utils/logger.js";
import { ShopifyClient } from "./shopify.client.js";
import { loadShopifyConfig } from "./shopify.config.js";
import { listOrdersForDisplay, type NormalizedOrderListItem } from "./shopify.orders.js";
import { shopifyOrderIdVariants, gidToId } from "./shopify.money.js";

// SHOPIFY CANCELLATION -> CRM. Production runs with the full Shopify sync OFF (website orders are read live from Shopify and never imported), and no Shopify webhook has ever reached the CRM. So an order a
// telecaller created in the CRM and pushed to Shopify keeps its CRM status (CONFIRMED) for ever when someone cancels it in Shopify - the CRM Reports then keep counting it as a sale.
//
// This closes exactly that gap and nothing else: it looks at orders Shopify changed recently, and for each one that Shopify has CANCELLED and the CRM already holds in a live status, it marks the CRM order
// CANCELLED (keeping the previous status so the CRM's own "undo cancellation" works) and records an activity. It NEVER imports an order, creates a lead, touches items / payments / shipments, sends a
// message, or writes anything to Shopify. An order the CRM does not hold (a website order) is ignored. Repeating it is harmless: an order already CANCELLED is skipped.

/** A CRM order in one of these is left alone: it is already cancelled, or a return / refund has already settled it. */
export const CANCEL_SKIPS: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.RETURNED, OrderStatus.REFUNDED];

type CrmRow = { id: string; leadId: string; externalId: string | null; orderNumber: string; externalNumber: string | null; status: OrderStatus; metadata: unknown };

export interface CancelSyncDb {
  order: {
    findMany(args: unknown): Promise<CrmRow[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  activity: { create(args: unknown): Promise<unknown> };
}

export interface CancelSyncResult {
  /** Orders Shopify reports cancelled in the window. */
  shopifyCancelled: number;
  /** Of those, held by the CRM in a live status and now (or, in a dry run, would be) marked CANCELLED. */
  cancelled: number;
  alreadyCancelled: number;
  /** Not a CRM order (website order): ignored, by design. */
  notInCrm: number;
  /** Order numbers only (never customer data), for an operator's dry run. */
  orderNumbers: string[];
}

export interface CancelSyncConfig {
  intervalMinutes: number;
  lookbackHours: number;
}

/** Cancellations are picked up within one interval. The look-back only has to cover the time the server was down; it is deliberately short so a deploy never rewrites old history. */
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_LOOKBACK_HOURS = 6;
const MAX_LOOKBACK_HOURS = 24 * 14;
const MAX_PAGES = 40;
const ID_CHUNK = 500;

/** null = off. On by default (it needs only the Shopify credentials the CRM already has); SHOPIFY_CANCEL_SYNC_POLL_MINUTES=0 switches it off. */
export function loadCancelSyncConfig(env: Record<string, string | undefined> = process.env): CancelSyncConfig | null {
  const number = (v: string | undefined, fallback: number) => {
    const n = Number((v ?? "").trim());
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const intervalMinutes = number(env.SHOPIFY_CANCEL_SYNC_POLL_MINUTES, DEFAULT_INTERVAL_MINUTES);
  if (intervalMinutes === 0) return null;
  return {
    intervalMinutes: Math.max(intervalMinutes, 1),
    lookbackHours: Math.min(Math.max(number(env.SHOPIFY_CANCEL_SYNC_LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS), 1), MAX_LOOKBACK_HOURS),
  };
}

type ShopifyQuery = Pick<ShopifyClient, "query">;

/** Every order Shopify changed at or after `since` that is cancelled. Paged; by Shopify id so a repeated row counts once. */
export async function fetchCancelledSince(client: ShopifyQuery, since: Date): Promise<NormalizedOrderListItem[]> {
  const search = `updated_at:>='${since.toISOString()}'`;
  const seen = new Map<string, NormalizedOrderListItem>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = await listOrdersForDisplay(client as ShopifyClient, { first: 100, after, search });
    for (const o of p.items) if (o.cancelledAt) seen.set(o.externalId, o);
    after = p.endCursor;
    if (!p.hasNextPage || !after) return [...seen.values()];
  }
  throw new Error("Shopify cancel sync: too many changed orders in the window; shorten the look-back");
}

/** Applies Shopify's cancellations to the CRM orders that exist. `dryRun` only reports. */
export async function applyShopifyCancellations(
  db: CancelSyncDb,
  cancelled: readonly Pick<NormalizedOrderListItem, "externalId" | "cancelledAt">[],
  opts: { dryRun?: boolean; now?: () => Date } = {},
): Promise<CancelSyncResult> {
  const now = opts.now ?? (() => new Date());
  const result: CancelSyncResult = { shopifyCancelled: cancelled.length, cancelled: 0, alreadyCancelled: 0, notInCrm: 0, orderNumbers: [] };
  const byId = new Map(cancelled.map((o) => [o.externalId, o]));
  const crm = new Map<string, CrmRow>();
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db.order.findMany({
      where: { externalSource: "SHOPIFY", externalId: { in: ids.slice(i, i + ID_CHUNK).flatMap((id) => shopifyOrderIdVariants(id)) } },
      select: { id: true, leadId: true, externalId: true, orderNumber: true, externalNumber: true, status: true, metadata: true },
    });
    for (const r of rows) if (r.externalId) crm.set(gidToId(r.externalId), r);
  }
  for (const [externalId, shop] of byId) {
    const row = crm.get(externalId);
    if (!row) {
      result.notInCrm++;
      continue;
    }
    if (CANCEL_SKIPS.includes(row.status)) {
      if (row.status === OrderStatus.CANCELLED) result.alreadyCancelled++;
      continue;
    }
    if (opts.dryRun) {
      result.orderNumbers.push(row.orderNumber);
      result.cancelled++;
      continue;
    }
    const previous = row.status;
    const cancelledAt = new Date(shop.cancelledAt!);
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    // Conditional on the status read above: if the CRM (or another run) cancelled it meanwhile, nothing is written.
    const done = await db.order.updateMany({
      where: { id: row.id, status: previous },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt,
        metadata: {
          ...meta,
          preCancelStatus: meta.preCancelStatus ?? previous,
          shopifyCancelSync: { at: now().toISOString(), shopifyCancelledAt: cancelledAt.toISOString(), previousStatus: previous },
        } as Prisma.InputJsonValue,
      },
    });
    if (done.count !== 1) continue;
    result.cancelled++;
    result.orderNumbers.push(row.orderNumber);
    const label = row.externalNumber ?? row.orderNumber;
    await db.activity.create({
      data: {
        leadId: row.leadId,
        orderId: row.id,
        type: ActivityType.ORDER_CANCELLED,
        referenceType: "Order",
        referenceId: row.id,
        title: `Order ${label} cancelled in Shopify`,
        description: `${previous} -> CANCELLED (cancelled in Shopify; CRM status brought in line)`,
        oldValue: { status: previous },
        newValue: { status: OrderStatus.CANCELLED },
        source: ActivitySource.SHOPIFY_SYNC,
        createdAt: cancelledAt,
      },
    });
  }
  return result;
}

/** One pass: read Shopify, apply to the CRM. */
export async function runCancelSync(db: CancelSyncDb, client: ShopifyQuery, config: Pick<CancelSyncConfig, "lookbackHours">, opts: { dryRun?: boolean; now?: () => Date } = {}): Promise<CancelSyncResult> {
  const now = opts.now ?? (() => new Date());
  const cancelled = await fetchCancelledSince(client, new Date(now().getTime() - config.lookbackHours * 3_600_000));
  return applyShopifyCancellations(db, cancelled, opts);
}

/** The periodic job. Never throws; a failed pass is logged and the next one tries again. Overlap-safe. */
export function startCancelSyncJob(db: CancelSyncDb, config: CancelSyncConfig | null = loadCancelSyncConfig()) {
  if (!config) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const client = new ShopifyClient(loadShopifyConfig());
      const r = await runCancelSync(db, client, config);
      if (r.cancelled > 0) logger.info(`Shopify cancel sync: ${r.cancelled} CRM order(s) marked cancelled (${r.orderNumbers.join(", ")})`);
    } catch (error) {
      logger.error("Shopify cancel sync failed", error instanceof Error ? error.message.split("\n")[0] : "unknown error");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 90_000);
  const timer = setInterval(() => void tick(), config.intervalMinutes * 60_000);
  first.unref();
  timer.unref();
  logger.info(`Shopify cancel sync started (every ${config.intervalMinutes} min, look-back ${config.lookbackHours} h)`);
  return { tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}
