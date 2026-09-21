import { ActivitySource, ActivityType, ShipmentStatus, type Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { advisoryLock, asRecord, type Db } from "../integrations/integrations.common.js";

// The single place a Shiprocket result is applied to a CRM Shipment. The webhook processor, the manual "refresh
// tracking" action and every operational step (AWB, pickup, label) all go through it.
//
// Rules:
//  - Only rows the CRM created through Shiprocket (externalSource SHIPROCKET) are touched. Shopify sync only ever loads
//    and deletes rows tagged SHOPIFY, so it can neither overwrite nor delete these.
//  - Status only moves forward (see canAdvance), so a late or repeated event can never undo progress.
//  - Nothing here changes Order.status: that field is owned by Shopify sync and would be overwritten by the next sync.

export const SHIPMENT_REFERENCE_TYPE = "Shipment";
export const shipmentOrderLockKey = (orderId: string) => `shiprocket:order:${orderId}`;

const RANK: Record<ShipmentStatus, number> = {
  CREATED: 0,
  AWB_ASSIGNED: 1,
  PICKUP_SCHEDULED: 2,
  SHIPPED: 3,
  IN_TRANSIT: 4,
  OUT_FOR_DELIVERY: 5,
  DELIVERED: 6,
  RETURNED: 6,
  CANCELLED: 6,
};

const TERMINAL = new Set<ShipmentStatus>([ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED, ShipmentStatus.CANCELLED]);
const PRE_PICKUP = new Set<ShipmentStatus>([ShipmentStatus.CREATED, ShipmentStatus.AWB_ASSIGNED, ShipmentStatus.PICKUP_SCHEDULED]);

export function canAdvance(from: ShipmentStatus, to: ShipmentStatus): boolean {
  if (from === to || TERMINAL.has(from)) return false;
  // A shipment can only be cancelled before the courier has it.
  if (to === ShipmentStatus.CANCELLED) return PRE_PICKUP.has(from);
  // Return to origin can begin at any point after pickup.
  if (to === ShipmentStatus.RETURNED) return !PRE_PICKUP.has(from);
  return RANK[to] > RANK[from];
}

export interface ShipmentUpdate {
  status?: ShipmentStatus | null;
  /** The provider's own status wording, kept exactly as reported. */
  providerStatus?: string | null;
  awb?: string | null;
  courier?: string | null;
  courierCompanyId?: number | null;
  trackingUrl?: string | null;
  expectedDeliveryAt?: Date | null;
  pickupScheduledAt?: Date | null;
  labelUrl?: string | null;
  providerOrderId?: string | null;
  meta?: Record<string, unknown>;
  /** Audit event for what this update means, used when the status itself does not describe it (AWB, pickup, label). */
  activity?: { type: ActivityType; title: string };
}

export interface ShipmentApplyContext {
  source: ActivitySource;
  actor?: { id: string; role: Role } | null;
  now?: Date;
}

export type ShipmentApplyResult =
  | { outcome: "not_found" }
  | { outcome: "unchanged"; orderId: string; leadId: string }
  | { outcome: "updated"; orderId: string; leadId: string; from: ShipmentStatus; to: ShipmentStatus };

export async function applyShipmentUpdate(tx: Db, shipmentId: string, update: ShipmentUpdate, ctx: ShipmentApplyContext): Promise<ShipmentApplyResult> {
  const now = ctx.now ?? new Date();
  const head = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true } });
  if (!head) return { outcome: "not_found" };
  await advisoryLock(tx, shipmentOrderLockKey(head.orderId));

  const shipment = await tx.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      orderId: true,
      status: true,
      courier: true,
      trackingNumber: true,
      trackingUrl: true,
      labelUrl: true,
      providerStatus: true,
      providerOrderId: true,
      courierCompanyId: true,
      externalSource: true,
      externalId: true,
      shippedAt: true,
      metadata: true,
      order: { select: { leadId: true, orderNumber: true, externalNumber: true } },
    },
  });
  if (!shipment || shipment.externalSource !== "SHIPROCKET") return { outcome: "not_found" };
  const { leadId } = shipment.order;
  const orderRef = shipment.order.externalNumber ?? shipment.order.orderNumber;

  const from = shipment.status;
  const moves = !!update.status && canAdvance(from, update.status);
  const to = moves ? update.status! : from;

  const data: Prisma.ShipmentUncheckedUpdateInput = {};
  if (moves) {
    data.status = to;
    if (to === ShipmentStatus.SHIPPED && !shipment.shippedAt) data.shippedAt = now;
    if ((to === ShipmentStatus.IN_TRANSIT || to === ShipmentStatus.OUT_FOR_DELIVERY) && !shipment.shippedAt) data.shippedAt = now;
    if (to === ShipmentStatus.DELIVERED) data.deliveredAt = now;
    if (to === ShipmentStatus.RETURNED) data.returnedAt = now;
  }
  // Wording, identifiers and dates are recorded whenever they are new, even if the status itself does not move.
  if (update.providerStatus && update.providerStatus !== shipment.providerStatus) data.providerStatus = update.providerStatus.slice(0, 150);
  const awbChanged = !!update.awb && update.awb !== shipment.trackingNumber;
  if (awbChanged) data.trackingNumber = update.awb!.slice(0, 150);
  const courierChanged = !!update.courier && update.courier !== shipment.courier;
  if (courierChanged) data.courier = update.courier!.slice(0, 150);
  if (update.courierCompanyId != null && update.courierCompanyId !== shipment.courierCompanyId) data.courierCompanyId = update.courierCompanyId;
  const trackingUrlChanged = !!update.trackingUrl && update.trackingUrl !== shipment.trackingUrl;
  if (trackingUrlChanged) data.trackingUrl = update.trackingUrl;
  if (update.expectedDeliveryAt) data.expectedDeliveryAt = update.expectedDeliveryAt;
  if (update.pickupScheduledAt) data.pickupScheduledAt = update.pickupScheduledAt;
  if (update.labelUrl && update.labelUrl !== shipment.labelUrl) data.labelUrl = update.labelUrl;
  if (update.providerOrderId && update.providerOrderId !== shipment.providerOrderId) data.providerOrderId = update.providerOrderId.slice(0, 100);
  if (update.meta) {
    const existing = asRecord(shipment.metadata);
    data.metadata = { ...existing, shiprocket: { ...asRecord(existing.shiprocket), ...update.meta, lastEventAt: now.toISOString() } } as Prisma.InputJsonValue;
  }

  if (Object.keys(data).length === 0) return { outcome: "unchanged", orderId: shipment.orderId, leadId };
  await tx.shipment.update({ where: { id: shipment.id }, data });

  const base = { leadId, orderId: shipment.orderId, actorId: ctx.actor?.id ?? null, actorRole: ctx.actor?.role ?? null, source: ctx.source, referenceType: SHIPMENT_REFERENCE_TYPE, referenceId: shipment.id, createdAt: now };
  const meta = { provider: "SHIPROCKET", providerShipmentId: shipment.externalId };
  const rows: Prisma.ActivityCreateManyInput[] = [];

  if (update.activity) {
    rows.push({ ...base, type: update.activity.type, title: update.activity.title, newValue: { status: to, awb: update.awb ?? shipment.trackingNumber, courier: update.courier ?? shipment.courier }, metadata: meta });
  } else if (awbChanged || courierChanged) {
    rows.push({ ...base, type: ActivityType.TRACKING_UPDATED, title: `Tracking updated for order ${orderRef}`, oldValue: { courier: shipment.courier, trackingNumber: shipment.trackingNumber }, newValue: { courier: update.courier ?? shipment.courier, trackingNumber: update.awb ?? shipment.trackingNumber }, metadata: meta });
  }
  if (moves) {
    rows.push({ ...base, type: ActivityType.SHIPMENT_STATUS_CHANGED, title: `Shipment status changed for order ${orderRef}`, description: `${from} -> ${to}`, oldValue: { status: from }, newValue: { status: to, providerStatus: update.providerStatus ?? null }, metadata: meta });
  }
  if (rows.length > 0) await tx.activity.createMany({ data: rows });

  return moves ? { outcome: "updated", orderId: shipment.orderId, leadId, from, to } : { outcome: "unchanged", orderId: shipment.orderId, leadId };
}
