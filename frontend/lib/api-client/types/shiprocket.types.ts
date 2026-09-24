import type { OrderSource, PaymentMode, Pagination, ShipmentStatus } from "./orders.types";

// The centralized Shiprocket shipment listing/tracking page ("/dashboard/shiprocket"). Distinct from
// ShipmentActionResult in integrations.types.ts, which is the result of an action (create/assign/pickup/label/track),
// not a read model - see integrations.mutations.ts for the actions this page reuses.

export interface ListShipmentsParams {
  page: number;
  pageSize: number;
  search?: string;
  status?: ShipmentStatus;
  courier?: string;
  paymentMode?: PaymentMode;
  // ISO date-times
  dateFrom?: string;
  dateTo?: string;
}

// Counts across every shipment matching the current filters (not just the current page).
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
  createdAt: string;
  updatedAt: string;
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

// Package weight/dimensions are deliberately absent - Shiprocket is given them when a shipment is created, but the CRM
// never stores them back on the row, so there is nothing real to show here.
export interface ShipmentDetailResult extends ShipmentListItem {
  trackingUrl: string | null;
  labelUrl: string | null;
  pickupScheduledAt: string | null;
  expectedDeliveryAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  shiprocketOrderId: string | null;
  channelOrderId: string | null;
  destinationAddress1: string | null;
  destinationAddress2: string | null;
  destinationCountry: string | null;
  customerEmail: string | null;
}
