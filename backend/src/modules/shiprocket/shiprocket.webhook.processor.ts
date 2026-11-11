import { ActivitySource, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { advisoryLock, safeMessage, type TxRunner } from "../integrations/integrations.common.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import { applyShipmentUpdate, shipmentOrderLockKey, type ShipmentUpdate } from "./shiprocket.apply.js";
import { mapShiprocketStatus, parseShiprocketEvent, type ShiprocketEvent } from "./shiprocket.events.js";

// Turns a stored Shiprocket delivery into an update of the CRM shipment it belongs to. It only ever updates a shipment
// the CRM itself created through Shiprocket (externalSource SHIPROCKET). A delivery that matches none - for instance a
// parcel the store's Shopify-Shiprocket app manages, whose shipment data belongs to Shopify sync - is ignored.

export type ProcessOutcome = "processed" | "ignored" | "retry" | "failed" | "skipped";

export interface ShiprocketProcessorDeps {
  store: WebhookStore;
  runner: TxRunner;
  now?: () => Date;
}

export function eventToUpdate(event: ShiprocketEvent): ShipmentUpdate {
  return {
    // A return (reverse) shipment is a different flow whose "delivered" means something else; only its wording is kept.
    status: event.isReturn ? null : mapShiprocketStatus(event.currentStatus),
    providerStatus: event.currentStatus,
    courier: event.courierName,
    awb: event.awb,
    expectedDeliveryAt: event.etd,
    meta: event.srOrderId ? { srOrderId: event.srOrderId } : undefined,
  };
}

type Tx = Parameters<Parameters<TxRunner["$transaction"]>[0]>[0];
const bareRef = (v: string | null | undefined) => (v ?? "").replace(/^#/, "").trim();

/**
 * The CRM shipment this event belongs to, by the identity Shiprocket itself reports - in order of strength: its order id, the AWB, the order reference the CRM sent. NEVER by the CRM order's Shopify number:
 * two live Shiprocket orders can exist for one sale (the CRM's own CRM-... order and the AWL... order the Shopify channel imported), and each has its own events. A match is refused when the event names a
 * Shiprocket order id and the shipment holds a DIFFERENT one, so an event of one order can never be applied to the other's record - not even through a shared AWB or reference.
 */
async function findOwnShipment(tx: Tx, event: ShiprocketEvent): Promise<{ id: string } | null> {
  const tries: Prisma.ShipmentWhereInput[] = [];
  if (event.srOrderId) tries.push({ providerOrderId: event.srOrderId });
  if (event.awb) tries.push({ trackingNumber: event.awb });
  if (event.channelOrderId) tries.push({ channelOrderId: event.channelOrderId });
  for (const where of tries) {
    const rows = await tx.shipment.findMany({ where: { externalSource: "SHIPROCKET", ...where }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, providerOrderId: true } });
    const own = rows.find((s) => !(event.srOrderId && s.providerOrderId && s.providerOrderId !== event.srOrderId));
    if (own) return { id: own.id };
  }
  return null;
}

/**
 * A tracking event for a Shiprocket order the CRM holds no record of, whose reference is the Shopify number of exactly ONE CRM-created order: this is the order Shiprocket's Shopify channel imported for that
 * sale. The CRM keeps a record of it of its own (the real Shiprocket order id and AWB), SEPARATE from any idle CRM-reference shipment of the same order, so tracking lands on the right parcel and a later
 * cancellation of the idle twin only ever touches the twin's own record. Nothing is created in Shiprocket; this is a CRM-side row only. Repeats find the row by its ids (see findOwnShipment).
 */
async function trackImportedOrder(tx: Tx, event: ShiprocketEvent, now: Date): Promise<{ id: string } | null> {
  const ref = bareRef(event.channelOrderId);
  if (!event.srOrderId || !ref || event.isReturn) return null;
  const status = mapShiprocketStatus(event.currentStatus);
  if (status === ShipmentStatus.CANCELLED || status === ShipmentStatus.RETURNED) return null; // never record a parcel only to cancel it
  const orders = await tx.order.findMany({
    where: { source: "SALESPERSON", externalNumber: { in: [ref, `#${ref}`] } },
    take: 2,
    select: { id: true, orderNumber: true, externalNumber: true, shipments: { where: { externalSource: "SHIPROCKET" }, select: { channelOrderId: true } } },
  });
  if (orders.length !== 1) return null; // none, or ambiguous: never guess
  const order = orders[0]!;
  if (order.shipments.some((s) => bareRef(s.channelOrderId).toLowerCase() === ref.toLowerCase())) return null; // the CRM already holds a shipment under this very reference: a true twin, left for a person
  await advisoryLock(tx, shipmentOrderLockKey(order.id));
  const created = await tx.shipment.create({
    data: {
      orderId: order.id,
      status: status ?? ShipmentStatus.CREATED,
      externalSource: "SHIPROCKET",
      externalId: event.shipmentId ?? `sr-order:${event.srOrderId}`,
      providerOrderId: event.srOrderId,
      channelOrderId: event.channelOrderId,
      metadata: { shiprocket: { importedByShopifyChannel: true, trackedFromWebhook: now.toISOString(), crmOrderNumber: order.orderNumber, shopifyOrderName: order.externalNumber } },
    },
    select: { id: true },
  });
  return created;
}

export async function processShiprocketEvent(eventId: string, deps: ShiprocketProcessorDeps): Promise<ProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const stored = await deps.store.claim(eventId, now());
  if (!stored) return "skipped";

  try {
    const event = parseShiprocketEvent(stored.payload);
    if (!event) {
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }

    const applied = await deps.runner.$transaction(async (tx) => {
      const shipment = (await findOwnShipment(tx, event)) ?? (await trackImportedOrder(tx, event, now()));
      if (!shipment) return null;
      return applyShipmentUpdate(tx, shipment.id, eventToUpdate(event), { source: ActivitySource.SHIPROCKET_WEBHOOK, now: now() });
    });

    if (!applied || applied.outcome === "not_found") {
      logger.info("Shiprocket webhook matched no CRM-created shipment; ignored");
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }
    await deps.store.complete(eventId, "PROCESSED", now());
    return "processed";
  } catch (error) {
    const exhausted = stored.attempts >= MAX_ATTEMPTS;
    await deps.store.fail(eventId, safeMessage(error instanceof Error ? error.message : String(error)), exhausted ? null : new Date(now().getTime() + backoffMs(stored.attempts)));
    return exhausted ? "failed" : "retry";
  }
}
