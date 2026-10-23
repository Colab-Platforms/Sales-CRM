// THE one place a Cashfree result becomes CRM state. The webhook processor, the Refresh action and the scheduled reconciliation of missed webhooks all end
// here, so the three can never disagree about what a payment means:
//
//   Cashfree status -> applyPaymentUpdate (CRM Payment + order's derived payment status, audit trail, Prepaid Upgrade hook)
//                   -> on a NEWLY successful payment only: Shopify reconciliation (once) + "payment received" WhatsApp (once)
//
// It never creates a payment, never starts a payment, never refunds. Status only moves forward (cashfree.apply.ts), so a repeated or late result is a no-op,
// and the Shopify step is guarded by Order.metadata.shopifyPaymentSync, so a duplicate trigger can not record a second Shopify payment.
import { ActivitySource, OrderStatus, PaymentStatus, type Role } from "../../../generated/prisma/enums.js";
import { logger } from "@/utils/logger.js";
import { safeMessage, type TxRunner } from "../integrations/integrations.common.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import type { OrderNotifyDeps } from "../whatsapp/whatsapp.order-notify.service.js";
import { applyPaymentUpdate, type ApplyResult, type PaymentUpdate } from "./cashfree.apply.js";
import { sendPaymentSuccessNotification, syncShopifyPayment } from "./cashfree.payment-success.js";
import { confirmPaidPrepaidOrder } from "../orders/orders.prepaid-confirm.js";
import { clearLiveOrderCaches } from "../orders/orders.live.service.js";

export interface PaymentReconcileDeps {
  runner: TxRunner;
  now?: () => Date;
  /** Injectable so tests never construct a real Shopify client. */
  getShopifyClient?: () => ShopifyClient;
  /** Test seam for the customer notification (fake senders). */
  notifyDeps?: OrderNotifyDeps;
  /**
   * After a payment becomes SUCCESS or FAILED: close what is still open for it at Cashfree (the UPI QR's order after the link was paid or the payment failed; the payment link after the QR was paid).
   * Best effort: a failure here is logged and recorded, never undoes the payment - a payment that still arrives is caught as a duplicate / late payment by applyPaymentUpdate.
   */
  closeOpenMethods?: (paymentId: string, to: "SUCCESS" | "FAILED", via: string | null) => Promise<void>;
}

export interface PaymentReconcileContext {
  source: ActivitySource;
  actor?: { id: string; role: Role } | null;
}

/** The Shopify reconciliation talks to Shopify several times inside its transaction, so it gets more room than Prisma's 5 second default. */
const FOLLOW_UP_TX = { timeout: 120_000, maxWait: 15_000 };

export async function reconcileCashfreePayment(deps: PaymentReconcileDeps, paymentId: string, update: PaymentUpdate, ctx: PaymentReconcileContext): Promise<ApplyResult> {
  const now = deps.now ?? (() => new Date());
  const applied = await deps.runner.$transaction((tx) => applyPaymentUpdate(tx, paymentId, update, { source: ctx.source, actor: ctx.actor ?? null, now: now() }));

  // Best-effort follow-ups to a newly successful payment. Neither can undo the payment above, and a failure is recorded on the order (Shopify) or logged,
  // never turned into a retry of the payment itself; the existing "Retry Shopify payment sync" action re-runs the (idempotent) Shopify step.
  if (applied.outcome === "updated" && deps.closeOpenMethods && (applied.to === PaymentStatus.SUCCESS || applied.to === PaymentStatus.FAILED)) {
    try {
      await deps.closeOpenMethods(paymentId, applied.to, typeof update.meta?.via === "string" ? update.meta.via : null);
    } catch (error) {
      logger.warn(`Closing the other payment method of payment ${paymentId} errored: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (applied.outcome === "updated" && applied.to === PaymentStatus.SUCCESS) {
    await confirmAndSyncPaidOrder(deps, applied.orderId, ctx, now);
    try {
      await deps.runner.$transaction((tx) => sendPaymentSuccessNotification(tx, applied.orderId, now(), deps.notifyDeps), FOLLOW_UP_TX);
    } catch (error) {
      logger.warn(`Payment-success WhatsApp notification errored for order ${applied.orderId}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
    }
  } else if (applied.outcome === "unchanged" && !applied.exception && (await isStuckPaidPrepaidOrder(deps.runner, applied.orderId))) {
    // RECOVERY. The payment is already SUCCESS but the prepaid order never left PENDING_PAYMENT: the confirmation step did not run or did not complete the first time (a webhook handled by an older build, a
    // crash or an error in between). Every Cashfree result passes through here - a repeated webhook, Refresh, the scheduled catch-up - so any of them finishes the job now. It is the same idempotent
    // confirmation (guarded status change, claimed Shopify create, paid only on a verified payment), so a concurrent or repeated run changes nothing the second time. No customer message is re-sent.
    logger.warn(`Recovering paid prepaid order ${applied.orderId}: payment is SUCCESS but the order was still awaiting payment`);
    await confirmAndSyncPaidOrder(deps, applied.orderId, ctx, now);
  }
  return applied;
}

/** Confirms the order, creates/links its Shopify order, marks it paid there, and refreshes the cached Orders list. Each step is best effort and idempotent; a failure is logged, never thrown. */
export async function confirmAndSyncPaidOrder(deps: PaymentReconcileDeps, orderId: string, ctx: PaymentReconcileContext, now: () => Date): Promise<void> {
  // A prepaid CRM order exists only as a payment request until now: confirm it and create its Shopify order (idempotent; a Shopify failure is recorded, never undoes the payment).
  try {
    await deps.runner.$transaction((tx) => confirmPaidPrepaidOrder(tx, orderId, { getShopifyClient: deps.getShopifyClient, now: now() }), FOLLOW_UP_TX);
  } catch (error) {
    logger.warn(`Prepaid order confirmation errored for order ${orderId}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
  }
  try {
    await deps.runner.$transaction((tx) => syncShopifyPayment(tx, orderId, { source: ctx.source, actor: ctx.actor ?? null, now: now(), getShopifyClient: deps.getShopifyClient }), FOLLOW_UP_TX);
  } catch (error) {
    logger.warn(`Shopify payment sync errored for order ${orderId}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
  }
  // The Orders page is a cached live Shopify list with the CRM status overlaid. The order was just confirmed, created in Shopify and marked paid (all committed above), so a page cached
  // before that would keep hiding it, or show it awaiting payment, for up to the cache TTL. Cleared only now, after the commits: clearing earlier lets a request re-cache the old overlay.
  clearLiveOrderCaches();
}

/** A CRM-created prepaid order (linked to Shopify or not) that still awaits payment although one of its Cashfree payments is SUCCESS - i.e. the confirmation step has not completed. Read-only. */
export async function isStuckPaidPrepaidOrder(runner: TxRunner, orderId: string): Promise<boolean> {
  const found = await runner.$transaction((tx) =>
    tx.order.findFirst({
      where: { id: orderId, status: OrderStatus.PENDING_PAYMENT, source: "SALESPERSON", metadata: { path: ["paymentMode"], equals: "PREPAID" }, payments: { some: { status: PaymentStatus.SUCCESS, externalSource: "CASHFREE" } } },
      select: { id: true },
    }),
  );
  return found !== null;
}
