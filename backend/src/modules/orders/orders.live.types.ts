import type { OrderSource, OrderStatus, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { PaymentMode, PaymentStatusFilter } from "./orders.types.js";
import type { NormalizedOrder } from "../shopify/shopify.orders.js";
import type { LiveTracking } from "../shiprocket/shiprocket.types.js";

// A Shopify order not yet synced into the CRM has no CRM order id to link to - id would otherwise be
// the raw Shopify GID ("gid://shopify/Order/123"), which contains "/" and breaks the frontend's single
// dynamic route segment (/dashboard/orders/[id]). This prefix keeps the id URL-safe (one path segment,
// no reserved characters) while still letting the frontend tell the two cases apart and route
// accordingly - see orders.live.service.ts's mapUnlinked() and the frontend's order-detail-view routing.
export const LIVE_ORDER_ID_PREFIX = "shopify:";

export interface LiveOrdersQuery {
  /** Relay cursor from a previous page's endCursor - omit for the first page. */
  after?: string;
  /** Page size, 25-50 (never the whole history). */
  first: number;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  // CRM-overlay filters (status/paymentStatus/source/salesperson are all CRM-owned - Shopify itself
  // has no concept of any of them). Applied AFTER the Shopify page is fetched and joined to the CRM
  // overlay, so a page with one of these set can legitimately return fewer than `first` rows (an
  // unlinked order never matches any of them, since it has no CRM status/salesperson to compare) -
  // the same documented tradeoff the free-text `search` param already has for anything CRM-only
  // (lead number, payment reference) that Shopify's own search has no concept of either.
  //
  // Column filters: each is a LIST (a single value is accepted too, for older callers). Values inside one filter are OR-ed;
  // different filters are AND-ed. `paymentMode` and `paymentStatus` are two dimensions of the Payment column.
  status?: OrderStatus | OrderStatus[];
  paymentStatus?: PaymentStatusFilter | PaymentStatusFilter[];
  paymentMode?: PaymentMode | PaymentMode[];
  source?: OrderSource | OrderSource[];
  salespersonId?: string | string[];
  leadSourceId?: string | string[];
  /** Shopify's own fulfilment status (UNFULFILLED, FULFILLED, PARTIALLY_FULFILLED...) as shown under Status. */
  fulfillment?: string | string[];
  /** Order total range, in the order's major currency unit (rupees). Either end may be omitted. */
  totalMin?: number;
  totalMax?: number;
  /** Tags (Shopify tags and the CRM "CRM Confirmed by <name>" tag). Several = any of them (OR); exact tag match. */
  tags?: string[];
}

type Money = string;

// Deliberately the SAME shape as the CRM-DB-backed OrderListItem (orders.types.ts) so the existing
// OrdersTable component renders either source with zero changes - only the data source underneath it
// differs. Fields this endpoint cannot supply live (paymentStatus/paymentMode/itemCount need either a
// second Shopify call or a CRM-side payment row; salesperson/leadSource are CRM-owned) are null/0
// unless a matching CRM Order row already exists to fill them in (see orders.live.service.ts).
export interface LiveOrderListItem {
  id: string;
  orderNumber: string;
  status: OrderStatus | null;
  source: OrderSource;
  currency: string;
  totalAmount: Money;
  itemCount: number;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  externalNumber: string | null;
  createdAt: Date;
  customer: { leadId: string | null; leadNumber: string | null; name: string };
  salesperson: { id: string; name: string } | null;
  leadSource: { id: string; name: string } | null;
  /** True once a matching CRM Order row (from the existing webhook/backfill sync) was found and
   *  joined in for the CRM-owned fields above. False = Shopify has this order but the CRM has not
   *  synced it yet (e.g. a webhook still pending) - shown to ADMIN only, see the RBAC note in the service. */
  linkedInCrm: boolean;
  // ---- Shopify-native display fields, straight from the live Shopify order read this page always
  // makes regardless of linkedInCrm - never missing just because an order hasn't synced yet. null for
  // a non-Shopify order (source !== "SHOPIFY"), which has no Shopify fulfillment/shipping data at all. ----
  /** Shopify's own `displayFulfillmentStatus` (e.g. "FULFILLED"/"PARTIALLY_FULFILLED"/"UNFULFILLED"),
   *  shown as-is next to `status` - CRM OrderStatus and Shopify fulfillment status are different
   *  vocabularies (one is the CRM's own lifecycle, the other Shopify's shipping state), so this is
   *  never collapsed into `status` nor guessed when absent. */
  fulfillmentStatus: string | null;
  /** True when at least one Shopify fulfillment on this order has a real tracking number. */
  hasTracking: boolean;
  /** Shopify's own shipping rate name (e.g. "Standard"), null when the order has no shipping line. */
  shippingMethod: string | null;
  /** Shopify's live tags merged with the CRM confirmation tag (see orders.tags.ts) - one normalized, de-duplicated list. */
  tags: string[];
}

export interface LiveOrderTagOption {
  name: string;
  /** Where the tag comes from: Shopify's tag list, or the CRM's own confirmation. */
  source: "SHOPIFY" | "CRM";
}

export interface LiveOrderTagOptionsResult {
  tags: LiveOrderTagOption[];
  /** Set when Shopify's tag list could not be loaded - the CRM confirmation tags are still returned. */
  error?: string;
}

export interface LiveOrderPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  endCursor: string | null;
}

export interface LiveOrderListResult {
  items: LiveOrderListItem[];
  pageInfo: LiveOrderPageInfo;
  /** Set when Shopify could not be reached at all (down/misconfigured) - items is then always []
   *  rather than throwing, so the page can show a clear, actionable banner instead of a blank crash. */
  error?: string;
  /** Set when the Shopify order list loaded but the CRM-side (salesperson/lead) overlay partially or
   *  fully failed - items still has real Shopify data, just without the CRM-owned fields filled in. */
  partialError?: string;
}

// If the Shopify customer on an unsynced order can be matched (by phone) to an existing CRM lead, this
// is the minimal pointer the UI needs to link out to the REAL Customer 360 page - never a duplicate
// rendering of CRM-owned data (segment/notes/activities/etc. all stay on that page, not copied here).
export interface LiveOrderCrmLink {
  leadId: string;
  leadNumber: string;
  owner: { id: string; name: string } | null;
}

// Order Detail for a Shopify order the CRM has not synced yet (linkedInCrm: false in the list) - no
// CRM-owned fields exist for it at all, so this is Shopify data (+ live Shiprocket tracking by AWB,
// where Shopify's own fulfilment reports one) only. GET /orders/live/:externalId, ADMIN-only, same
// visibility rule as the unlinked row in the list.
export interface LiveOrderDetailResult {
  order: NormalizedOrder | null;
  /** Keyed by tracking number, for each of order.fulfillments[].trackingNumber that Shopify reported. */
  liveTracking: Record<string, LiveTracking>;
  /** null = no CRM lead matched this customer's phone. Undefined only when `order` itself is null. */
  crmLink?: LiveOrderCrmLink | null;
  error?: string;
}

// The Shopify customer's other orders (Section 11: "Previous Orders") - cursor-paginated, never the
// whole history. Reuses listOrdersForDisplay (the same call the Orders list page already makes) with a
// customer_id: search term, rather than a second/new Shopify query.
export interface LiveOrderHistoryQuery {
  first: number;
  after?: string;
}

export interface LiveOrderHistoryItem {
  /** CRM order id when that order is already synced, otherwise "shopify:<externalId>" - either way, a
   *  ready-to-navigate Order Detail id (see LIVE_ORDER_ID_PREFIX / the frontend's orderDetailHref). */
  id: string;
  orderNumber: string;
  currency: string;
  totalAmount: Money;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  createdAt: Date;
  linkedInCrm: boolean;
}

export interface LiveOrderHistoryResult {
  items: LiveOrderHistoryItem[];
  pageInfo: LiveOrderPageInfo;
  error?: string;
}

// POST /orders/live/:externalId/cancel - Shopify has no "delete order" operation, only cancellation
// (orderCancel), so this is the one and only destructive action available for an unsynced order -
// same ADMIN-only visibility as the detail page itself, same cancelShopifyOrder() mutation the
// CRM-linked order's own cancel button already uses (see orders.service.ts's cancelOrder).
export interface LiveOrderCancelResult {
  cancelled: boolean;
  /** Set only when cancelled is false - Shopify's own rejection reason. */
  reason?: string;
}
