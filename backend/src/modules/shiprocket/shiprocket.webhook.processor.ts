import { ActivitySource } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { safeMessage, type TxRunner } from "../integrations/integrations.common.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import { applyShipmentUpdate, type ShipmentUpdate } from "./shiprocket.apply.js";
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
      const or: Prisma.ShipmentWhereInput[] = [];
      if (event.awb) or.push({ trackingNumber: event.awb });
      if (event.srOrderId) or.push({ providerOrderId: event.srOrderId });
      if (event.channelOrderId) or.push({ channelOrderId: event.channelOrderId });
      const shipment = await tx.shipment.findFirst({ where: { externalSource: "SHIPROCKET", OR: or }, select: { id: true } });
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
