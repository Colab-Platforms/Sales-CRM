import type { ExternalSource, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { ReconciliationStatus } from "../reconciliation/reconciliation.types.js";
import type { OrderRefundInfo } from "../refunds/refunds.types.js";
import type { OrderNotifyResult } from "../whatsapp/whatsapp.order-notify.service.js";
import type { NormalizedOrder } from "../shopify/shopify.orders.js";
import type { LiveTracking } from "../shiprocket/shiprocket.types.js";

// How the customer pays: cash on delivery, or up front by any other method. Null when the method is not known.
export type PaymentMode = "COD" | "PREPAID";

// Filter value for orders that have no payment record yet.
export const NO_PAYMENT = "NONE" as const;
export type PaymentStatusFilter = PaymentStatus | typeof NO_PAYMENT;

// `Activity.referenceType` value for rows that point at an order.
export const ORDER_REFERENCE_TYPE = "Order";

// E7.8 (WhatsApp -> CRM Order): the CRM's own manual order-entry path, used by the "Create Order"
// action in the WhatsApp Inbox. Reuses the exact same Order/OrderItem/Payment models and OrderDetail
// response every other order path already uses - never a parallel/WhatsApp-only order record.
export interface CreateManualOrderItemInput {
  productId: string;
  variantId?: string;
  quantity: number;
  unitPrice: Money;
  discountAmount?: Money;
}

export interface CreateManualOrderInput {
  leadId: string;
  items: CreateManualOrderItemInput[];
  paymentMethod: PaymentMethod;
  // Frontend-generated (e.g. crypto.randomUUID(), one per order attempt, reused across retries of that
  // SAME attempt) - see OrdersService.createManualOrder's own comment for why this is an in-memory,
  // per-process guard against a double submit (double-click/double Enter), not a durable DB constraint.
  idempotencyKey?: string;
  shippingAddress?: {
    name?: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    pincode?: string;
    phone?: string;
    // Structured fields (the composed line1/line2 above remain what integrations read).
    houseNumber?: string;
    building?: string;
    area?: string;
    street?: string;
    landmark?: string;
    addressType?: "HOME" | "WORK" | "OTHER";
  };
  shippingPincode?: string;
  shippingAmount?: Money;
  discountAmount?: Money;
  /** Order-level Custom Discount, percent of (subtotal - line discounts). Mutually exclusive with discountAmount. */
  discountPercent?: string;
  /** Discount selection (Fastrr coupon / custom / none). See DiscountsService.resolve. */
  /** Packed parcel weight in kg, as entered. Recorded on the order; undefined = not recorded (nothing is assumed). */
  parcelWeightKg?: number;
  /** WhatsApp payment link: undefined = original behaviour; false = do not send; true = send via the chosen approved Meta template. */
  sendPaymentLinkViaWhatsApp?: boolean;
  whatsappTemplateId?: string;
  /** "Customer has agreed to receive WhatsApp updates" - recorded as CommunicationPreference OPTED_IN with the order. */
  whatsappConsent?: boolean;
  discount?: { none?: boolean; couponCode?: string; type?: "FIXED" | "PERCENT"; value?: string };
  /** What the user saw as the total; refused if the server computes something different. Never used as the total. */
  expectedTotal?: string;
  discountReason?: string;
}

export type ShopifyPushStatus = "created" | "already_linked" | "failed";

export interface ShopifyPushResult {
  status: ShopifyPushStatus;
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  /** Set only when status is "failed" - the real reason (from ShopifyOrderCreateError/config), never
   *  invented, never a generic "something went wrong". */
  reason?: string;
}

// The combined, honest result of "create a CRM order, then best-effort try to push it to Shopify,
// then best-effort try to collect payment / notify the customer" - each half's own real outcome,
// never a single flag that papers over a partial failure. `paymentLink`/`whatsapp` are only set when
// relevant to this order's payment method - both are null for a COD order that has nothing to collect.
export interface CreateManualOrderResult {
  order: OrderDetail;
  shopify: ShopifyPushResult;
  paymentLink: OrderPaymentLinkResult | null;
  whatsapp: OrderNotifyResult;
}

// Kept intentionally narrow (not the full CashfreePaymentsService PaymentLinkResult, which this
// module has no reason to depend on) - just what the order-creation response needs to show.
export interface OrderPaymentLinkResult {
  status: "created" | "reused" | "failed";
  paymentId?: string;
  paymentUrl?: string | null;
  expiresAt?: Date | null;
  /** Set only when status is "failed" - Cashfree not configured, or a real provider error. */
  reason?: string;
}

export type ShopifyCancelStatus = "cancelled" | "failed" | "not_linked";

export interface ShopifyCancelResult {
  status: ShopifyCancelStatus;
  reason?: string;
}

// The last customer WhatsApp notification about this order (COD confirmation / payment link), as remembered on the order.
export interface OrderWhatsAppNotification {
  sent: boolean;
  via: "FREE_TEXT" | "TEMPLATE" | null;
  provider: "META" | "AISENSY" | "GUPSHUP" | null;
  reason?: string;
  at: string;
}

// none: no Cashfree link on the order (e.g. COD). cancelled: the unpaid link was cancelled. paid: a payment already
// succeeded - nothing was cancelled or refunded. failed: an unpaid link is still active (retry by cancelling again).
export type PaymentLinkCancelStatus = "none" | "cancelled" | "paid" | "failed";

export interface PaymentLinkCancelResult {
  status: PaymentLinkCancelStatus;
  reason?: string;
}

export interface LastShippingAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  // Present only when the saved order used the structured form; older free-text addresses leave these empty.
  houseNumber: string;
  building: string;
  area: string;
  street: string;
  landmark: string;
  addressType: string;
}

export interface CancelOrderInput {
  reason?: string;
}

export interface CancelOrderResult {
  order: OrderDetail;
  shopify: ShopifyCancelResult;
  paymentLink: PaymentLinkCancelResult;
  /** true when the order was ALREADY cancelled before this call (idempotent no-op on the CRM side) -
   *  the Shopify half may still have been retried; see cancelOrder's own comment. */
  alreadyCancelled: boolean;
}

export interface RevertCancellationResult {
  order: OrderDetail;
  /** The status the order was restored to (recorded when it was cancelled). */
  restoredStatus: OrderStatus;
  /** true when the order was not cancelled (or another revert already won) - nothing changed on this call. */
  alreadyActive: boolean;
}

export interface ListOrdersQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatusFilter;
  source?: OrderSource;
  salespersonId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

// Decimal columns are sent as strings so no precision is lost in JSON.
type Money = string;

export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  source: OrderSource;
  currency: string;
  totalAmount: Money;
  itemCount: number;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  // Order number in the external system (e.g. Shopify's "#TST1002"); null for CRM-created orders.
  externalNumber: string | null;
  createdAt: Date;
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

export interface OrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  source: OrderSource;
  currency: string;
  subtotal: Money;
  discountAmount: Money;
  taxAmount: Money;
  shippingAmount: Money;
  totalAmount: Money;
  discountReason: string | null;
  externalNumber: string | null;
  shippingAddress: Record<string, string | null> | null;
  shippingPincode: string | null;
  /** Packed parcel weight (kg) as entered by a person; null when none was recorded. */
  parcelWeightKg: string | null;
  cancelReason: string | null;
  shopifyCancellation: ShopifyCancelResult | null;
  // Last Cashfree-link cancellation outcome (Order.metadata); the live state is derivable from `payments`.
  paymentLinkCancellation: PaymentLinkCancelResult | null;
  // Last Shopify payment-reconciliation outcome (Order.metadata) - set once a Cashfree payment on this order settles.
  shopifyPaymentSync: { status: "synced" | "failed"; reason?: string; syncedAt?: string; failedAt?: string } | null;
  // Who confirmed the order in the CRM (current confirmer; earlier ones are in the audit history). Null = not confirmed from the CRM.
  confirmedBy: { id: string; name: string } | null;
  // "CRM Confirmed by <name>" - derived from confirmedBy, shown as a tag in the CRM and written to the linked Shopify order.
  confirmationTag: string | null;
  // Outcome of the last Shopify tag sync (Order.metadata); null when none was attempted (not linked / not confirmed).
  shopifyConfirmationTag: { status: "synced" | "failed"; tag?: string; reason?: string; syncedAt?: string; failedAt?: string } | null;
  // Null when nothing was ever sent/attempted. Only a safe reason is stored (never a URL or credential).
  whatsappNotification: OrderWhatsAppNotification | null;
  createdAt: Date;
  placedAt: Date | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  // Reconciliation breakdown, derived the same way as the reconciliation module so the two never disagree.
  paidAmount: Money;
  refundedAmount: Money;
  outstandingAmount: Money;
  /** Refund approval workflow: per-payment eligibility/balance and the order's refund requests. Display only. */
  refunds: OrderRefundInfo;
  reconciliationStatus: ReconciliationStatus;
  customer: {
    leadId: string;
    leadNumber: string;
    name: string;
    mobile: string | null;
    email: string | null;
  };
  leadSource: { id: string; name: string } | null;
  // Salesperson who booked the order (null for website/API orders).
  bookedBy: { id: string; name: string; username: string } | null;
  // Current owner of the original lead.
  leadOwner: { id: string; name: string } | null;
  items: OrderItemDetail[];
  payments: PaymentDetail[];
  shipments: OrderShipmentDetail[];
  // Live snapshot fetched directly from Shopify for a synced order (Order.externalId set) - see
  // orders.service.ts's getOrder(). null when the order has no Shopify link, was never fetched, or
  // Shopify couldn't be reached (see shopifyLiveError). The CRM's own fields above are never replaced
  // by this - it's an additive overlay only.
  shopifyLive: NormalizedOrder | null;
  shopifyLiveError?: string;
}

export interface OrderItemDetail {
  id: string;
  productId: string | null;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: Money;
  discountAmount: Money;
  taxAmount: Money;
  totalPrice: Money;
  /** Recorded catalog weight of one unit (kg); null = not recorded. Never the parcel weight. */
  unitWeightKg: string | null;
  /** Recorded per-unit product dimensions (cm), or null. Product dimensions only - never the packed parcel size. */
  unitDimensionsCm: { lengthCm: string; widthCm: string; heightCm: string } | null;
}

export interface PaymentDetail {
  id: string;
  status: PaymentStatus;
  method: PaymentMethod | null;
  amount: Money;
  currency: string;
  provider: string | null;
  providerPaymentId: string | null;
  transactionReference: string | null;
  paidAt: Date | null;
  failedAt: Date | null;
  refundedAt: Date | null;
  refundedAmount: Money | null;
  failureReason: string | null;
  createdAt: Date;
  // Where the payment record comes from: Shopify sync, or a Cashfree payment link the CRM created. Null for CRM-native rows.
  source: ExternalSource | null;
  // Set only for a Cashfree payment link; paymentUrl is what the customer pays through.
  paymentUrl: string | null;
  paymentExpiresAt: Date | null;
}

// A shipment with no tracking/courier/dates yet (Shopify created the fulfilment record but has not
// reported those fields) is not the same as "no shipment at all" - null fields mean "not known".
export interface ShipmentDetail {
  id: string;
  status: ShipmentStatus;
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  createdAt: Date;
  // Live from Shiprocket (see shiprocket.live-tracking.ts) - undefined when this shipment has no AWB.
  liveTracking?: LiveTracking;
}

// A shipment as the order detail shows it: the fields above plus where the record comes from and, for a shipment the CRM
// created directly in Shiprocket, its operational data.
export interface OrderShipmentDetail extends ShipmentDetail {
  // Where the shipment record comes from: Shopify's fulfilment, or a shipment the CRM created directly in Shiprocket.
  source: ExternalSource | null;
  // Shiprocket operational data, only on a directly created shipment.
  providerStatus: string | null;
  labelUrl: string | null;
  pickupScheduledAt: Date | null;
  shiprocketOrderId: string | null;
  /** Parcel weight (kg) this shipment was created with; null when not recorded. */
  weightKg: string | null;
  // On a Shopify-derived shipment: the direct Shiprocket shipment carrying the same AWB, i.e. the same parcel. Derived
  // when read, never stored, so it can not drift out of date.
  linkedShipmentId: string | null;
}

export type StatusHistoryEvent = "CREATED" | "PLACED" | "CONFIRMED" | "CANCELLED" | "STATUS_CHANGE";

export interface StatusHistoryEntry {
  id: string;
  event: StatusHistoryEvent;
  title: string;
  description: string | null;
  occurredAt: Date;
  actor: { id: string; name: string } | null;
  // ACTIVITY: a recorded activity row. ORDER_RECORD: derived from a timestamp on the order itself.
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
  /** The CRM's own lead sources (the same list leads use) - not a second list. */
  leadSources: { id: string; name: string }[];
}
