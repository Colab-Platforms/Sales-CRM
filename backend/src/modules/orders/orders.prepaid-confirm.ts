import { ActivitySource, ActivityType, OrderStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { asRecord, safeMessage, type Db } from "../integrations/integrations.common.js";
import { sumCents, toCents } from "../shopify/shopify.money.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import OrdersService from "./orders.service.js";

// The prepaid lifecycle, second half. A prepaid CRM order is created as a PAYMENT REQUEST (status PENDING_PAYMENT, one PENDING Payment holding the Cashfree link) and is NOT sent to Shopify - Shopify has no
// "prepaid pending" state. Only when Cashfree's verified result turns the payment SUCCESSFUL (webhook signature + amount/currency + link reference are checked in cashfree.apply.ts / the webhook processor, and
// duplicates are collapsed there) does this run, from the one place every Cashfree result passes (cashfree.reconcile.ts):
//   1. the order becomes CONFIRMED (guarded: only from PENDING_PAYMENT, so a repeat or a concurrent run changes nothing the second time);
//   2. the Shopify order is created through the shared mapping layer (idempotent: claim + lookup by the CRM reference - never a second order);
//   3. the existing Shopify payment sync marks it paid, because the CRM now really holds a successful payment.
// A Shopify failure never undoes the payment or the confirmed order: it is recorded on the order and the existing "Push to Shopify" retry finishes the job (and marks it paid). The customer is never charged again.

export interface PrepaidConfirmResult {
  confirmed: boolean;
  shopify: "created" | "already_linked" | "failed" | "not_applicable";
  reason?: string;
}

type Runner = Db;

export async function confirmPaidPrepaidOrder(db: Runner, orderId: string, deps: { getShopifyClient?: () => ShopifyClient; now?: Date } = {}): Promise<PrepaidConfirmResult> {
  const now = deps.now ?? new Date();
  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true, leadId: true, orderNumber: true, status: true, externalId: true, metadata: true, currency: true, totalAmount: true, payments: { select: { status: true, amount: true, currency: true, externalSource: true } } } });
  if (!order) return { confirmed: false, shopify: "not_applicable", reason: "Order not found" };
  const meta = asRecord(order.metadata);
  // Only prepaid orders created in the CRM take this path: a Shopify-synced order (already linked), a COD order, and a COD->prepaid upgrade (already in Shopify) are left exactly as they are.
  if (meta.paymentMode !== "PREPAID" || order.externalId) return { confirmed: false, shopify: "not_applicable" };
  const successful = order.payments.filter((p) => p.status === "SUCCESS");
  if (successful.length === 0) return { confirmed: false, shopify: "not_applicable", reason: "No verified payment" };
  // The money must be Cashfree's, in the order's currency, and add up to exactly what the order costs. The webhook and Refresh already refuse a wrong amount, but this runs from several entry points (including the
  // recovery of an already-paid order), so it is checked here against the stored records as well.
  const cashfree = successful.filter((p) => p.externalSource === "CASHFREE" && p.currency === order.currency);
  if (cashfree.length !== successful.length || sumCents(cashfree.map((p) => p.amount.toString())) !== toCents(order.totalAmount.toString())) {
    return { confirmed: false, shopify: "not_applicable", reason: "The successful payment does not match this order (source, currency or amount)" };
  }

  // placedAt is left as it was: the order was placed when it was created, not when its payment was verified (or later repaired).
  const moved = await db.order.updateMany({ where: { id: orderId, status: OrderStatus.PENDING_PAYMENT }, data: { status: OrderStatus.CONFIRMED } });
  if (moved.count > 0) {
    await db.activity.create({
      data: { leadId: order.leadId, orderId, type: ActivityType.ORDER_STATUS_CHANGED, source: ActivitySource.CASHFREE_WEBHOOK, referenceType: "Order", referenceId: orderId, title: `Prepaid payment verified - order ${order.orderNumber} confirmed`, metadata: { from: "PENDING_PAYMENT", to: "CONFIRMED" }, createdAt: now },
    });
  }

  try {
    const svc = new OrdersService(db as never, deps.getShopifyClient);
    const pushed = await svc.pushOrderToShopify(null, orderId);
    if (pushed.status === "failed") {
      await recordFailure(db, orderId, pushed.reason ?? "Shopify did not accept the order", now);
      return { confirmed: true, shopify: "failed", reason: pushed.reason };
    }
    return { confirmed: true, shopify: pushed.status === "created" ? "created" : "already_linked" };
  } catch (error) {
    const reason = safeMessage(error instanceof Error ? error.message : String(error));
    logger.warn(`Shopify order creation after verified payment errored for order ${orderId}: ${reason}`);
    await recordFailure(db, orderId, reason, now).catch(() => undefined);
    return { confirmed: true, shopify: "failed", reason };
  }
}

async function recordFailure(db: Runner, orderId: string, reason: string, now: Date): Promise<void> {
  const fresh = await db.order.findUnique({ where: { id: orderId }, select: { metadata: true } });
  const meta = asRecord(fresh?.metadata);
  await db.order.update({
    where: { id: orderId },
    data: { metadata: { ...meta, shopifySync: { status: "failed", missing: [], omitted: [], repaired: [], customer: "", attemptedAt: now.toISOString(), verifiedAt: null, retryAdvice: "RETRY", error: safeMessage(reason).slice(0, 240) } } as unknown as Prisma.InputJsonValue },
  });
}
