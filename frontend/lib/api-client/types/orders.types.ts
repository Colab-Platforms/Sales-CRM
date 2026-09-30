import type { ReconciliationStatus } from "./reconciliation.types";

export type OrderStatus =
  | "DRAFT"
  | "PENDING_PAYMENT"
  | "CONFIRMED"
  | "PROCESSING"
  | "CANCELLED"
  | "RETURNED"
  | "REFUNDED"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED";

export type OrderSource = "SALESPERSON" | "WEBSITE" | "API" | "SHOPIFY";

// Cash on delivery, or paid up front. Null when the payment method is not known.
export type PaymentMode = "COD" | "PREPAID";

export type PaymentStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

// "NONE" filters orders that have no payment record yet.
export type PaymentStatusFilter = PaymentStatus | "NONE";

export type PaymentMethod =
  | "CASH"
  | "CARD"
  | "UPI"
  | "NET_BANKING"
  | "WALLET"
  | "PAYMENT_LINK"
  | "OTHER"
  | "COD";

export type ShipmentStatus =
  | "SHIPPED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "RETURNED"
  // Only for a shipment the CRM created directly in Shiprocket (before the courier has it), and a cancelled one.
  | "CREATED"
  | "AWB_ASSIGNED"
  | "PICKUP_SCHEDULED"
  | "CANCELLED";

// Where a payment or shipment record comes from: Shopify sync, or something the CRM created directly with the provider.
export type ExternalSource = "SHOPIFY" | "CASHFREE" | "SHIPROCKET";

// Live from Shiprocket (backend: shiprocket.live-tracking.ts) - fetched read-only, cached briefly,
// never written back to the CRM's own shipment row. Absent (undefined) when the shipment has no AWB
// to look up; `tracking: null` with `error` set when Shiprocket couldn't answer.
export interface LiveTracking {
  tracking: {
    awb: string;
    currentStatus: string | null;
    trackUrl: string | null;
    etd: string | null;
    courierName: string | null;
    activities: { date: string | null; status: string | null; location: string | null }[];
  } | null;
  error?: string;
}

// A shipment with no tracking/courier/dates yet (only the fulfilment record itself has synced) is
// not the same as "no shipment at all" - null fields mean "not known", not zero.
export interface ShipmentDetail {
  id: string;
  status: ShipmentStatus;
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  expectedDeliveryAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  createdAt: string;
  liveTracking?: LiveTracking;
  // Only on the order detail (the customer summary that reuses this type does not carry them).
  source?: ExternalSource | null;
  providerStatus?: string | null;
  labelUrl?: string | null;
  pickupScheduledAt?: string | null;
  shiprocketOrderId?: string | null;
  // On a Shopify-derived shipment: the direct Shiprocket shipment carrying the same AWB (the same parcel).
  linkedShipmentId?: string | null;
}

// E7.8 (WhatsApp -> CRM Order): manual order entry, same fields the backend's createManualOrder accepts.
export interface CreateManualOrderItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
  unitPrice: string;
  discountAmount?: string;
}

export interface CreateManualOrderInput {
  leadId: string;
  items: CreateManualOrderItemInput[];
  paymentMethod: PaymentMethod;
  // One per order ATTEMPT (reused across retries of that same attempt) - the backend collapses a double submit with the same key into one order.
  idempotencyKey?: string;
  shippingAddress?: {
    name?: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    pincode?: string;
    phone?: string;
  };
  shippingPincode?: string;
  shippingAmount?: string;
  discountAmount?: string;
  discountReason?: string;
}

export type ShopifyPushStatus = "created" | "already_linked" | "failed";

export interface ShopifyPushResult {
  status: ShopifyPushStatus;
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  reason?: string;
}

export type ShopifyCancelStatus = "cancelled" | "failed" | "not_linked";

export interface ShopifyCancelResult {
  status: ShopifyCancelStatus;
  reason?: string;
}

export type OrderPaymentLinkStatus = "created" | "reused" | "failed";

// Only what the order-creation response needs to show - not the full Cashfree PaymentLinkResult.
export interface OrderPaymentLinkResult {
  status: OrderPaymentLinkStatus;
  paymentId?: string;
  paymentUrl?: string | null;
  expiresAt?: string | null;
  reason?: string;
}

export type OrderNotifyVia = "FREE_TEXT" | "TEMPLATE";
export type WhatsAppProviderName = "META" | "AISENSY" | "GUPSHUP";

export interface OrderNotifyResult {
  sent: boolean;
  via: OrderNotifyVia | null;
  provider: WhatsAppProviderName | null;
  reason?: string;
}

export interface CreateManualOrderResult {
  order: OrderDetail;
  shopify: ShopifyPushResult;
  // null only when the order's payment method has nothing to collect via Cashfree (e.g. COD).
  paymentLink: OrderPaymentLinkResult | null;
  whatsapp: OrderNotifyResult;
}

// none: no Cashfree link (e.g. COD). cancelled: the unpaid link was cancelled. paid: already paid - nothing cancelled or
// refunded. failed: an unpaid link is still active; cancelling again retries it.
export type PaymentLinkCancelStatus = "none" | "cancelled" | "paid" | "failed";

export interface PaymentLinkCancelResult {
  status: PaymentLinkCancelStatus;
  reason?: string;
}

export interface CancelOrderInput {
  reason?: string;
}

export interface CancelOrderResult {
  order: OrderDetail;
  shopify: ShopifyCancelResult;
  paymentLink: PaymentLinkCancelResult;
  alreadyCancelled: boolean;
}

export interface OrdersListParams {
  page: number;
  pageSize: number;
  search?: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatusFilter;
  source?: OrderSource;
  salespersonId?: string;
  // ISO date-times
  dateFrom?: string;
  dateTo?: string;
}

// Money is sent as a string so decimals are never rounded in transit.
export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  source: OrderSource;
  currency: string;
  totalAmount: string;
  itemCount: number;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  externalNumber: string | null;
  createdAt: string;
  customer: { leadId: string; leadNumber: string; name: string };
  salesperson: { id: string; name: string } | null;
  leadSource: { id: string; name: string } | null;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface OrderListResult {
  items: OrderListItem[];
  pagination: Pagination;
}

// ---- Live Orders list (reads directly from Shopify - GET /orders/live) ----
// Cursor-paginated, never the whole history in one page. Same OrderListItem shape as the CRM-DB-backed
// list above (minus status/source/paymentStatus/salesperson filters, which this endpoint does not
// support yet) plus `linkedInCrm`, so the existing OrdersTable component renders either source as-is.

export interface LiveOrdersListParams {
  after?: string;
  first: number;
  search?: string;
  // ISO date-times
  dateFrom?: string;
  dateTo?: string;
}

export interface LiveOrderListItem {
  id: string;
  orderNumber: string;
  status: OrderStatus | null;
  source: OrderSource;
  currency: string;
  totalAmount: string;
  itemCount: number;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  externalNumber: string | null;
  createdAt: string;
  customer: { leadId: string | null; leadNumber: string | null; name: string };
  salesperson: { id: string; name: string } | null;
  leadSource: { id: string; name: string } | null;
  /** false = Shopify has this order but the CRM has not synced it yet (ADMIN-only, see the backend). */
  linkedInCrm: boolean;
}

export interface LiveOrderPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  endCursor: string | null;
}

export interface LiveOrderListResult {
  items: LiveOrderListItem[];
  pageInfo: LiveOrderPageInfo;
  /** Shopify could not be reached at all - items is always [] when this is set. */
  error?: string;
  /** Shopify loaded, but the CRM-owned overlay (salesperson/lead) partially failed. */
  partialError?: string;
}

export interface OrderItemDetail {
  id: string;
  productId: string | null;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  totalPrice: string;
}

export interface PaymentDetail {
  id: string;
  status: PaymentStatus;
  method: PaymentMethod | null;
  amount: string;
  currency: string;
  provider: string | null;
  providerPaymentId: string | null;
  transactionReference: string | null;
  paidAt: string | null;
  failedAt: string | null;
  refundedAt: string | null;
  refundedAmount: string | null;
  failureReason: string | null;
  createdAt: string;
  source: ExternalSource | null;
  // A Cashfree payment link the customer pays through; only set on a payment the CRM created that way.
  paymentUrl: string | null;
  paymentExpiresAt: string | null;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  source: OrderSource;
  currency: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  shippingAmount: string;
  totalAmount: string;
  discountReason: string | null;
  externalNumber: string | null;
  shippingAddress: Record<string, string | null> | null;
  shippingPincode: string | null;
  cancelReason: string | null;
  // Last Shopify-cancellation outcome the backend recorded (null if never cancelled / never attempted).
  shopifyCancellation: ShopifyCancelResult | null;
  // Last Cashfree-link cancellation outcome the backend recorded (null if none was attempted).
  paymentLinkCancellation: PaymentLinkCancelResult | null;
  // Last Shopify payment-reconciliation outcome (set once a Cashfree payment on this order settles).
  shopifyPaymentSync: { status: "synced" | "failed"; reason?: string; syncedAt?: string; failedAt?: string } | null;
  // The last customer WhatsApp notification about this order as remembered by the backend (null = never attempted).
  whatsappNotification: (OrderNotifyResult & { at: string }) | null;
  createdAt: string;
  placedAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  // Reconciliation breakdown - see reconciliation.types.ts for what each status means.
  paidAmount: string;
  refundedAmount: string;
  outstandingAmount: string;
  reconciliationStatus: ReconciliationStatus;
  customer: {
    leadId: string;
    leadNumber: string;
    name: string;
    mobile: string | null;
    email: string | null;
  };
  leadSource: { id: string; name: string } | null;
  bookedBy: { id: string; name: string; email: string } | null;
  leadOwner: { id: string; name: string } | null;
  items: OrderItemDetail[];
  payments: PaymentDetail[];
  shipments: ShipmentDetail[];
  // Live snapshot fetched directly from Shopify for a synced order - additive overlay, never replaces
  // the CRM-owned fields above. null when unlinked, not yet fetched, or Shopify was unreachable
  // (see shopifyLiveError). See backend: orders.service.ts's getOrder().
  shopifyLive: ShopifyLiveOrder | null;
  shopifyLiveError?: string;
}

export interface LiveOrderAddress {
  name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
}

// A read-only, live snapshot of the order as Shopify currently has it - only what Order Detail shows.
export interface ShopifyLiveOrder {
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  currency: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  returnStatus: string | null;
  taxesIncluded: boolean | null;
  tags: string[];
  paymentGateways: string[];
  discountCodes: string[];
  customer: { id: string | null; firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  shippingAddress: LiveOrderAddress | null;
  billingAddress: LiveOrderAddress | null;
  /** e.g. "Standard Shipping" - the rate name, not the charge itself (see amounts.shipping). */
  shippingMethod: string | null;
  amounts: { subtotal: string | null; discount: string | null; tax: string | null; shipping: string | null; total: string | null; refunded: string | null };
  items: {
    id: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    unitPrice: string | null;
    discounts: string[];
    productId: string | null;
    variantId: string | null;
  }[];
  /** True when the order has more line items than were fetched (see ORDER_BY_ID_QUERY's first: 100). */
  itemsTruncated: boolean;
  transactions: {
    id: string;
    kind: string;
    status: string;
    gateway: string | null;
    amount: string | null;
    processedAt: string | null;
    errorCode: string | null;
  }[];
  fulfillments: { status: string; displayStatus: string | null; createdAt: string | null; trackingCompany: string | null; trackingNumber: string | null; trackingUrl: string | null }[];
}

// A Shopify order the CRM has not synced yet has no CRM order id, so the Orders list gives it an id
// of the form `${LIVE_ORDER_ID_PREFIX}<externalId>` instead of the raw (slash-containing) Shopify GID -
// see backend orders.live.types.ts for why. orderDetailHref/the [id] route both just pass this through
// as an opaque string; only the Order Detail page itself needs to tell the two cases apart.
export const LIVE_ORDER_ID_PREFIX = "shopify:";

// On a client-side (soft) navigation, Next.js's App Router can hand the dynamic [id] segment through
// still percent-encoded (e.g. "shopify%3A123" for "shopify:123") - a full page load/refresh decodes it
// first, but a <Link>/router.push transition does not always. Decoding here (once, centrally) makes
// both forms recognized without every caller needing its own decodeURIComponent() call. A normal CRM
// UUID has no percent-encoding to begin with, so decoding it is a no-op - existing behavior for it is
// unchanged. An id with an invalid escape sequence (malformed %) is treated as not a live order id,
// same as any other non-matching string, rather than throwing.
export function parseLiveOrderId(id: string): string | null {
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    // Malformed percent-encoding - fall through with the original string (won't match the prefix).
  }
  return decoded.startsWith(LIVE_ORDER_ID_PREFIX) ? decoded.slice(LIVE_ORDER_ID_PREFIX.length) : null;
}

// If the Shopify customer can be matched (by phone) to an existing CRM lead - a pointer to the real
// Customer 360 page, never a duplicate rendering of CRM-owned data here.
export interface LiveOrderCrmLink {
  leadId: string;
  leadNumber: string;
  owner: { id: string; name: string } | null;
}

// GET /orders/live/:externalId - Order Detail for a Shopify order not yet synced into the CRM.
export interface LiveOrderDetailResult {
  order: ShopifyLiveOrder | null;
  /** Keyed by tracking number, for each fulfillment.trackingNumber Shopify reported. */
  liveTracking: Record<string, LiveTracking>;
  crmLink?: LiveOrderCrmLink | null;
  error?: string;
}

// GET /orders/live/customer/:customerId/history - "Previous Orders" on the live detail page, cursor-paginated.
export interface LiveOrderHistoryParams {
  first: number;
  after?: string;
  excludeExternalId: string;
}

export interface LiveOrderHistoryItem {
  /** A ready-to-navigate Order Detail id - a real CRM order id when synced, "shopify:<externalId>" otherwise. */
  id: string;
  orderNumber: string;
  currency: string;
  totalAmount: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  createdAt: string;
  linkedInCrm: boolean;
}

export interface LiveOrderHistoryResult {
  items: LiveOrderHistoryItem[];
  pageInfo: LiveOrderPageInfo;
  error?: string;
}

export type StatusHistoryEvent = "CREATED" | "PLACED" | "CONFIRMED" | "CANCELLED" | "STATUS_CHANGE";

export interface StatusHistoryEntry {
  id: string;
  event: StatusHistoryEvent;
  title: string;
  description: string | null;
  occurredAt: string;
  actor: { id: string; name: string } | null;
  source: "ACTIVITY" | "ORDER_RECORD";
}

export interface OrderStatusHistory {
  orderId: string;
  orderNumber: string;
  currentStatus: OrderStatus;
  entries: StatusHistoryEntry[];
}

export interface OrderFilterOptions {
  salespeople: { id: string; name: string }[];
}
