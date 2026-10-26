import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import { OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import { ShopifyApiError, ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { mapListOrderStatusAndPayments } from "../shopify/shopify.mapper.js";
import { gidToId, shopifyOrderIdVariants, toCents } from "../shopify/shopify.money.js";
import { countRecords, listOrdersForDisplay, type NormalizedOrderListItem } from "../shopify/shopify.orders.js";
import { derivePaymentMode, derivePaymentStatus } from "./orders.filters.js";
import { isCreatorTag } from "./orders.creator-tag.js";

// LIVE WEBSITE ORDERS. The Website Orders dashboard reads the orders straight from the Shopify Admin API for the selected range and works them out in memory.
// READ-ONLY and STORAGE-FREE: only GraphQL queries are sent (never a mutation), and nothing fetched is written to the database. The only database access is one SELECT that asks which of
// the fetched Shopify ids are orders a telecaller created in the CRM (so they can be left out). The result is kept in process memory for a few seconds so the cards, the chart and the
// clicked list of one page view share one fetch; it is never persisted.
//
// WEBSITE vs TELECALLER (no guessing from names): an order is a telecaller order when
//   - it carries the "Order Created by <name>" tag the CRM adds to every order a telecaller creates (orders.creator-tag.ts), or
//   - the CRM holds that Shopify id on an order whose source is not SHOPIFY / WEBSITE (a telecaller order that was pushed to Shopify keeps its one CRM row).
// Everything else in Shopify is a website order.

export const LIVE_PAGE_SIZE = 100;
/** More orders than this in one range are refused with an explanation (about 1 s per 100 orders): the totals are never silently cut short. */
export const MAX_LIVE_ORDERS = 5000;
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 6;
const ID_CHUNK = 1000;
const PRIMARY_CURRENCY = "INR";

export interface LiveOrder {
  externalId: string;
  name: string;
  createdAt: Date;
  /** The calendar day in the business timezone (YYYY-MM-DD) the order was created on. */
  localDate: string;
  customerName: string | null;
  phone: string | null;
  currency: string;
  totalCents: number;
  refundedCents: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
  paymentMode: "COD" | "PREPAID" | null;
}

export interface LiveFetch {
  /** Website orders only. */
  orders: LiveOrder[];
  /** Telecaller-created orders found in the same Shopify range and left out. */
  telecallerExcluded: number;
  /** Every order Shopify returned for the range (website + telecaller). */
  shopifyOrders: number;
  /** Shopify's own count for the range (null when it could not be asked). */
  shopifyCount: number | null;
  pages: number;
  fetchedAt: Date;
  /** Things the viewer must know about (never empty-handedly hidden): a failed CRM lookup, a count mismatch, a non-INR order. */
  warnings: string[];
}

export interface LiveRange {
  start: Date;
  end: Date;
  timezone: string;
}

type ShopifyQuery = Pick<ShopifyClient, "query">;

export interface LiveSourceOptions {
  db: Pick<DbClient, "order">;
  /** Builds the Shopify client on first use; throws when Shopify is not configured. */
  client?: () => ShopifyQuery;
  now?: () => Date;
  ttlMs?: number;
  maxOrders?: number;
}

const dayFormatter = new Map<string, Intl.DateTimeFormat>();
export function localDate(at: Date, timeZone: string): string {
  let f = dayFormatter.get(timeZone);
  if (!f) dayFormatter.set(timeZone, (f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(at);
}

/** The Shopify search for the range: created at or after `start`, before `end` (exact instants, so the IST day boundaries are the ones asked for). */
export const rangeSearch = (r: Pick<LiveRange, "start" | "end">): string => `created_at:>='${r.start.toISOString()}' created_at:<'${r.end.toISOString()}'`;

export function toLiveOrder(o: NormalizedOrderListItem, timezone: string): LiveOrder {
  // The same status / payment derivation the Shopify sync and the live Orders list use, so a figure here can never disagree with what the order would show once synced.
  const { status, payments } = mapListOrderStatusAndPayments({
    id: o.id,
    currency: o.currency ?? PRIMARY_CURRENCY,
    cancelledAt: o.cancelledAt,
    financialStatus: o.financialStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    returnStatus: o.returnStatus,
    fulfillments: o.fulfillments,
    tags: o.tags,
    paymentGateways: o.paymentGateways,
    transactions: o.transactions,
    amounts: { subtotal: null, discount: null, tax: null, shipping: null, total: o.totalAmount, refunded: o.refundedAmount },
    processedAt: o.processedAt,
    updatedAt: o.createdAt,
  });
  const created = new Date(o.createdAt);
  return {
    externalId: o.externalId,
    name: o.name,
    createdAt: created,
    localDate: localDate(created, timezone),
    customerName: o.customerName,
    phone: o.customerPhone,
    currency: o.currency ?? PRIMARY_CURRENCY,
    // Shopify's order total: what the customer is charged (items - discounts + shipping + tax). Whole cents, so sums never drift.
    totalCents: toCents(o.totalAmount),
    refundedCents: toCents(o.refundedAmount),
    status,
    paymentStatus: derivePaymentStatus(payments),
    paymentMode: derivePaymentMode(payments),
  };
}

/** Maps a failed Shopify call to an error the viewer can act on. Never carries the token. */
export function liveError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const status = error instanceof ShopifyApiError ? error.status : null;
  if (status === 429 || (error instanceof Error && /rate limit|throttl/i.test(error.message))) {
    return new ApiError("Shopify is rate limiting requests right now. No figures are shown - wait a minute and try again.", 429);
  }
  if (error instanceof Error && /not configured|SHOPIFY_/i.test(error.message) && !(error instanceof ShopifyApiError)) {
    return new ApiError("Shopify is not configured on the server, so live website orders cannot be loaded.", 503);
  }
  return new ApiError("Shopify could not be reached or returned an error, so website orders could not be loaded. No figures are shown - try again shortly.", 502);
}

export class LiveWebsiteOrders {
  private readonly cache = new Map<string, { at: number; value: Promise<LiveFetch> }>();
  private client: ShopifyQuery | null = null;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxOrders: number;

  constructor(private readonly options: LiveSourceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.maxOrders = options.maxOrders ?? MAX_LIVE_ORDERS;
  }

  private shopify(): ShopifyQuery {
    if (!this.client) this.client = this.options.client ? this.options.client() : new ShopifyClient(loadShopifyConfig(process.env));
    return this.client;
  }

  /** The website orders created in [start, end): fetched live, shared for a few seconds between concurrent requests for the same range. */
  fetch(range: LiveRange): Promise<LiveFetch> {
    const key = `${range.start.getTime()}|${range.end.getTime()}|${range.timezone}`;
    const hit = this.cache.get(key);
    if (hit && this.now().getTime() - hit.at < this.ttlMs) return hit.value;
    const value = this.load(range).catch((error) => {
      this.cache.delete(key); // a failure is never remembered
      throw liveError(error);
    });
    this.cache.set(key, { at: this.now().getTime(), value });
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  private async load(range: LiveRange): Promise<LiveFetch> {
    const client = this.shopify();
    const search = rangeSearch(range);
    const counted = await countRecords(client as ShopifyClient, "orders", search);
    const shopifyCount = counted.exact ? counted.count : null;
    if (shopifyCount !== null && shopifyCount > this.maxOrders) {
      throw new ApiError(
        `Shopify holds ${shopifyCount.toLocaleString("en-IN")} orders in this date range; the live view can load at most ${this.maxOrders.toLocaleString("en-IN")} at a time. Choose a shorter range so the totals are complete.`,
        422,
        { code: "RANGE_TOO_LARGE", shopifyCount, limit: this.maxOrders },
      );
    }

    const seen = new Map<string, NormalizedOrderListItem>();
    let after: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await listOrdersForDisplay(client as ShopifyClient, { first: LIVE_PAGE_SIZE, after, search });
      pages++;
      for (const item of page.items) {
        const at = new Date(item.createdAt);
        if (at >= range.start && at < range.end) seen.set(item.externalId, item); // by Shopify id: an order can never be counted twice
      }
      if (seen.size > this.maxOrders) {
        throw new ApiError(`This date range holds more than ${this.maxOrders.toLocaleString("en-IN")} orders; choose a shorter range so the totals are complete.`, 422, { code: "RANGE_TOO_LARGE", limit: this.maxOrders });
      }
      after = page.endCursor;
      if (!page.hasNextPage || !after) break;
    }

    const warnings: string[] = [];
    const items = [...seen.values()];
    const byCrm = await this.crmCreated(items.map((i) => i.externalId), warnings);
    const website: LiveOrder[] = [];
    let telecaller = 0;
    for (const item of items) {
      if (item.tags.some(isCreatorTag) || byCrm.has(item.externalId)) telecaller++;
      else website.push(toLiveOrder(item, range.timezone));
    }
    website.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.externalId < b.externalId ? 1 : -1));

    if (shopifyCount !== null && shopifyCount !== items.length) {
      warnings.push(`Shopify reported ${shopifyCount.toLocaleString("en-IN")} orders for this range but ${items.length.toLocaleString("en-IN")} were read; orders placed or changed while loading can cause a small difference. Refresh to re-check.`);
    }
    const foreign = new Set(website.filter((o) => o.currency !== PRIMARY_CURRENCY).map((o) => o.currency));
    if (foreign.size > 0) warnings.push(`Some orders are not in ${PRIMARY_CURRENCY} (${[...foreign].join(", ")}); their amounts are left out of the value totals.`);

    return { orders: website, telecallerExcluded: telecaller, shopifyOrders: items.length, shopifyCount, pages, fetchedAt: this.now(), warnings };
  }

  /** READ-ONLY lookup: which of these Shopify order ids are CRM orders created by someone other than the storefront (telecaller / API). */
  private async crmCreated(ids: string[], warnings: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const variants = ids.slice(i, i + ID_CHUNK).flatMap((id) => shopifyOrderIdVariants(id));
        const rows = await this.options.db.order.findMany({
          where: { externalSource: "SHOPIFY", externalId: { in: variants }, source: { notIn: ["SHOPIFY", "WEBSITE"] } },
          select: { externalId: true },
        });
        for (const r of rows) if (r.externalId) out.add(gidToId(r.externalId));
      }
    } catch {
      warnings.push("The CRM could not be checked for telecaller-created orders, so only orders carrying the \"Order Created by\" tag were left out. Refresh to retry.");
    }
    return out;
  }
}
