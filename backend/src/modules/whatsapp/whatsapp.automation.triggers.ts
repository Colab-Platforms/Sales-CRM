// E7.6: pure helpers for deciding *which* automation an order status transition maps to, and for
// building each automation's durable idempotency key, plus the one integration point that turns a
// Shopify order sync's result into an automation dispatch. Kept in this module (not shopify.sync.ts)
// so the trigger lives with the rest of the WhatsApp automation code, with a single, deliberate,
// one-directional import from the shopify module into this one - never the reverse.
import { logger } from "@/utils/logger.js";
import type { OrderStatus, WhatsAppAutomationType } from "../../../generated/prisma/enums.js";
import type { OrderResult } from "../shopify/shopify.persist.js";
import LifecycleAutomationService from "./whatsapp.automation.service.js";

// Order-level automations map 1:1 onto the OrderStatus the order actually transitions *into* -
// mapOrder (shopify.mapper.ts) already derives CONFIRMED/SHIPPED/OUT_FOR_DELIVERY/DELIVERED from
// the order's real payment/fulfilment state, so this is the single source of truth for "did this
// business event really happen", not a second definition of it.
const ORDER_STATUS_AUTOMATION: Partial<Record<OrderStatus, WhatsAppAutomationType>> = {
  CONFIRMED: "ORDER_CONFIRMED",
  SHIPPED: "ORDER_SHIPPED",
  OUT_FOR_DELIVERY: "ORDER_OUT_FOR_DELIVERY",
  DELIVERED: "ORDER_DELIVERED",
};

/** Which automation (if any) an order becoming this status should fire. */
export function orderStatusAutomationType(status: OrderStatus): WhatsAppAutomationType | null {
  return ORDER_STATUS_AUTOMATION[status] ?? null;
}

/** At most once ever per order per automation type - re-syncing an already-confirmed/shipped/... order never re-fires it. */
export function orderAutomationEventKey(type: WhatsAppAutomationType, orderId: string): string {
  return `${type}:${orderId}`;
}

/** At most one payment reminder per order per calendar day (UTC), regardless of how often the sweep runs that day. */
export function paymentPendingEventKey(orderId: string, day: Date): string {
  return `PAYMENT_PENDING:${orderId}:${day.toISOString().slice(0, 10)}`;
}

/** At most once ever per follow-up task, however many times the sweep re-scans it before it's completed/cancelled. */
export function followUpDueEventKey(taskId: string): string {
  return `FOLLOW_UP_DUE:${taskId}`;
}

/**
 * Called once, strictly after a Shopify order sync's own transaction has committed (see
 * shopify.sync.ts's syncOrderById) - so an automation outcome can never roll back the order/
 * shipment/payment write it reacts to. A no-op for a skipped sync (nothing changed) or a status
 * that isn't one of the four order-level automations; dispatch() itself is already fully
 * exception-safe, and this adds one more defensive layer so a genuinely unexpected error here can
 * never surface as a failed Shopify sync.
 */
export async function dispatchOrderLifecycleAutomation(result: OrderResult, automation: LifecycleAutomationService = new LifecycleAutomationService()): Promise<void> {
  if (result.action === "skipped" || !result.orderId || !result.lead || !result.status) return;
  if (result.previousStatus === result.status) return;
  const type = orderStatusAutomationType(result.status);
  if (!type) return;

  try {
    await automation.dispatch({ type, leadId: result.lead.leadId, orderId: result.orderId, eventKey: orderAutomationEventKey(type, result.orderId) });
  } catch (error) {
    logger.error("WhatsApp lifecycle automation dispatch failed", error);
  }
}
