import type {
  LeadPriority,
  LeadWorkingStatus,
  OrderSource,
  OrderStatus,
  PaymentStatus,
} from "../../../generated/prisma/enums.js";
import type { PaymentMode, ShipmentDetail } from "../orders/orders.types.js";

// Decimal columns are sent as strings so no precision is lost in JSON.
type Money = string;

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
  createdAt: Date;
  lastActivityAt: Date | null;
  lastContactedAt: Date | null;
}

export interface CustomerOrderSummary {
  id: string;
  orderNumber: string;
  externalNumber: string | null;
  source: OrderSource;
  createdAt: Date;
  currency: string;
  totalAmount: Money;
  status: OrderStatus;
  paymentStatus: PaymentStatus | null;
  paymentMode: PaymentMode | null;
  // The order's most recently updated shipment/fulfilment, if any has been synced.
  latestShipment: ShipmentDetail | null;
}

export interface CustomerPaymentSummary {
  orderCount: number;
  totalOrderValue: Money;
  totalPaid: Money;
  totalPending: Money;
  totalFailed: Money;
  totalRefunded: Money;
  successfulPaymentCount: number;
  pendingPaymentCount: number;
  failedPaymentCount: number;
  refundedPaymentCount: number;
  codOrderCount: number;
  codValue: Money;
  prepaidOrderCount: number;
  prepaidValue: Money;
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
  | "SHIPMENT_SHIPPED"
  | "SHIPMENT_DELIVERED"
  | "SHIPMENT_RETURNED"
  | "ABANDONMENT"
  | "ABANDONMENT_RECOVERED"
  | "RECOVERY_ACTION";

export interface TimelineEntry {
  id: string;
  type: TimelineEventType;
  title: string;
  description: string | null;
  occurredAt: Date;
  actor: { id: string; name: string } | null;
  // Present for order/payment related entries so the UI can link back to the order.
  order: { id: string; orderNumber: string; externalNumber: string | null } | null;
  // ACTIVITY: a recorded Activity row. RECORD: derived directly from the source table's own timestamp.
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

export interface ListCustomerTimelineQuery {
  page: number;
  pageSize: number;
}
