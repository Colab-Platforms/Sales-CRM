import { timingSafeEqual } from "node:crypto";
import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import { asRecord, asString, headerOf, sha256Hex } from "../integrations/integrations.common.js";

// Turns a Shiprocket tracking webhook into a small description of what happened, and Shiprocket's status wording into
// the CRM's ShipmentStatus. This is the one place that knows Shiprocket's payload shape and status text.
//
// Shiprocket's webhook (configured under Settings > API > Webhooks) is a JSON POST carrying, among other fields,
// awb, current_status, order_id (the channel order id the CRM sent), sr_order_id (Shiprocket's own id), courier_name,
// etd, is_return and a "scans" list. Authentication is a shared token Shiprocket sends as the x-api-key header.
//
// UNCONFIRMED until a real delivery is received: the exact field names above come from Shiprocket's webhook
// description and community integrations, not from a page that could be read here; and whether a delivery id exists
// (none is assumed - the body's hash is used). The timestamp inside the payload is deliberately not trusted or parsed:
// a status change is stamped with the time the CRM received it.

export interface ShiprocketEvent {
  awb: string | null;
  currentStatus: string | null;
  srOrderId: string | null;
  channelOrderId: string | null;
  courierName: string | null;
  etd: Date | null;
  isReturn: boolean;
}

export function verifyShiprocketToken(headers: Record<string, string | string[] | undefined>, token: string): boolean {
  const given = headerOf(headers, "x-api-key")?.trim();
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const deliveryId = (rawBody: Buffer): string => `sha256:${sha256Hex(rawBody)}`;

/** "2023-05-23 11:43:52" (no zone) is read as India Standard Time, since Shiprocket reports Indian shipments. */
export function parseEtd(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}+05:30`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseShiprocketEvent(payload: unknown): ShiprocketEvent | null {
  const body = asRecord(payload);
  const event: ShiprocketEvent = {
    awb: asString(body.awb) ?? asString(body.awb_code),
    currentStatus: asString(body.current_status) ?? asString(body.shipment_status),
    srOrderId: asString(body.sr_order_id),
    channelOrderId: asString(body.order_id),
    courierName: asString(body.courier_name),
    etd: parseEtd(body.etd),
    isReturn: body.is_return === 1 || body.is_return === "1" || body.is_return === true,
  };
  if (!event.awb && !event.srOrderId && !event.channelOrderId) return null;
  return event;
}

const normalize = (text: string) => text.toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

// Only statuses whose meaning is unambiguous are mapped. Anything else (RTO in transit, undelivered, lost...) leaves
// the CRM status where it is; the raw wording is still stored on the shipment so it stays visible.
const STATUS_MAP: Record<string, ShipmentStatus> = {
  NEW: ShipmentStatus.CREATED,
  "AWB ASSIGNED": ShipmentStatus.AWB_ASSIGNED,
  "READY TO SHIP": ShipmentStatus.AWB_ASSIGNED,
  "PICKUP SCHEDULED": ShipmentStatus.PICKUP_SCHEDULED,
  "PICKUP GENERATED": ShipmentStatus.PICKUP_SCHEDULED,
  "PICKUP QUEUED": ShipmentStatus.PICKUP_SCHEDULED,
  "PICKUP RESCHEDULED": ShipmentStatus.PICKUP_SCHEDULED,
  "OUT FOR PICKUP": ShipmentStatus.PICKUP_SCHEDULED,
  "PICKED UP": ShipmentStatus.SHIPPED,
  SHIPPED: ShipmentStatus.SHIPPED,
  "IN TRANSIT": ShipmentStatus.IN_TRANSIT,
  "REACHED AT DESTINATION HUB": ShipmentStatus.IN_TRANSIT,
  "OUT FOR DELIVERY": ShipmentStatus.OUT_FOR_DELIVERY,
  DELIVERED: ShipmentStatus.DELIVERED,
  "RTO DELIVERED": ShipmentStatus.RETURNED,
  CANCELED: ShipmentStatus.CANCELLED,
  CANCELLED: ShipmentStatus.CANCELLED,
};

export function mapShiprocketStatus(text: string | null | undefined): ShipmentStatus | null {
  return text ? (STATUS_MAP[normalize(text)] ?? null) : null;
}
