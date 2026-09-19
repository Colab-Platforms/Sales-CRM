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
  createdAt: string;
  placedAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
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
