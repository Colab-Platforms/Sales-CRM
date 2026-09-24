import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { derivePaymentMode, fullName } from "../orders/orders.filters.js";
import type { PaymentMode } from "../orders/orders.types.js";
import { asRecord } from "../integrations/integrations.common.js";
import type { ListShipmentsQuery, ShipmentDetailResult, ShipmentListItem, ShipmentSummary } from "./shiprocket.types.js";

// Where-building, row-mapping and summary logic for the centralized Shiprocket listing. Kept separate from
// shiprocket.shipments.service.ts (which drives the Shiprocket API and shipment lifecycle) the same way
// orders.filters.ts is kept separate from orders.service.ts.

// Every row here is a shipment the CRM created directly through Shiprocket - Shopify-derived shipment rows
// (externalSource SHOPIFY) are a different record of a different thing (Shopify's own fulfilment) and never appear.
export const SHIPROCKET_SOURCE = { externalSource: "SHIPROCKET" } as const;

const MAX_SEARCH_TERMS = 5;

export function searchWhere(search: string): Prisma.ShipmentWhereInput {
  const terms = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  return {
    AND: terms.map((term): Prisma.ShipmentWhereInput => {
      const contains = { contains: term, mode: "insensitive" as const };
      return {
        OR: [
          { trackingNumber: contains },
          { order: { orderNumber: contains } },
          { order: { externalNumber: contains } },
          { order: { lead: { firstName: contains } } },
          { order: { lead: { lastName: contains } } },
          { order: { lead: { mobile: contains } } },
        ],
      };
    }),
  };
}

// Exactly derivePaymentMode's own rule (COD if any payment is COD; else Prepaid if any payment has a known method),
// expressed as a database filter instead of read into memory - so it stays server-side and can never disagree with
// how the order detail page derives the same order's payment mode.
export function paymentModeWhere(mode: PaymentMode): Prisma.ShipmentWhereInput {
  if (mode === "COD") return { order: { payments: { some: { method: "COD" } } } };
  return { order: { payments: { some: { method: { not: null } }, none: { method: "COD" } } } };
}

export function buildShipmentListWhere(query: ListShipmentsQuery, leadScope: Prisma.LeadWhereInput): Prisma.ShipmentWhereInput {
  const and: Prisma.ShipmentWhereInput[] = [SHIPROCKET_SOURCE];
  if (Object.keys(leadScope).length > 0) and.push({ order: { lead: leadScope } });
  if (query.search) and.push(searchWhere(query.search));
  if (query.status) and.push({ status: query.status });
  if (query.courier) and.push({ courier: query.courier });
  if (query.paymentMode) and.push(paymentModeWhere(query.paymentMode));
  if (query.dateFrom || query.dateTo) and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  return { AND: and };
}

// One shipment, but only if it is a Shiprocket-created row inside the user's lead scope.
export function scopedShipmentWhere(id: string, leadScope: Prisma.LeadWhereInput): Prisma.ShipmentWhereInput {
  const and: Prisma.ShipmentWhereInput[] = [{ id }, SHIPROCKET_SOURCE];
  if (Object.keys(leadScope).length > 0) and.push({ order: { lead: leadScope } });
  return { AND: and };
}

// Real ShipmentStatus values grouped for the summary cards - grouping counts for display is not the same as
// inventing a status; every count still traces back to one of the 9 real enum values.
const PENDING = new Set<ShipmentStatus>([ShipmentStatus.CREATED, ShipmentStatus.AWB_ASSIGNED, ShipmentStatus.PICKUP_SCHEDULED]);
const IN_TRANSIT = new Set<ShipmentStatus>([ShipmentStatus.SHIPPED, ShipmentStatus.IN_TRANSIT]);

export function buildShipmentSummary(counts: { status: ShipmentStatus; _count: { _all: number } }[]): ShipmentSummary {
  const summary: ShipmentSummary = { total: 0, pending: 0, inTransit: 0, outForDelivery: 0, delivered: 0, returned: 0, cancelled: 0 };
  for (const row of counts) {
    const n = row._count._all;
    summary.total += n;
    if (PENDING.has(row.status)) summary.pending += n;
    else if (IN_TRANSIT.has(row.status)) summary.inTransit += n;
    else if (row.status === ShipmentStatus.OUT_FOR_DELIVERY) summary.outForDelivery += n;
    else if (row.status === ShipmentStatus.DELIVERED) summary.delivered += n;
    else if (row.status === ShipmentStatus.RETURNED) summary.returned += n;
    else if (row.status === ShipmentStatus.CANCELLED) summary.cancelled += n;
  }
  return summary;
}

interface AddressShape {
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  address1?: string | null;
  address2?: string | null;
  country?: string | null;
}

export interface ShipmentListRow {
  id: string;
  status: ShipmentStatus;
  providerStatus: string | null;
  courier: string | null;
  trackingNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
  order: {
    id: string;
    orderNumber: string;
    externalNumber: string | null;
    source: import("../../../generated/prisma/enums.js").OrderSource;
    currency: string;
    totalAmount: { toString(): string };
    shippingAddress: unknown;
    payments: { method: import("../../../generated/prisma/enums.js").PaymentMethod | null }[];
    lead: { id: string; leadNumber: string; firstName: string; lastName: string | null; mobile: string | null };
  };
}

export function mapShipmentListRow(row: ShipmentListRow): ShipmentListItem {
  const address = asRecord(row.order.shippingAddress) as AddressShape;
  return {
    id: row.id,
    status: row.status,
    providerStatus: row.providerStatus,
    courier: row.courier,
    awb: row.trackingNumber,
    amount: row.order.totalAmount.toString(),
    currency: row.order.currency,
    paymentMode: derivePaymentMode(row.order.payments),
    destinationCity: address.city ?? null,
    destinationState: address.province ?? null,
    destinationPincode: address.zip ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    order: { id: row.order.id, orderNumber: row.order.orderNumber, externalNumber: row.order.externalNumber, source: row.order.source },
    customer: { leadId: row.order.lead.id, leadNumber: row.order.lead.leadNumber, name: fullName(row.order.lead.firstName, row.order.lead.lastName), mobile: row.order.lead.mobile },
  };
}

export interface ShipmentDetailRow extends ShipmentListRow {
  trackingUrl: string | null;
  labelUrl: string | null;
  pickupScheduledAt: Date | null;
  expectedDeliveryAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  providerOrderId: string | null;
  channelOrderId: string | null;
  order: ShipmentListRow["order"] & { lead: ShipmentListRow["order"]["lead"] & { email: string | null } };
}

export function mapShipmentDetailRow(row: ShipmentDetailRow): ShipmentDetailResult {
  const address = asRecord(row.order.shippingAddress) as AddressShape;
  return {
    ...mapShipmentListRow(row),
    trackingUrl: row.trackingUrl,
    labelUrl: row.labelUrl,
    pickupScheduledAt: row.pickupScheduledAt,
    expectedDeliveryAt: row.expectedDeliveryAt,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
    returnedAt: row.returnedAt,
    shiprocketOrderId: row.providerOrderId,
    channelOrderId: row.channelOrderId,
    destinationAddress1: address.address1 ?? null,
    destinationAddress2: address.address2 ?? null,
    destinationCountry: address.country ?? null,
    customerEmail: row.order.lead.email,
  };
}
