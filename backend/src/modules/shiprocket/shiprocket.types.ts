import type { OrderSource, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { PaymentMode } from "../orders/orders.types.js";

// Types for the centralized Shiprocket shipment listing/tracking page. Distinct from ShipmentResult in
// shiprocket.shipments.service.ts, which is the result of an action (create/assign/pickup/label/track), not a read model.

export interface ListShipmentsQuery {
  page: number;
  pageSize: number;
  // Order number, AWB, customer name or mobile.
  search?: string;
  status?: ShipmentStatus;
  courier?: string;
  paymentMode?: PaymentMode;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

// Counts across every Shiprocket shipment matching the current filters (not just the current page), grouped the way
// the summary cards show them. Real ShipmentStatus values only - see shiprocket.list.filters.ts for the grouping.
export interface ShipmentSummary {
  total: number;
  pending: number;
  inTransit: number;
  outForDelivery: number;
  delivered: number;
  returned: number;
  cancelled: number;
}

export interface ShipmentListItem {
  id: string;
  status: ShipmentStatus;
  providerStatus: string | null;
  courier: string | null;
  awb: string | null;
  amount: string;
  currency: string;
  paymentMode: PaymentMode | null;
  destinationCity: string | null;
  destinationState: string | null;
  destinationPincode: string | null;
  createdAt: Date;
  updatedAt: Date;
  order: { id: string; orderNumber: string; externalNumber: string | null; source: OrderSource };
  customer: { leadId: string; leadNumber: string; name: string; mobile: string | null };
}

export interface ListShipmentsResult {
  items: ShipmentListItem[];
  summary: ShipmentSummary;
  pagination: Pagination;
}

export interface ShipmentFilterOptions {
  couriers: string[];
}

// The centralized detail view: everything ShipmentListItem has, plus what only the order/shipment record itself
// carries. Package weight/dimensions are deliberately absent - they are sent to Shiprocket when a shipment is
// created but never stored back on the row, so there is nothing real to show.
export interface ShipmentDetailResult extends ShipmentListItem {
  trackingUrl: string | null;
  labelUrl: string | null;
  pickupScheduledAt: Date | null;
  expectedDeliveryAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  shiprocketOrderId: string | null;
  channelOrderId: string | null;
  destinationAddress1: string | null;
  destinationAddress2: string | null;
  destinationCountry: string | null;
  customerEmail: string | null;
}
