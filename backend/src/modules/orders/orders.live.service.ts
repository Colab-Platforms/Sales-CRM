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
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { checkConnection, fetchOrder, listOrdersForDisplay, type NormalizedOrderListItem } from "../shopify/shopify.orders.js";
import { DEFAULT_START_DATE, resolveWindow, windowSearch, type WindowSpec } from "../shopify/shopify.window.js";
import { cancelShopifyOrder, ShopifyOrderCancelError } from "../shopify/shopify.orders.write.js";
import { getLiveTrackingBatch } from "../shiprocket/shiprocket.live-tracking.js";
import { mapListOrderStatusAndPayments } from "../shopify/shopify.mapper.js";
import { derivePaymentMode, derivePaymentStatus, fullName } from "./orders.filters.js";
import {
  LIVE_ORDER_ID_PREFIX,
  type LiveOrderCancelResult,
  type LiveOrderCrmLink,
  type LiveOrderDetailResult,
  type LiveOrderHistoryQuery,
  type LiveOrderHistoryResult,
  type LiveOrderListItem,
  type LiveOrderListResult,
  type LiveOrdersQuery,
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

class OrdersLiveService {
  // getShopifyClient is injectable so tests never construct a real client (same pattern OrdersService
  // itself already uses for pushOrderToShopify/cancelOrder).
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => ShopifyClient = () => new ShopifyClient(loadShopifyConfig()),
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
      status: query.status ?? null,
      paymentStatus: query.paymentStatus ?? null,
      source: query.source ?? null,
      salespersonId: query.salespersonId ?? null,
    });
    const cached = listCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: error instanceof ShopifyConfigError ? error.message : "Shopify is not configured." };
    }

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
      const search = [windowSearch(window), query.search?.trim()].filter(Boolean).join(" ");
      page = await listOrdersForDisplay(client, { first: query.first, after: query.after ?? null, search });
    } catch (error) {
      const message = error instanceof ShopifyApiError ? error.message : "Could not reach Shopify - please try again.";
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: message };
    }

    const result = await this.attachCrmOverlay(user, page.items, page.hasNextPage, page.hasPreviousPage, page.endCursor, {
      status: query.status,
      paymentStatus: query.paymentStatus,
      source: query.source,
      salespersonId: query.salespersonId,
    });
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
    overlayFilters: Pick<LiveOrdersQuery, "status" | "paymentStatus" | "source" | "salespersonId">,
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
    const byExternalId = new Map(crmRows.map((row) => [row.externalId!, row]));

    // For a MANAGER/SALESPERSON, an in-scope check needs to be evaluated per-lead - cheapest as a
    // second, tiny query for just the lead ids already found above, reusing the exact same leadScope
    // Prisma.LeadWhereInput every other RBAC-scoped read in this codebase already uses.
    const leadIds = [...new Set(crmRows.map((r) => r.lead.id))];
    const inScopeLeadIds = user.role === Role.ADMIN || leadIds.length === 0
      ? new Set(leadIds)
      : new Set((await this.db.lead.findMany({ where: { id: { in: leadIds }, ...leadScope }, select: { id: true } })).map((l) => l.id));

    const items: LiveOrderListItem[] = [];
    for (const shopifyOrder of shopifyItems) {
      const crm = byExternalId.get(shopifyOrder.externalId) ?? null;
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
  private applyOverlayFilters(items: LiveOrderListItem[], filters: Pick<LiveOrdersQuery, "status" | "paymentStatus" | "source" | "salespersonId">): LiveOrderListItem[] {
    const { status, paymentStatus, source, salespersonId } = filters;
    if (!status && !paymentStatus && !source && !salespersonId) return items;
    return items.filter((item) => {
      if (status && item.status !== status) return false;
      if (paymentStatus && (paymentStatus === "NONE" ? item.paymentStatus !== null : item.paymentStatus !== paymentStatus)) return false;
      if (source && item.source !== source) return false;
      if (salespersonId && item.salesperson?.id !== salespersonId) return false;
      return true;
    });
  }

  private fetchCrmRows(externalIds: string[]) {
    return this.db.order.findMany({
      where: { externalSource: "SHOPIFY", externalId: { in: externalIds } },
      select: {
        id: true,
        externalId: true,
        status: true,
        source: true,
        payments: { select: { status: true, method: true } },
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
    };
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
      ? await this.db.order.findMany({ where: { externalSource: "SHOPIFY", externalId: { in: externalIds } }, select: { id: true, externalId: true } })
      : [];
    const crmIdByExternalId = new Map(crmRows.map((r) => [r.externalId!, r.id]));

    const result: LiveOrderHistoryResult = {
      items: others.map((i) => {
        const crmId = crmIdByExternalId.get(i.externalId);
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
