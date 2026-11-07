// Automatic Shiprocket submission of CRM-created orders (Telecaller / Manager / Admin, COD and prepaid).
//
// This reuses the existing shipment service (ShiprocketShipmentsService.createShipment): the same order mapping, the same pickup location, the same locking, the same "one live shipment per order"
// rule and the same ambiguity handling. It only decides WHEN to call it and records the outcome on the order (Order.metadata.shiprocketSync, see shiprocket.sync-record.ts).
//
//  - It does not look at the "Shopify sync for CRM-created orders" setting, a Shopify order id or any Shopify status: Shopify OFF/ON, created, skipped or failed make no difference here.
//  - COD: submitted as soon as the order is saved. Prepaid: the existing rule stays - a prepaid order is only submitted once its payment is verified, so until then it is AWAITING_PAYMENT.
//  - A failure never undoes the CRM order: it is recorded (FAILED + reason) and can be retried; a retry of an order that already has a live shipment submits nothing new.
//  - AWB, courier, pickup and tracking are NOT part of this: they stay the existing manual steps and the existing webhook.
import { OrderStatus, PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { logger } from "@/utils/logger.js";
import { ApiError } from "@/utils/apiError.js";
import { asRecord, safeMessage, type Db } from "../integrations/integrations.common.js";
import { prisma } from "@/lib/prisma.js";
import { isShiprocketEnabled } from "./shiprocket.config.js";
import ShiprocketShipmentsService from "./shiprocket.shipments.service.js";
import { describeMissing, parcelFromItems } from "./shiprocket.parcel.js";
import { mergeShiprocketSync, readShiprocketSync, type ShiprocketSyncRecord } from "./shiprocket.sync-record.js";

type Env = Record<string, string | undefined>;
export type ShiprocketSyncTrigger = "ORDER_CREATED" | "PAYMENT_VERIFIED" | "RETRY";
export type ShiprocketSyncOutcome = { status: ShiprocketSyncRecord["status"] | "NOT_APPLICABLE"; reason?: string; record?: ShiprocketSyncRecord | null };

export interface ShiprocketAutoSyncDeps {
  db: Db;
  service: Pick<ShiprocketShipmentsService, "createShipment">;
  env?: Env;
  now?: () => Date;
}

const DEAD = new Set<string>([ShipmentStatus.CANCELLED, ShipmentStatus.RETURNED]);
const BLOCKED = new Set<string>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);

/**
 * Submits ONE CRM-created order to Shiprocket, once. Safe to call any number of times (order created, payment callbacks, retries, repeated requests): an order that already has a live
 * Shiprocket shipment is only reported, and a concurrent call is stopped by the shipment service's own order lock. Never throws.
 */
export async function syncOrderToShiprocket(deps: ShiprocketAutoSyncDeps, orderId: string, actor: AuthUser, trigger: ShiprocketSyncTrigger): Promise<ShiprocketSyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  try {
    const order = await deps.db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        source: true,
        status: true,
        metadata: true,
        parcelWeightKg: true,
        items: { select: { quantity: true, skuSnapshot: true, productNameSnapshot: true, variantNameSnapshot: true, product: { select: { weightKg: true, lengthCm: true, widthCm: true, heightCm: true } }, variant: { select: { weightKg: true, lengthCm: true, widthCm: true, heightCm: true } } } },
        payments: { select: { status: true } },
        shipments: { where: { externalSource: "SHIPROCKET" }, select: { status: true, externalId: true } },
      },
    });
    // Only orders created in the CRM (source SALESPERSON) - never a Shopify-originated order.
    if (!order || order.source !== "SALESPERSON") return { status: "NOT_APPLICABLE" };
    if (BLOCKED.has(order.status)) return { status: "NOT_APPLICABLE", reason: `The order is ${order.status.toLowerCase()}` };
    const prior = readShiprocketSync(order.metadata);

    const live = order.shipments.find((s) => !DEAD.has(s.status));
    if (live) {
      // Already submitted (or being submitted right now by another caller): never create a second one.
      if (live.externalId?.startsWith("pending:")) return { status: "PENDING", reason: "A submission is already in progress", record: prior };
      if (prior?.status !== "SYNCED") await mergeShiprocketSync(deps.db, orderId, { status: "SYNCED", syncedAt: prior?.syncedAt ?? now.toISOString(), error: null });
      return { status: "SYNCED", reason: "Already submitted to Shiprocket", record: prior };
    }

    const prepaid = asRecord(order.metadata).paymentMode === "PREPAID";
    if (prepaid && !order.payments.some((p) => p.status === PaymentStatus.SUCCESS)) {
      await mergeShiprocketSync(deps.db, orderId, { status: "AWAITING_PAYMENT", error: null });
      return { status: "AWAITING_PAYMENT", reason: "Prepaid: submitted once the payment is verified" };
    }

    const attempts = (prior?.attempts ?? 0) + 1;
    const fail = async (status: "FAILED" | "NOT_CONFIGURED", reason: string): Promise<ShiprocketSyncOutcome> => {
      await mergeShiprocketSync(deps.db, orderId, { status, attempts, lastAttemptAt: now.toISOString(), error: reason.slice(0, 500), trigger });
      return { status, reason };
    };

    if (!isShiprocketEnabled(env)) return fail("NOT_CONFIGURED", "Shiprocket is not enabled for this CRM");
    // Weight and size come from the products on the order (a variant's own measurements before its product's); nothing is defaulted or guessed.
    const parcel = parcelFromItems(order.items.map((i) => ({ quantity: i.quantity, skuSnapshot: i.skuSnapshot, productNameSnapshot: i.productNameSnapshot, variantNameSnapshot: i.variantNameSnapshot, measures: i.variant ?? i.product ?? null })), order.parcelWeightKg);
    if (!parcel.ok) return fail("FAILED", describeMissing(parcel.missing));

    await mergeShiprocketSync(deps.db, orderId, { status: "PENDING", attempts, lastAttemptAt: now.toISOString(), error: null, trigger });
    try {
      await deps.service.createShipment(actor, orderId, parcel.input, { system: true });
      return { status: "SYNCED" };
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 409) {
        // "already has an active shipment" (a concurrent call won) or "previous attempt got no reply": nothing new was created. The first means it is submitted; the second needs a person to check Shiprocket.
        const now2 = await deps.db.order.findUnique({ where: { id: orderId }, select: { shipments: { where: { externalSource: "SHIPROCKET" }, select: { status: true } } } });
        if (now2?.shipments.some((s) => !DEAD.has(s.status))) return { status: "PENDING", reason: error.message };
        return fail("FAILED", error.message);
      }
      if (error instanceof ApiError && error.statusCode === 503) return fail("NOT_CONFIGURED", error.message);
      return fail("FAILED", error instanceof Error ? error.message : "Shiprocket submission failed");
    }
  } catch (error) {
    const reason = safeMessage(error instanceof Error ? error.message : String(error));
    logger.warn(`Shiprocket auto-sync errored for order ${orderId}: ${reason}`);
    return { status: "FAILED", reason };
  }
}

/**
 * The default entry for a payment that was just verified (Cashfree or a manually verified payment): submits the paid prepaid order, acting as the person who created it. Never throws.
 * A webhook has no logged-in user, so the actor is read from the order's own creator.
 */
export async function submitPaidOrderToShiprocket(orderId: string): Promise<ShiprocketSyncOutcome> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { createdBy: { select: { id: true, username: true, role: true } } } });
    if (!order?.createdBy) return { status: "NOT_APPLICABLE", reason: "The order has no creator" };
    return await syncOrderToShiprocket({ db: prisma as never, service: new ShiprocketShipmentsService() }, orderId, order.createdBy, "PAYMENT_VERIFIED");
  } catch (error) {
    return { status: "FAILED", reason: safeMessage(error instanceof Error ? error.message : String(error)) };
  }
}
