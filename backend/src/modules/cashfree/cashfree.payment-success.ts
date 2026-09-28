// What happens the moment a Cashfree payment actually settles (SUCCESS), beyond just writing the Payment row (that part
// is cashfree.apply.ts's job, already done before this runs). Two independent, best-effort follow-ups:
//   1. Reconcile the linked Shopify order's financial status (never creates a second Shopify order, never picks an
//      amount - see markShopifyOrderPaid).
//   2. Notify the customer "payment received" over WhatsApp, exactly once.
// Both are idempotent and safe to re-run (a retried/duplicate webhook, or a manual retry action, can never double-sync
// Shopify or double-send the notification), and neither failing ever undoes the payment itself.
import { ActivitySource, ActivityType, type Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { advisoryLock, asRecord, safeMessage, type Db } from "../integrations/integrations.common.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { ShopifyConfigError, loadShopifyConfig } from "../shopify/shopify.config.js";
import { markShopifyOrderPaid, ShopifyOrderMarkAsPaidError } from "../shopify/shopify.orders.write.js";
import { notifyPaymentSuccess, type OrderNotifyDeps } from "../whatsapp/whatsapp.order-notify.service.js";
import type { MessageItem } from "../whatsapp/whatsapp.order-message.js";

const messageItems = (items: { productNameSnapshot: string; variantNameSnapshot: string | null; quantity: number }[]): MessageItem[] =>
  items.map((i) => ({ name: i.productNameSnapshot, variant: i.variantNameSnapshot, quantity: i.quantity }));

export const shopifyPaymentSyncLockKey = (orderId: string) => `shopify:payment-sync:${orderId}`;

export type ShopifyPaymentSyncStatus = "synced" | "not_linked" | "failed";
export interface ShopifyPaymentSyncResult {
  status: ShopifyPaymentSyncStatus;
  reason?: string;
}

interface SyncCtx {
  actor?: { id: string; role: Role } | null;
  source: ActivitySource;
  now?: Date;
  getShopifyClient?: () => ShopifyClient;
}

/** Marks the order's already-linked Shopify order as paid. A no-op (reported "synced") if there is no linked Shopify
 *  order, or if a previous call already synced it - so a retried Cashfree webhook, or the manual "Retry Shopify
 *  payment sync" action, can never run this twice. */
export async function syncShopifyPayment(tx: Db, orderId: string, ctx: SyncCtx): Promise<ShopifyPaymentSyncResult> {
  const now = ctx.now ?? new Date();
  await advisoryLock(tx, shopifyPaymentSyncLockKey(orderId));

  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, leadId: true, orderNumber: true, externalSource: true, externalId: true, metadata: true } });
  if (!order) return { status: "not_linked", reason: "Order not found" };
  if (order.externalSource !== "SHOPIFY" || !order.externalId) return { status: "not_linked", reason: "This order is not linked to a Shopify order." };

  const meta = asRecord(order.metadata);
  const existing = asRecord(meta.shopifyPaymentSync);
  if (existing.status === "synced") return { status: "synced" };

  const base = { leadId: order.leadId, orderId, actorId: ctx.actor?.id ?? null, actorRole: ctx.actor?.role ?? null, source: ctx.source, referenceType: "Order", referenceId: orderId, createdAt: now };

  let client: ShopifyClient;
  try {
    client = (ctx.getShopifyClient ?? (() => new ShopifyClient(loadShopifyConfig())))();
  } catch (error) {
    const reason = error instanceof ShopifyConfigError ? error.message : safeMessage(error instanceof Error ? error.message : String(error));
    await tx.order.update({ where: { id: orderId }, data: { metadata: { ...meta, shopifyPaymentSync: { status: "failed", failedAt: now.toISOString(), reason } } as Prisma.InputJsonValue } });
    return { status: "failed", reason };
  }

  try {
    const result = await markShopifyOrderPaid(client, order.externalId);
    await tx.order.update({ where: { id: orderId }, data: { metadata: { ...meta, shopifyPaymentSync: { status: "synced", syncedAt: now.toISOString(), financialStatus: result.financialStatus } } as Prisma.InputJsonValue } });
    await tx.activity.create({ data: { ...base, type: ActivityType.PAYMENT_STATUS_CHANGED, title: `Shopify payment synced (order ${order.orderNumber})`, description: "Shopify order marked as paid", metadata: { provider: "SHOPIFY", event: "SHOPIFY_PAYMENT_SYNCED", financialStatus: result.financialStatus } } });
    return { status: "synced" };
  } catch (error) {
    const reason = error instanceof ShopifyOrderMarkAsPaidError ? safeMessage(error.message) : safeMessage(error instanceof Error ? error.message : String(error));
    await tx.order.update({ where: { id: orderId }, data: { metadata: { ...meta, shopifyPaymentSync: { status: "failed", failedAt: now.toISOString(), reason } } as Prisma.InputJsonValue } });
    await tx.activity.create({ data: { ...base, type: ActivityType.PAYMENT_STATUS_CHANGED, title: `Shopify payment sync failed (order ${order.orderNumber})`, description: reason, metadata: { provider: "SHOPIFY", event: "SHOPIFY_PAYMENT_SYNC_FAILED" } } });
    logger.warn(`Shopify payment sync failed for order ${orderId}: ${reason}`);
    return { status: "failed", reason };
  }
}

/** Sends "payment received" exactly once per order (a `paymentSuccessNotifiedAt` stamp on Order.metadata guards a
 *  retried webhook from sending it twice), independent of whether the Shopify sync above succeeded. */
export async function sendPaymentSuccessNotification(tx: Db, orderId: string, now: Date = new Date(), deps: OrderNotifyDeps = {}): Promise<void> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      leadId: true,
      orderNumber: true,
      currency: true,
      totalAmount: true,
      metadata: true,
      lead: { select: { firstName: true, lastName: true } },
      items: { select: { productNameSnapshot: true, variantNameSnapshot: true, quantity: true } },
    },
  });
  if (!order) return;
  const meta = asRecord(order.metadata);
  if (meta.paymentSuccessNotifiedAt) return; // already sent for this order - never re-sent on a retried/duplicate webhook

  const result = await notifyPaymentSuccess(tx, {
    leadId: order.leadId,
    orderId,
    orderNumber: order.orderNumber,
    amount: order.totalAmount.toString(),
    currency: order.currency,
    customerName: [order.lead.firstName, order.lead.lastName].filter(Boolean).join(" ") || undefined,
    items: messageItems(order.items),
  }, deps);

  await tx.order.update({ where: { id: orderId }, data: { metadata: { ...meta, paymentSuccessNotifiedAt: now.toISOString(), paymentSuccessNotification: { sent: result.sent, via: result.via, provider: result.provider, ...(result.reason ? { reason: result.reason } : {}) } } as Prisma.InputJsonValue } });
}
