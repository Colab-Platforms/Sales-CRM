import type { OrderSource, OrderStatus, PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";

// How the customer pays: cash on delivery, or up front by any other method. Null when the method is not known.
export type PaymentMode = "COD" | "PREPAID";

// Filter value for orders that have no payment record yet.
export const NO_PAYMENT = "NONE" as const;
export type PaymentStatusFilter = PaymentStatus | typeof NO_PAYMENT;

// `Activity.referenceType` value for rows that point at an order.
export const ORDER_REFERENCE_TYPE = "Order";

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
  cancelReason: string | null;
  createdAt: Date;
  placedAt: Date | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
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
  // Salesperson who booked the order (null for website/API orders).
  bookedBy: { id: string; name: string; email: string } | null;
  // Current owner of the original lead.
  leadOwner: { id: string; name: string } | null;
  items: OrderItemDetail[];
  payments: PaymentDetail[];
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
}
