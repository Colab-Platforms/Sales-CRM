import type { PaymentStatus, ShipmentStatus } from "./orders.types";

// What the backend says about the Cashfree / Shiprocket integrations. Booleans and an environment name only - the
// backend never sends a credential.
export interface IntegrationStatus {
  cashfree: { enabled: boolean; configured: boolean; environment: string | null; webhookRegistered: boolean };
  shiprocket: { enabled: boolean; configured: boolean };
}

export interface PaymentLinkResult {
  paymentId: string;
  orderId: string;
  linkId: string;
  // Money is a string so decimals are never rounded in transit.
  amount: string;
  currency: string;
  status: PaymentStatus;
  paymentUrl: string | null;
  expiresAt: string | null;
  // true when an open link for the same amount already existed and was returned instead of creating another.
  reused: boolean;
  // false when the backend has no public https address: the link works, but its status only updates via "Refresh".
  webhookRegistered: boolean;
}

export interface ShipmentActionResult {
  id: string;
  orderId: string;
  status: ShipmentStatus;
  providerStatus: string | null;
  courier: string | null;
  awb: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  pickupScheduledAt: string | null;
  expectedDeliveryAt: string | null;
  shiprocketOrderId: string | null;
  // Only on creation: how Shiprocket was told to collect payment, and how much the courier collects.
  paymentMethod?: "Prepaid" | "COD";
  collectOnDelivery?: string;
}

export interface CourierOption {
  courierId: number;
  name: string;
  rate: number | null;
  etd: string | null;
  estimatedDays: string | null;
  cod: boolean | null;
  rating: number | null;
}

// Parcel size and weight are not stored on an order, so the person creating the shipment supplies them.
export interface CreateShipmentInput {
  weight: number;
  length: number;
  breadth: number;
  height: number;
  // Only after the backend reported that a previous attempt's outcome at Shiprocket is unknown.
  acknowledgeUnconfirmed?: boolean;
}
