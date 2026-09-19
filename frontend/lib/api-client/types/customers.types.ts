import type { OrderSource, OrderStatus, PaymentMode, PaymentStatus } from "./orders.types";

export type LeadWorkingStatus = "NEW" | "ASSIGNED" | "WORKING" | "INTERESTED" | "EXPIRED" | "CONVERTED" | "CLOSED";
export type LeadPriority = "LOW" | "MEDIUM" | "HIGH";

export interface CustomerProfile {
  leadId: string;
  leadNumber: string;
  name: string;
  mobile: string | null;
  email: string | null;
  source: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  workingStatus: LeadWorkingStatus;
  priority: LeadPriority;
  createdAt: string;
  lastActivityAt: string | null;
  lastContactedAt: string | null;
}

export interface CustomerOrderSummary {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  source: OrderSource;
  createdAt: string;
  currency: string;
  totalAmount: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
}

export interface CustomerPaymentSummary {
  orderCount: number;
  totalOrderValue: string;
  totalPaid: string;
  totalPending: string;
  totalFailed: string;
  totalRefunded: string;
  successfulPaymentCount: number;
  pendingPaymentCount: number;
  failedPaymentCount: number;
  refundedPaymentCount: number;
  codOrderCount: number;
  codValue: string;
  prepaidOrderCount: number;
  prepaidValue: string;
}

export interface Customer360 {
  profile: CustomerProfile;
  paymentSummary: CustomerPaymentSummary;
  latestOrder: CustomerOrderSummary | null;
  currentOrderStatus: OrderStatus | null;
  orders: CustomerOrderSummary[];
}

export type TimelineEventType =
  | "LEAD_CREATED"
  | "ASSIGNMENT"
  | "REASSIGNMENT"
  | "CALL"
  | "INTERESTED_STARTED"
  | "INTERESTED_ENDED"
  | "TASK"
  | "ORDER_CREATED"
  | "ORDER_PLACED"
  | "ORDER_CONFIRMED"
  | "ORDER_STATUS_CHANGE"
  | "ORDER_CANCELLED"
  | "PAYMENT"
  | "ABANDONMENT"
  | "ABANDONMENT_RECOVERED"
  | "RECOVERY_ACTION";

export interface TimelineEntry {
  id: string;
  type: TimelineEventType;
  title: string;
  description: string | null;
  occurredAt: string;
  actor: { id: string; name: string } | null;
  order: { id: string; orderNumber: string; externalNumber: string | null } | null;
  source: "ACTIVITY" | "RECORD";
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface CustomerTimelineResult {
  leadId: string;
  entries: TimelineEntry[];
  pagination: Pagination;
}

export interface CustomerTimelineParams {
  page: number;
  pageSize: number;
}
