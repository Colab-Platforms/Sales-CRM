import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { OrderStatus } from "../../../generated/prisma/enums.js";
import LifecycleAutomationService from "../whatsapp/whatsapp.automation.service.js";
import { orderAutomationEventKey } from "../whatsapp/whatsapp.automation.triggers.js";

/**
 * US-5.8: send the WhatsApp "order confirmed" automation for an E5 order, at most once (eventKey).
 * Never throws: a WhatsApp problem must never turn a successful order into a failed one.
 */
export async function notifyBookingOrderConfirmed(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, leadId: true, status: true, idempotencyKey: true },
    });
    if (!order || !order.idempotencyKey || order.status !== OrderStatus.CONFIRMED) return;

    await new LifecycleAutomationService().dispatch({
      type: "ORDER_CONFIRMED",
      leadId: order.leadId,
      orderId: order.id,
      eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id),
    });
  } catch (error) {
    logger.error(`[e5] WhatsApp order confirmation failed for order ${orderId}`, error);
  }
}