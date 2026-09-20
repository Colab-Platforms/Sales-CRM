import type {
  LeadPriority,
  LeadWorkingStatus,
  OrderSource,
  OrderStatus,
  PaymentStatus,
  ShipmentStatus,
} from "../../../generated/prisma/enums.js";
import type { PaymentMode, PaymentStatusFilter, ShipmentDetail } from "../orders/orders.types.js";
import type { CustomerSegment, SegmentMetrics } from "./segment.js";
import type { NbaAction, NbaChannel, NbaPriority } from "./nba.js";

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
  totalOutstanding: Money;
  successfulPaymentCount: number;
  pendingPaymentCount: number;
  failedPaymentCount: number;
  refundedPaymentCount: number;
  codOrderCount: number;
  codValue: Money;
  prepaidOrderCount: number;
  prepaidValue: Money;
}

// E6.7: the customer's lifecycle segment - see segment.ts for the rules and segment.config.ts for
// the thresholds. `metrics` only surfaces figures that are meaningful on their own to a CRM user.
export interface CustomerSegmentInfo {
  segment: CustomerSegment;
  reason: string;
  metrics: SegmentMetrics;
}

// E6.8: the customer's recommended Next Best Action - see nba.ts for the rules. Derived at query
// time from the segment + orders above; never stored, never triggers a write of its own.
export interface NextBestActionInfo {
  action: NbaAction;
  priority: NbaPriority;
  reason: string;
  recommendedChannel: NbaChannel;
  relatedOrderId: string | null;
  metrics: {
    outstandingAmount: Money;
    totalPaid: Money;
    orderCount: number;
    successfulOrderCount: number;
    daysSinceLastOrder: number | null;
  };
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

// ---- E6.7: customer list (GET /api/customers) ----

export interface ListCustomersQuery {
  page: number;
  pageSize: number;
  search?: string;
  segment?: CustomerSegment;
  ownerId?: string;
  hasOrders?: boolean;
  // The customer's CURRENT (latest) order's derived payment/shipment state - reuses the same
  // filter values Orders/Reconciliation already use, not a new vocabulary.
  paymentStatus?: PaymentStatusFilter;
  shipmentStatus?: ShipmentStatus;
  dateFrom?: Date;
  dateTo?: Date;
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
  lastOrderAt: Date | null;
  currentOrderStatus: OrderStatus | null;
  currentPaymentStatus: PaymentStatus | null;
  currentShipmentStatus: ShipmentStatus | null;
  owner: { id: string; name: string } | null;
  // E6.8: enough to show and filter by in the list without a per-customer request; the full detail
  // (channel, related order, metrics) is on Customer 360 / the dedicated NBA endpoint.
  nbaAction: NbaAction;
  nbaPriority: NbaPriority;
  nbaReason: string;
}

export interface CustomerListResult {
  items: CustomerListItem[];
  pagination: Pagination;
}
