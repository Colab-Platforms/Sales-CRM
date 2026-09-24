import type { OrderSource, OrderStatus, PaymentMode, PaymentStatus, PaymentStatusFilter, ShipmentDetail, ShipmentStatus } from "./orders.types";

export type LeadWorkingStatus = "NEW" | "ASSIGNED" | "RINGING" | "BUSY" | "CALL_BACK" | "FOLLOW_UP" | "SWITCHED_OFF" | "DND" | "NOT_REACHABLE" | "INTERESTED" | "NOT_INTERESTED" | "CONVERTED";
export type LeadPriority = "LOW" | "MEDIUM" | "HIGH";

// E6.7 Customer Segments - see backend segment.ts/segment.config.ts for the derivation rules.
export type CustomerSegment = "NEW" | "HOT" | "REPEAT" | "VIP" | "DORMANT" | "AT_RISK";

export interface SegmentMetrics {
  orderCount: number;
  successfulOrderCount: number;
  totalPaid: string;
  latestOrderAt: string | null;
  daysSinceLastOrder: number | null;
}

export interface CustomerSegmentInfo {
  segment: CustomerSegment;
  reason: string;
  metrics: SegmentMetrics;
}

// E6.8 Next Best Action - see backend nba.ts for the derivation rules.
export type NbaAction =
  | "FOLLOW_UP_PAYMENT"
  | "TRACK_SHIPMENT"
  | "FOLLOW_UP_DELIVERY"
  | "HANDLE_RETURN"
  | "RETENTION_FOLLOW_UP"
  | "REPEAT_PURCHASE_FOLLOW_UP"
  | "HIGH_VALUE_CUSTOMER_FOLLOW_UP"
  | "INTERESTED_LEAD_FOLLOW_UP"
  | "GENERAL_FOLLOW_UP"
  | "NO_ACTION";

export type NbaPriority = "HIGH" | "MEDIUM" | "LOW" | "NONE";

// CALL is the only channel this CRM can actually execute today (a logged phone call); EMAIL and
// WHATSAPP are reserved for a future channel integration and are never produced by the backend yet.
export type NbaChannel = "CALL" | "EMAIL" | "WHATSAPP" | "NONE";

export interface NextBestActionInfo {
  action: NbaAction;
  priority: NbaPriority;
  reason: string;
  recommendedChannel: NbaChannel;
  relatedOrderId: string | null;
  metrics: {
    outstandingAmount: string;
    totalPaid: string;
    orderCount: number;
    successfulOrderCount: number;
    daysSinceLastOrder: number | null;
  };
}

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
  latestShipment: ShipmentDetail | null;
}

export interface CustomerPaymentSummary {
  orderCount: number;
  totalOrderValue: string;
  totalPaid: string;
  totalPending: string;
  totalFailed: string;
  totalRefunded: string;
  totalOutstanding: string;
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
  segment: CustomerSegmentInfo;
  nextBestAction: NextBestActionInfo;
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

// ---- E6.7: customer list (GET /api/customers) ----

export interface CustomersListParams {
  page: number;
  pageSize: number;
  search?: string;
  segment?: CustomerSegment;
  ownerId?: string;
  hasOrders?: boolean;
  paymentStatus?: PaymentStatusFilter;
  shipmentStatus?: ShipmentStatus;
  // ISO date-times
  dateFrom?: string;
  dateTo?: string;
  // E6.8
  nbaAction?: NbaAction;
  nbaPriority?: NbaPriority;
}

export interface CustomerListItem {
  leadId: string;
  leadNumber: string;
  name: string;
  mobile: string | null;
  segment: CustomerSegment;
  segmentReason: string;
  orderCount: number;
  totalPaid: string;
  outstandingAmount: string;
  lastOrderAt: string | null;
  currentOrderStatus: OrderStatus | null;
  currentPaymentStatus: PaymentStatus | null;
  currentShipmentStatus: ShipmentStatus | null;
  owner: { id: string; name: string } | null;
  nbaAction: NbaAction;
  nbaPriority: NbaPriority;
  nbaReason: string;
}

export interface CustomerListResult {
  items: CustomerListItem[];
  pagination: Pagination;
}
