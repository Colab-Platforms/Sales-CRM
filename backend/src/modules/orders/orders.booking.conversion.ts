import type { Prisma } from "../../../generated/prisma/client.js";
import {
  ActivitySource,
  ActivityType,
  InterestedPeriodStatus,
  LeadWorkingStatus,
  OrderStatus,
} from "../../../generated/prisma/enums.js";

// E5 conversion helpers. Database-only on purpose (no Shopify/WhatsApp imports), so the Cashfree
// payment code can call them inside its own transaction without import cycles.

/** US-5.8: CRM side of a successful conversion. Safe to call more than once. */
export async function markLeadConverted(
  tx: Prisma.TransactionClient,
  params: { leadId: string; orderId: string; orderNumber: string; actorId: string | null },
): Promise<void> {
  const now = new Date();
  await tx.lead.update({
    where: { id: params.leadId },
    data: { workingStatus: LeadWorkingStatus.CONVERTED, lastActivityAt: now },
  });
  await tx.interestedLeadPeriod.updateMany({
    where: { leadId: params.leadId, status: InterestedPeriodStatus.ACTIVE },
    data: { status: InterestedPeriodStatus.CONVERTED, endedAt: now },
  });
  await tx.activity.create({
    data: {
      leadId: params.leadId,
      orderId: params.orderId,
      actorId: params.actorId,
      type: ActivityType.ORDER_CONFIRMED,
      source: params.actorId ? ActivitySource.USER : ActivitySource.SYSTEM,
      referenceType: "Order",
      referenceId: params.orderId,
      title: `Order ${params.orderNumber} confirmed — lead converted`,
    },
  });
}

/**
 * A payment-link order was just paid: confirm it and convert the lead.
 * Only touches E5 on-call orders (they carry an idempotencyKey) that are still PENDING_PAYMENT,
 * so Shopify/website orders and already-confirmed orders are left alone. Returns true if it confirmed.
 */
export async function confirmBookingOrderAfterPayment(
  tx: Prisma.TransactionClient,
  orderId: string,
  actorId: string | null,
): Promise<boolean> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, leadId: true, orderNumber: true, status: true, idempotencyKey: true, externalSource: true },
  });
  if (!order || !order.idempotencyKey || order.externalSource !== null) return false;
  if (order.status !== OrderStatus.PENDING_PAYMENT) return false;

  await tx.order.update({
    where: { id: order.id },
    data: { status: OrderStatus.CONFIRMED, confirmedAt: new Date() },
  });
  await markLeadConverted(tx, {
    leadId: order.leadId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    actorId,
  });
  return true;
}