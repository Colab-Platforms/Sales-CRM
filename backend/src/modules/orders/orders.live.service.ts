// Live Orders list: reads directly from Shopify (via the existing ShopifyClient - see
// shopify.orders.ts's listOrdersForDisplay) instead of the CRM's own synced Order table, per the
// "CRM should display real Shopify data directly" requirement. CRM-owned fields (salesperson, lead
// number, CRM order id) are joined in afterwards from the CRM DB, by the already-synced Order row's
// externalId (shopify.persist.ts writes this on every sync - unchanged, unduplicated here).
//
// Deliberately NOT changed by this module: Order Detail, Customer 360, Previous Orders, and the
// original DB-backed GET /orders endpoint (OrdersService.listOrders) - all untouched, still exist,
// still work exactly as before. This is an additive, parallel read path for the Orders LIST page only.
import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient, ShopifyApiError } from "../shopify/shopify.client.js";
import { normalizeShopifyOrderId, shopifyOrderIdVariants } from "../shopify/shopify.money.js";
import { syncOrderById, type SyncDeps } from "../shopify/shopify.sync.js";
import { createCashfreeAutoVerifyHook } from "../refunds/refunds.autoverify.js";
import type { TxRunner } from "../shopify/shopify.persist.js";
import { ActivitySource } from "../../../generated/prisma/enums.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { checkConnection, fetchOrder, listOrdersForDisplay, type NormalizedOrderListItem } from "../shopify/shopify.orders.js";
import { DEFAULT_START_DATE, resolveWindow, windowSearch, type WindowSpec } from "../shopify/shopify.window.js";
import { cancelShopifyOrder, ShopifyOrderCancelError } from "../shopify/shopify.orders.write.js";
import { getLiveTrackingBatch } from "../shiprocket/shiprocket.live-tracking.js";
import { mapListOrderStatusAndPayments } from "../shopify/shopify.mapper.js";
import { derivePaymentMode, derivePaymentStatus, fullName } from "./orders.filters.js";
import { matchesAnyTag, mergeOrderTags, tagSearchClause } from "./orders.tags.js";
import { confirmationTagFor } from "./orders.confirmation.js";
import {
  LIVE_ORDER_ID_PREFIX,
  type LiveOrderCancelResult,
  type LiveOrderCrmLink,
  type LiveOrderDetailResult,
  type LiveOrderHistoryQuery,
  type LiveOrderHistoryResult,
  type LiveOrderListItem,
  type LiveOrderListResult,
  type LiveOrderSyncResult,
  type LiveOrdersQuery,
  type LiveOrderTagOptionsResult,
} from "./orders.live.types.js";

// ---- A small in-process TTL cache (same idiom as OrdersService's own static idempotency Map) - no
// Redis/cache infra exists in this backend today (confirmed by audit), and one page of Shopify orders
// is cheap enough to keep in memory for a short window so a repeated identical search (the same
// filters, e.g. from a page refresh or a user re-opening the tab) doesn't re-hit Shopify every time. ----
interface CacheEntry {
  value: LiveOrderListResult;
  expiresAt: number;
}
const CACHE_TTL_MS = 30_000;
const listCache = new Map<string, CacheEntry>();

// Same idiom, for the customer order-history call a live Order Detail page makes ("Previous Orders").
interface HistoryCacheEntry {
  value: LiveOrderHistoryResult;
  expiresAt: number;
}
const historyCache = new Map<string, HistoryCacheEntry>();

/** Drops the cached live list/history pages. They embed the CRM overlay (status, payment...), so a CRM-side change such
 *  as cancel/revert must call this or the Orders list keeps showing the old status for up to CACHE_TTL_MS. */
export function clearLiveOrderCaches(): void {
  listCache.clear();
  historyCache.clear();
}

// The shop's own timezone rarely changes - cached much longer, and shared across all callers/roles
// (it is not RBAC-sensitive, unlike the order list itself).
let shopTimeZoneCache: { value: string; expiresAt: number } | null = null;
const TIMEZONE_TTL_MS = 60 * 60_000;

async function resolveShopTimeZone(client: ShopifyClient): Promise<string> {
  if (shopTimeZoneCache && shopTimeZoneCache.expiresAt > Date.now()) return shopTimeZoneCache.value;
  const info = await checkConnection(client);
  const timeZone = info.timeZone ?? "UTC";
  shopTimeZoneCache = { value: timeZone, expiresAt: Date.now() + TIMEZONE_TTL_MS };
  return timeZone;
}

const FILTER_EXTRA_PAGES = 3;

// Shopify's own list of the shop's most-used order tags (up to 250) - the source of the Tags filter's options. Cached briefly.
const SHOP_ORDER_TAGS_QUERY = `query crmOrderTagOptions { shop { orderTags(first: 250, sort: POPULAR) { edges { node } } } }`;
const TAG_OPTIONS_TTL_MS = 5 * 60_000;
let tagOptionsCache: { value: string[]; expiresAt: number } | null = null;

type OverlayFilters = Pick<LiveOrdersQuery, "status" | "paymentStatus" | "paymentMode" | "source" | "salespersonId" | "leadSourceId" | "fulfillment" | "totalMin" | "totalMax" | "tags">;

const toList = <T,>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

export function hasOverlayFilters(f: OverlayFilters): boolean {
  return Boolean(toList(f.status).length || toList(f.paymentStatus).length || toList(f.paymentMode).length || toList(f.source).length || toList(f.salespersonId).length || toList(f.leadSourceId).length || toList(f.fulfillment).length || f.totalMin !== undefined || f.totalMax !== undefined);
}

/**
 * The single place column filters are evaluated. Different filters are AND-ed; values inside one filter are OR-ed.
 * Everything is compared against what the row actually shows (CRM status/payment where linked, Shopify-derived where not),
 * so a row can never match a filter it doesn't display. Total is compared as a number, never as formatted text.
 */
export function applyOrderFilters(items: LiveOrderListItem[], filters: OverlayFilters): LiveOrderListItem[] {
  // Tags: Shopify has already narrowed the page by `tag:` (the search below); this makes the row match exactly what it DISPLAYS
  // (the CRM confirmer is authoritative over a stale Shopify confirmation tag). Tags are not a CRM-overlay filter, so they do
  // not trigger the extra-page loop.
  const wantedTags = toList(filters.tags);
  if (wantedTags.length) items = items.filter((item) => matchesAnyTag(item.tags, wantedTags));
  if (!hasOverlayFilters(filters)) return items;
  const status = toList(filters.status);
  const paymentStatus = toList(filters.paymentStatus);
  const paymentMode = toList(filters.paymentMode);
  const source = toList(filters.source);
  const salespersonId = toList(filters.salespersonId);
  const leadSourceId = toList(filters.leadSourceId);
  const fulfillment = toList(filters.fulfillment);
  return items.filter((item) => {
    if (status.length && !(item.status !== null && status.includes(item.status))) return false;
    if (paymentStatus.length && !paymentStatus.some((p) => (p === "NONE" ? item.paymentStatus === null : item.paymentStatus === p))) return false;
    if (paymentMode.length && !(item.paymentMode !== null && paymentMode.includes(item.paymentMode))) return false;
    if (source.length && !source.includes(item.source)) return false;
    if (salespersonId.length && !(item.salesperson && salespersonId.includes(item.salesperson.id))) return false;
    if (leadSourceId.length && !(item.leadSource && leadSourceId.includes(item.leadSource.id))) return false;
    if (fulfillment.length && !(item.fulfillmentStatus && fulfillment.includes(item.fulfillmentStatus))) return false;
    if (filters.totalMin !== undefined || filters.totalMax !== undefined) {
      const total = Number(item.totalAmount);
      if (!Number.isFinite(total)) return false;
      if (filters.totalMin !== undefined && total < filters.totalMin) return false;
      if (filters.totalMax !== undefined && total > filters.totalMax) return false;
    }
    return true;
  });
}

class OrdersLiveService {
  // getShopifyClient is injectable so tests never construct a real client (same pattern OrdersService
  // itself already uses for pushOrderToShopify/cancelOrder).
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => ShopifyClient = () => new ShopifyClient(loadShopifyConfig()),
    private readonly runner: TxRunner = prisma,
    private readonly syncOrder: typeof syncOrderById = syncOrderById,
    /** The post-sync step (read Shopify's refundable amount, verify the Cashfree payment). Injectable so tests never reach Shopify or Cashfree. */
    private readonly makeAfterCommit: (client: ShopifyClient, runner: TxRunner) => SyncDeps["afterCommit"] = (client, runner) => createCashfreeAutoVerifyHook(client, runner),
  ) {}

  async listLiveOrders(user: AuthUser, query: LiveOrdersQuery): Promise<LiveOrderListResult> {
    const cacheKey = JSON.stringify({
      role: user.role,
      userId: user.id, // RBAC-sensitive: two different salespeople must never share a cached page.
      after: query.after ?? null,
      first: query.first,
      search: query.search ?? null,
      dateFrom: query.dateFrom?.toISOString() ?? null,
      dateTo: query.dateTo?.toISOString() ?? null,
      status: toList(query.status),
      paymentStatus: toList(query.paymentStatus),
      paymentMode: toList(query.paymentMode),
      source: toList(query.source),
      salespersonId: toList(query.salespersonId),
      leadSourceId: toList(query.leadSourceId),
      fulfillment: toList(query.fulfillment),
      totalMin: query.totalMin ?? null,
      totalMax: query.totalMax ?? null,
      tags: toList(query.tags),
    });
    const cached = listCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: error instanceof ShopifyConfigError ? error.message : "Shopify is not configured." };
    }

    const overlayFilters = {
      status: query.status,
      paymentStatus: query.paymentStatus,
      paymentMode: query.paymentMode,
      source: query.source,
      salespersonId: query.salespersonId,
      leadSourceId: query.leadSourceId,
      fulfillment: query.fulfillment,
      totalMin: query.totalMin,
      totalMax: query.totalMax,
      tags: query.tags,
    };
    const filtering = hasOverlayFilters(overlayFilters);

    let page;
    try {
      const timeZone = await resolveShopTimeZone(client);
      const spec: WindowSpec = {
        from: query.dateFrom ? { kind: "instant", at: query.dateFrom } : null,
        to: query.dateTo ? { kind: "instant", at: query.dateTo } : null,
        updatedSince: null,
      };
      const window = resolveWindow(spec, DEFAULT_START_DATE, timeZone, new Date());
      // Shopify ANDs space-separated terms by default, and its own default (unprefixed) search
      // already covers order name/customer name/email/phone - so the free-text term is simply
      // appended to the date-window terms rather than the CRM's own 5-field search being reimplemented
      // against a system that has no idea what a "lead number" is.
      // Tags are matched by Shopify itself (exact tag, OR across the chosen tags), so pagination follows the filtered set.
      const search = [windowSearch(window), tagSearchClause(toList(query.tags)), query.search?.trim()].filter(Boolean).join(" ");
      page = await listOrdersForDisplay(client, { first: query.first, after: query.after ?? null, search });

      // Column filters are applied to rows AFTER the CRM overlay, so a sparse filter could leave a Shopify page nearly empty.
      // To keep the page useful without ever loading the whole history, keep reading further Shopify pages (a small, fixed
      // number) until `first` matching rows are found or Shopify has no more - the returned cursor always continues from
      // the last page actually read, so Next carries on exactly where this stopped.
      if (filtering) {
        const collected = [...(await this.attachCrmOverlay(user, page.items, page.hasNextPage, page.hasPreviousPage, page.endCursor, overlayFilters)).items];
        let last = page;
        for (let extra = 0; extra < FILTER_EXTRA_PAGES && collected.length < query.first && last.hasNextPage && last.endCursor; extra++) {
          last = await listOrdersForDisplay(client, { first: query.first, after: last.endCursor, search });
          collected.push(...(await this.attachCrmOverlay(user, last.items, last.hasNextPage, last.hasPreviousPage, last.endCursor, overlayFilters)).items);
        }
        const result: LiveOrderListResult = { items: collected, pageInfo: { hasNextPage: last.hasNextPage, hasPreviousPage: page.hasPreviousPage, endCursor: last.endCursor } };
        listCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
        return result;
      }
    } catch (error) {
      const message = error instanceof ShopifyApiError ? error.message : "Could not reach Shopify - please try again.";
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: message };
    }

    const result = await this.attachCrmOverlay(user, page.items, page.hasNextPage, page.hasPreviousPage, page.endCursor, overlayFilters);
    listCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  // Joins the CRM's own Order/Lead rows (already synced via the existing Shopify webhook/backfill -
  // see shopify.persist.ts) onto the live Shopify page, by externalId. Never creates or updates
  // anything: a purely read-only overlay for salesperson/lead-number/CRM order id.
  //
  // RBAC: Shopify has no concept of "which salesperson owns this customer" - only the CRM does, via
  // Lead ownership. A live Shopify order that has NOT yet been synced into the CRM (no matching
  // externalId - e.g. a webhook still in flight) has no lead to check scope against, so it is hidden
  // entirely from non-ADMIN roles (never shown as "unowned" and never guessed at) and shown to ADMIN
  // only, clearly flagged (linkedInCrm: false). A synced order whose lead falls outside the caller's
  // scope is also excluded, exactly like the DB-backed listOrders already does via scopedOrderWhere.
  private async attachCrmOverlay(
    user: AuthUser,
    shopifyItems: NormalizedOrderListItem[],
    hasNextPage: boolean,
    hasPreviousPage: boolean,
    endCursor: string | null,
    overlayFilters: OverlayFilters,
  ): Promise<LiveOrderListResult> {
    if (shopifyItems.length === 0) {
      return { items: [], pageInfo: { hasNextPage, hasPreviousPage, endCursor } };
    }

    let leadScope: Prisma.LeadWhereInput = {};
    try {
      leadScope = await getLeadScope(user, this.db);
    } catch {
      // getManagerTeam can only fail on a DB error - fail closed (no CRM overlay, and non-ADMIN sees
      // nothing) rather than silently granting unscoped access.
      if (user.role !== Role.ADMIN) return { items: [], pageInfo: { hasNextPage, hasPreviousPage, endCursor }, partialError: "Could not verify your access scope - please retry." };
    }

    const externalIds = shopifyItems.map((o) => o.externalId);
    let crmRows: Awaited<ReturnType<typeof this.fetchCrmRows>> = [];
    let partialError: string | undefined;
    try {
      crmRows = await this.fetchCrmRows(externalIds);
    } catch {
      partialError = "Salesperson/lead details could not be loaded for this page - showing Shopify data only.";
    }
    // Keyed by the canonical numeric id, so a legacy row holding the GID form (an order the CRM pushed to Shopify) is still found.
    const byExternalId = new Map(crmRows.map((row) => [normalizeShopifyOrderId(row.externalId!), row]));

    // For a MANAGER/SALESPERSON, an in-scope check needs to be evaluated per-lead - cheapest as a
    // second, tiny query for just the lead ids already found above, reusing the exact same leadScope
    // Prisma.LeadWhereInput every other RBAC-scoped read in this codebase already uses.
    const leadIds = [...new Set(crmRows.map((r) => r.lead.id))];
    const inScopeLeadIds = user.role === Role.ADMIN || leadIds.length === 0
      ? new Set(leadIds)
      : new Set((await this.db.lead.findMany({ where: { id: { in: leadIds }, ...leadScope }, select: { id: true } })).map((l) => l.id));

    const items: LiveOrderListItem[] = [];
    for (const shopifyOrder of shopifyItems) {
      const crm = byExternalId.get(normalizeShopifyOrderId(shopifyOrder.externalId)) ?? null;
      const linkedInCrm = Boolean(crm);

      if (!linkedInCrm) {
        // Not yet synced into the CRM at all - only ADMIN can see it (see the RBAC note above).
        if (user.role !== Role.ADMIN) continue;
        items.push(this.mapUnlinked(shopifyOrder));
        continue;
      }
      if (!inScopeLeadIds.has(crm!.lead.id) && user.role !== Role.ADMIN) continue; // out of this caller's scope

      items.push(this.mapLinked(shopifyOrder, crm!));
    }

    const filtered = this.applyOverlayFilters(items, overlayFilters);
    return { items: filtered, pageInfo: { hasNextPage, hasPreviousPage, endCursor }, partialError };
  }

  // status/paymentStatus/source/salespersonId are all CRM-owned - Shopify's own order list has no
  // concept of any of them, so they can only be applied here, after the CRM overlay above has already
  // run. An unlinked order never matches any of them (it has no CRM status/salesperson to compare
  // against) and is always excluded once one of these filters is active - see the LiveOrdersQuery
  // comment for why a filtered page can legitimately come back with fewer than `first` rows.
  private applyOverlayFilters(items: LiveOrderListItem[], filters: OverlayFilters): LiveOrderListItem[] {
    return applyOrderFilters(items, filters);
  }

  private fetchCrmRows(externalIds: string[]) {
    return this.db.order.findMany({
      where: { externalSource: "SHOPIFY", externalId: { in: externalIds.flatMap(shopifyOrderIdVariants) } },
      select: {
        id: true,
        externalId: true,
        status: true,
        source: true,
        payments: { select: { status: true, method: true } },
        confirmedByName: true,
        createdBy: { select: { id: true, name: true } },
        _count: { select: { items: true } },
        lead: {
          select: {
            id: true,
            leadNumber: true,
            firstName: true,
            lastName: true,
            owner: { select: { id: true, name: true } },
            source: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  private mapLinked(shopifyOrder: NormalizedOrderListItem, crm: NonNullable<Awaited<ReturnType<typeof this.fetchCrmRows>>>[number]): LiveOrderListItem {
    const salesperson = crm.createdBy ?? crm.lead.owner;
    return {
      id: crm.id,
      orderNumber: shopifyOrder.name,
      status: crm.status,
      // The CRM's own source (e.g. a salesperson-booked order later pushed to Shopify still reads as
      // "Salesperson", not "Shopify") - previously hardcoded to "SHOPIFY" regardless, which lost that
      // distinction for every linked order once the list became Shopify-sourced.
      source: crm.source,
      currency: shopifyOrder.currency ?? "INR",
      totalAmount: shopifyOrder.totalAmount ?? "0",
      itemCount: crm._count.items,
      paymentStatus: derivePaymentStatus(crm.payments),
      paymentMode: derivePaymentMode(crm.payments),
      externalNumber: shopifyOrder.name,
      createdAt: new Date(shopifyOrder.createdAt),
      customer: { leadId: crm.lead.id, leadNumber: crm.lead.leadNumber, name: shopifyOrder.customerName ?? fullName(crm.lead.firstName, crm.lead.lastName) },
      salesperson: salesperson ? { id: salesperson.id, name: salesperson.name } : null,
      leadSource: crm.lead.source,
      linkedInCrm: true,
      // Straight from the same live Shopify read this page already made - never a second Shopify call,
      // and never derived from the CRM's own OrderStatus (a different vocabulary - see the type's comment).
      fulfillmentStatus: shopifyOrder.fulfillmentStatus,
      hasTracking: shopifyOrder.hasTracking,
      shippingMethod: shopifyOrder.shippingMethod,
      tags: mergeOrderTags(shopifyOrder.tags, crm.confirmedByName),
    };
  }

  // A real Shopify order the CRM has not synced yet - shown to ADMIN only (see attachCrmOverlay), with
  // no CRM identity to link to. id is prefixed (not the raw Shopify GID, which contains "/" and would
  // break the frontend's single-segment /dashboard/orders/[id] route) so Order Detail can tell this
  // apart from a CRM order id and fetch it via getLiveOrderDetail() below instead.
  // ROOT CAUSE of the "No payment"/no-status bug this previously had: status/paymentStatus/paymentMode
  // were hardcoded to null for every unsynced order, discarding the real Shopify financialStatus/
  // fulfillmentStatus already present on `shopifyOrder` (fetched by the SAME listOrdersForDisplay call
  // every linked row also uses) - a Shopify order being unsynced into the CRM DB has nothing to do with
  // whether Shopify itself reports it as paid/fulfilled. Fixed by running that real Shopify data through
  // mapListOrderStatusAndPayments - the EXACT SAME OrderStatus/PaymentStatus/PaymentMethod derivation
  // shopify.persist.ts's real sync uses (via shopify.mapper.ts's mapOrder/mapOrderStatus/mapPayments) -
  // so this unsynced row can never disagree with what it would show once actually synced, and
  // derivePaymentStatus/derivePaymentMode (orders.filters.ts) stay the one place that reduces a
  // payment list to a single status/mode, exactly like the linked branch above already does.
  private mapUnlinked(shopifyOrder: NormalizedOrderListItem): LiveOrderListItem {
    const { status, payments } = mapListOrderStatusAndPayments({
      id: shopifyOrder.id,
      currency: shopifyOrder.currency ?? "INR",
      cancelledAt: shopifyOrder.cancelledAt,
      financialStatus: shopifyOrder.financialStatus,
      fulfillmentStatus: shopifyOrder.fulfillmentStatus,
      returnStatus: shopifyOrder.returnStatus,
      fulfillments: shopifyOrder.fulfillments,
      tags: shopifyOrder.tags,
      paymentGateways: shopifyOrder.paymentGateways,
      transactions: shopifyOrder.transactions,
      amounts: { subtotal: null, discount: null, tax: null, shipping: null, total: shopifyOrder.totalAmount, refunded: shopifyOrder.refundedAmount },
      processedAt: shopifyOrder.processedAt,
      // The list doesn't fetch Shopify's own `updatedAt` (not needed anywhere else on this page) -
      // only used as a last-resort timestamp fallback when processedAt is also absent, so falling back
      // to createdAt here is harmless (never affects which status is chosen, only a paidAt timestamp
      // this list view doesn't even display).
      updatedAt: shopifyOrder.createdAt,
    });

    return {
      id: `${LIVE_ORDER_ID_PREFIX}${shopifyOrder.externalId}`,
      orderNumber: shopifyOrder.name,
      status,
      source: "SHOPIFY",
      currency: shopifyOrder.currency ?? "INR",
      totalAmount: shopifyOrder.totalAmount ?? "0",
      itemCount: shopifyOrder.itemCount,
      paymentStatus: derivePaymentStatus(payments),
      paymentMode: derivePaymentMode(payments),
      externalNumber: shopifyOrder.name,
      createdAt: new Date(shopifyOrder.createdAt),
      customer: { leadId: null, leadNumber: null, name: shopifyOrder.customerName ?? shopifyOrder.customerEmail ?? shopifyOrder.customerPhone ?? "Unknown" },
      salesperson: null,
      leadSource: null,
      linkedInCrm: false,
      fulfillmentStatus: shopifyOrder.fulfillmentStatus,
      hasTracking: shopifyOrder.hasTracking,
      shippingMethod: shopifyOrder.shippingMethod,
      tags: mergeOrderTags(shopifyOrder.tags, null),
    };
  }

  /**
   * The tags the Orders Tags filter offers: Shopify's most-used order tags (its own list, cached) plus every
   * "CRM Confirmed by <name>" tag the CRM has recorded. Shopify unreachable -> the CRM tags still come back, with an error note.
   */
  async listTagOptions(): Promise<LiveOrderTagOptionsResult> {
    const crmNames = await this.db.order.findMany({ where: { confirmedByName: { not: null } }, distinct: ["confirmedByName"], select: { confirmedByName: true } });
    const crm = crmNames.map((r) => confirmationTagFor(r.confirmedByName!)).sort((a, b) => a.localeCompare(b));
    let shopify: string[] = [];
    let error: string | undefined;
    try {
      shopify = await this.shopifyOrderTags();
    } catch {
      error = "Shopify tags could not be loaded.";
    }
    const seen = new Set<string>();
    const tags: LiveOrderTagOptionsResult["tags"] = [];
    for (const [names, source] of [[crm, "CRM"], [shopify, "SHOPIFY"]] as const) {
      for (const name of names) {
        const k = name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        tags.push({ name, source });
      }
    }
    return { tags, ...(error ? { error } : {}) };
  }

  private async shopifyOrderTags(): Promise<string[]> {
    if (tagOptionsCache && tagOptionsCache.expiresAt > Date.now()) return tagOptionsCache.value;
    const client = this.getShopifyClient();
    const data = await client.query<{ shop: { orderTags: { edges: { node: string }[] } } }>(SHOP_ORDER_TAGS_QUERY, {});
    const value = data.shop.orderTags.edges.map((e) => e.node).filter(Boolean);
    tagOptionsCache = { value, expiresAt: Date.now() + TAG_OPTIONS_TTL_MS };
    return value;
  }

  // Order Detail for a Shopify order the CRM has not synced yet (the "Not synced to CRM" row from the
  // list). Same ADMIN-only visibility rule as that row - a non-admin can't see a Shopify order with no
  // CRM lead to check scope against. Reuses fetchOrder() (the same full-order call orders.service.ts's
  // getOrder() already uses for its shopifyLive overlay) - no second Shopify client/query.
  async getLiveOrderDetail(user: AuthUser, externalId: string): Promise<LiveOrderDetailResult> {
    if (user.role !== Role.ADMIN) {
      return { order: null, liveTracking: {}, error: "Not found" };
    }

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      return { order: null, liveTracking: {}, error: error instanceof ShopifyConfigError ? error.message : "Shopify is not configured." };
    }

    let order;
    try {
      order = await fetchOrder(client, `gid://shopify/Order/${externalId}`);
    } catch (error) {
      return { order: null, liveTracking: {}, error: error instanceof ShopifyApiError ? error.message : "Could not reach Shopify - please try again." };
    }
    if (!order) {
      return { order: null, liveTracking: {}, error: "Shopify no longer has this order." };
    }

    // Independent of each other - fetch in parallel rather than sequentially.
    const awbs = [...new Set(order.fulfillments.map((f) => f.trackingNumber).filter((awb): awb is string => Boolean(awb)))];
    const [liveTracking, crmLink] = await Promise.all([
      awbs.length > 0 ? getLiveTrackingBatch(awbs) : Promise.resolve(new Map()),
      this.findCrmLink(order.customer.phone),
    ]);

    return { order, liveTracking: Object.fromEntries(liveTracking), crmLink };
  }

  // Best-effort match of the Shopify customer's phone to an existing CRM lead (Lead.normalizedMobile -
  // the CRM's own existing dedupe key, see @/lib/leadIdentity.js), so the page can link out to the real
  // Customer 360 rather than re-implementing any CRM-owned data here. Never throws - a lookup failure
  // just means no link is shown, same as "no match found".
  private async findCrmLink(phone: string | null): Promise<LiveOrderCrmLink | null> {
    const normalized = normalizeMobile(phone);
    if (!normalized) return null;
    try {
      const lead = await this.db.lead.findFirst({
        where: { normalizedMobile: normalized },
        select: { id: true, leadNumber: true, owner: { select: { id: true, name: true } } },
      });
      return lead ? { leadId: lead.id, leadNumber: lead.leadNumber, owner: lead.owner } : null;
    } catch {
      return null;
    }
  }

  // "Previous Orders" (Section 11): the Shopify customer's other orders, cursor-paginated - never the
  // whole history. Same ADMIN-only gate as getLiveOrderDetail itself (this is only ever called FROM
  // that already-gated page). Reuses listOrdersForDisplay (the Orders list's own call) with a
  // customer_id: search term instead of a second/new Shopify query.
  async getLiveOrderHistory(user: AuthUser, shopifyCustomerId: string, excludeExternalId: string, query: LiveOrderHistoryQuery): Promise<LiveOrderHistoryResult> {
    if (user.role !== Role.ADMIN) {
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: "Not found" };
    }

    const cacheKey = JSON.stringify({ userId: user.id, shopifyCustomerId, excludeExternalId, after: query.after ?? null, first: query.first });
    const cached = historyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: error instanceof ShopifyConfigError ? error.message : "Shopify is not configured." };
    }

    let page;
    try {
      page = await listOrdersForDisplay(client, { first: query.first, after: query.after ?? null, search: `customer_id:${shopifyCustomerId}` });
    } catch (error) {
      const message = error instanceof ShopifyApiError ? error.message : "Could not reach Shopify - please try again.";
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: message };
    }

    // The current order is almost always the newest (first) row of its own customer's history, since
    // the list is newest-first - excluded here rather than asking Shopify for "not this one".
    const others = page.items.filter((i) => i.externalId !== excludeExternalId);

    // Which of these are already synced into the CRM, purely to build a ready-to-navigate id - no
    // salesperson/lead-scope filtering here (unlike the main list): this whole endpoint is already
    // ADMIN-only, and ADMIN sees every CRM order regardless of lead ownership.
    const externalIds = others.map((i) => i.externalId);
    const crmRows = externalIds.length > 0
      ? await this.db.order.findMany({ where: { externalSource: "SHOPIFY", externalId: { in: externalIds.flatMap(shopifyOrderIdVariants) } }, select: { id: true, externalId: true } })
      : [];
    const crmIdByExternalId = new Map(crmRows.map((r) => [normalizeShopifyOrderId(r.externalId!), r.id]));

    const result: LiveOrderHistoryResult = {
      items: others.map((i) => {
        const crmId = crmIdByExternalId.get(normalizeShopifyOrderId(i.externalId));
        return {
          id: crmId ?? `${LIVE_ORDER_ID_PREFIX}${i.externalId}`,
          orderNumber: i.name,
          currency: i.currency ?? "INR",
          totalAmount: i.totalAmount ?? "0",
          financialStatus: i.financialStatus,
          fulfillmentStatus: i.fulfillmentStatus,
          createdAt: new Date(i.createdAt),
          linkedInCrm: Boolean(crmId),
        };
      }),
      pageInfo: { hasNextPage: page.hasNextPage, hasPreviousPage: page.hasPreviousPage, endCursor: page.endCursor },
    };
    historyCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  // Brings a Shopify order that has no CRM Order row into the CRM, through the SAME sync every webhook and `shopify:sync` run uses (upsertOrder:
  // idempotent on the Shopify order id under an advisory lock + unique key, so repeating it - or racing a webhook - never creates a duplicate). Reads the
  // order from Shopify (read-only) and writes the Order, items, lead link and payments; it never creates a refund and never contacts Cashfree. The
  // lifecycle WhatsApp automation is skipped: catching an order up must not message the customer late. ADMIN only, like the live page it is offered on.
  async syncLiveOrderToCrm(user: AuthUser, externalId: string): Promise<LiveOrderSyncResult> {
    if (user.role !== Role.ADMIN) return { synced: false, reason: "Not found" };

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      return { synced: false, reason: error instanceof ShopifyConfigError ? error.message : "Shopify is not configured." };
    }

    try {
      const outcome = await this.syncOrder({ client, runner: this.runner, afterCommit: this.makeAfterCommit(client, this.runner) }, `gid://shopify/Order/${externalId}`, { source: ActivitySource.SHOPIFY_SYNC, automation: false });
      if (outcome.notFound || !outcome.result?.orderId) return { synced: false, reason: "Shopify no longer has this order." };
      // The list/detail caches still describe this order as live-only.
      listCache.clear();
      historyCache.clear();
      return { synced: true, orderId: outcome.result.orderId, action: outcome.result.action };
    } catch (error) {
      return { synced: false, reason: error instanceof ShopifyApiError ? error.message : "Could not sync the order - nothing was changed. Please try again." };
    }
  }

  // Cancels a Shopify order the CRM has not synced yet. Shopify has no "delete order" mutation at
  // all - orderCancel (the same one orders.service.ts's cancelOrder already uses for a CRM-linked
  // order) is the only destructive action that exists, so that is the one offered here too, never a
  // fabricated "delete". Same ADMIN-only visibility as getLiveOrderDetail - there is no CRM lead to
  // scope this to for a non-admin, same as every other unlinked-order action.
  async cancelLiveOrder(user: AuthUser, externalId: string): Promise<LiveOrderCancelResult> {
    if (user.role !== Role.ADMIN) {
      return { cancelled: false, reason: "Not found" };
    }

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      return { cancelled: false, reason: error instanceof ShopifyConfigError ? error.message : "Shopify is not configured." };
    }

    try {
      await cancelShopifyOrder(client, `gid://shopify/Order/${externalId}`);
      // Any cached list/detail page may now show a stale (pre-cancellation) status - cheaper to drop
      // the whole small in-process cache than to track which keys this order could appear under.
      listCache.clear();
      historyCache.clear();
      return { cancelled: true };
    } catch (error) {
      return { cancelled: false, reason: error instanceof ShopifyOrderCancelError ? error.message : "Could not reach Shopify - please try again." };
    }
  }
}

export default OrdersLiveService;
