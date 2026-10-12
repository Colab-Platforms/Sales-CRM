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
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { computePaymentBreakdown } from "../orders/orders.filters.js";
import { ShopifyConfigError, loadShopifyConfig } from "../shopify/shopify.config.js";
import { markShopifyOrderPaid, ShopifyOrderMarkAsPaidError } from "../shopify/shopify.orders.write.js";
import { reconcilePrepaidUpgrade, ShopifyReconcileError } from "../shopify/shopify.orders.reconcile.js";
import { readOffer } from "../orders/orders.prepaid-upgrade.hooks.js";
import { notifyPaymentSuccess, type OrderNotifyDeps } from "../whatsapp/whatsapp.order-notify.service.js";
import type { MessageItem } from "../whatsapp/whatsapp.order-message.js";

const messageItems = (items: { productNameSnapshot: string; variantNameSnapshot: string | null; quantity: number }[]): MessageItem[] =>
  items.map((i) => ({ name: i.productNameSnapshot, variant: i.variantNameSnapshot, quantity: i.quantity }));

/** What the CRM charged and collected for a CRM-discounted order, in the shape the Shopify reconciliation wants - or why that cannot be mirrored safely (Shopify is then left untouched). */
export function crmDiscountFigures(order: { currency: string; subtotal: { toString(): string }; discountAmount: { toString(): string }; totalAmount: { toString(): string }; payments: { status: string; amount: { toString(): string }; refundedAmount: { toString(): string } | null }[] }):
  | { originalAmount: string; discountAmount: string; prepaidAmount: string; currency: string }
  | { problem: string } {
  const subtotal = toCents(order.subtotal.toString());
  const discount = toCents(order.discountAmount.toString());
  const total = toCents(order.totalAmount.toString());
  if (subtotal - discount !== total) return { problem: "The CRM total includes shipping, tax or other adjustments that Shopify was not sent, so the discount and payment were not mirrored to Shopify. Shopify was left unchanged." };
  const breakdown = computePaymentBreakdown(order.payments.map((p) => ({ status: p.status as never, amount: p.amount.toString(), refundedAmount: p.refundedAmount ? p.refundedAmount.toString() : null })));
  if (breakdown.paidCents !== total) return { problem: `The CRM collected ${fromCents(breakdown.paidCents)} but the order total is ${fromCents(total)}, so Shopify was left unchanged.` };
  return { originalAmount: fromCents(subtotal), discountAmount: fromCents(discount), prepaidAmount: fromCents(total), currency: order.currency };
}

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

  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, leadId: true, orderNumber: true, currency: true, subtotal: true, discountAmount: true, totalAmount: true, externalSource: true, externalId: true, metadata: true, payments: { select: { status: true, amount: true, refundedAmount: true } } } });
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

  // A converted Prepaid Upgrade is NOT "mark the whole order paid": Shopify would record the original COD total as received while
  // the customer paid less. It gets the dedicated reconciliation (order edit for the discount, then a payment for exactly the
  // amount collected), which is safe to repeat. Every other order keeps the original mark-as-paid behaviour untouched.
  const offer = readOffer(meta);
  const upgrade = offer && offer.status === "UPGRADED" ? offer : null;
  // A Prepaid Upgrade that is still in flight (link pending) or that took money it could not convert (PAYMENT_RECEIVED) must
  // never fall through to the whole-order mark-as-paid: that would record the full COD total as received for a smaller payment.
  if (offer && (offer.status === "PAYMENT_PENDING" || offer.status === "PAYMENT_RECEIVED")) {
    return { status: "failed", reason: "A prepaid upgrade is not completed for this order, so Shopify was left unchanged." };
  }

  // An order the CRM itself discounted (WhatsApp Inbox / manual order: Order.metadata.discount | customDiscount) reaches Shopify at LIST price. Marking it paid would record
  // the whole list price as received for a smaller collection, so it gets the same edit-then-pay reconciliation, for exactly what the CRM charged and collected.
  const crmDiscount = !offer && Boolean(meta.discount || meta.customDiscount) && toCents(order.discountAmount.toString()) > 0 ? crmDiscountFigures(order) : null;
  if (crmDiscount && "problem" in crmDiscount) {
    await tx.order.update({ where: { id: orderId }, data: { metadata: { ...meta, shopifyPaymentSync: { status: "failed", failedAt: now.toISOString(), reason: crmDiscount.problem } } as Prisma.InputJsonValue } });
    await tx.activity.create({ data: { ...base, type: ActivityType.PAYMENT_STATUS_CHANGED, title: `Shopify payment sync failed (order ${order.orderNumber})`, description: crmDiscount.problem, metadata: { provider: "SHOPIFY", event: "SHOPIFY_PAYMENT_SYNC_FAILED" } } });
    return { status: "failed", reason: crmDiscount.problem };
  }

  try {
    const result = upgrade
      ? await reconcilePrepaidUpgrade(client, order.externalId, { originalAmount: upgrade.originalAmount, discountAmount: upgrade.discountAmount, prepaidAmount: upgrade.prepaidAmount, currency: upgrade.currency, upgradeReference: order.orderNumber })
      : crmDiscount
        ? await reconcilePrepaidUpgrade(client, order.externalId, { ...crmDiscount, upgradeReference: order.orderNumber, labels: { discount: `CRM discount (${order.orderNumber})`, payment: `Cashfree (CRM ${order.orderNumber})`, note: `CRM order ${order.orderNumber}` } })
        : await markShopifyOrderPaid(client, order.externalId);
    const detail = crmDiscount ? { mode: "CRM_DISCOUNT", originalAmount: crmDiscount.originalAmount, discountAmount: crmDiscount.discountAmount, collectedAmount: crmDiscount.prepaidAmount, performed: (result as { performed?: string }).performed } : upgrade ? { mode: "PREPAID_UPGRADE", upgradeId: upgrade.id, originalAmount: upgrade.originalAmount, discountAmount: upgrade.discountAmount, collectedAmount: upgrade.prepaidAmount, performed: (result as { performed?: string }).performed } : {};
    await tx.order.update({ where: { id: orderId }, data: { metadata: { ...meta, shopifyPaymentSync: { status: "synced", syncedAt: now.toISOString(), financialStatus: result.financialStatus, ...detail } } as Prisma.InputJsonValue } });
    await tx.activity.create({ data: { ...base, type: ActivityType.PAYMENT_STATUS_CHANGED, title: `Shopify payment synced (order ${order.orderNumber})`, description: crmDiscount ? `Shopify order edited for the ${crmDiscount.discountAmount} CRM discount and ${crmDiscount.prepaidAmount} recorded as paid` : upgrade ? `Shopify order edited for the ${upgrade.discountAmount} prepaid discount and ${upgrade.prepaidAmount} recorded as paid` : "Shopify order marked as paid", metadata: { provider: "SHOPIFY", event: "SHOPIFY_PAYMENT_SYNCED", financialStatus: result.financialStatus, ...detail } } });
    return { status: "synced" };
  } catch (error) {
    const reason = error instanceof ShopifyOrderMarkAsPaidError || error instanceof ShopifyReconcileError ? safeMessage(error.message) : safeMessage(error instanceof Error ? error.message : String(error));
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
