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
