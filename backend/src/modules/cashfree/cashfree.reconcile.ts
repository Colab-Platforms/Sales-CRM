// THE one place a Cashfree result becomes CRM state. The webhook processor, the Refresh action and the scheduled reconciliation of missed webhooks all end
// here, so the three can never disagree about what a payment means:
//
//   Cashfree status -> applyPaymentUpdate (CRM Payment + order's derived payment status, audit trail, Prepaid Upgrade hook)
//                   -> on a NEWLY successful payment only: Shopify reconciliation (once) + "payment received" WhatsApp (once)
//
// It never creates a payment, never starts a payment, never refunds. Status only moves forward (cashfree.apply.ts), so a repeated or late result is a no-op,
// and the Shopify step is guarded by Order.metadata.shopifyPaymentSync, so a duplicate trigger can not record a second Shopify payment.
import { ActivitySource, PaymentStatus, type Role } from "../../../generated/prisma/enums.js";
import { logger } from "@/utils/logger.js";
import { safeMessage, type TxRunner } from "../integrations/integrations.common.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import type { OrderNotifyDeps } from "../whatsapp/whatsapp.order-notify.service.js";
import { applyPaymentUpdate, type ApplyResult, type PaymentUpdate } from "./cashfree.apply.js";
import { sendPaymentSuccessNotification, syncShopifyPayment } from "./cashfree.payment-success.js";

export interface PaymentReconcileDeps {
  runner: TxRunner;
  now?: () => Date;
  /** Injectable so tests never construct a real Shopify client. */
  getShopifyClient?: () => ShopifyClient;
  /** Test seam for the customer notification (fake senders). */
  notifyDeps?: OrderNotifyDeps;
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
  if (applied.outcome === "updated" && applied.to === PaymentStatus.SUCCESS) {
    try {
      await deps.runner.$transaction((tx) => syncShopifyPayment(tx, applied.orderId, { source: ctx.source, actor: ctx.actor ?? null, now: now(), getShopifyClient: deps.getShopifyClient }), FOLLOW_UP_TX);
    } catch (error) {
      logger.warn(`Shopify payment sync errored for order ${applied.orderId}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
    }
    try {
      await deps.runner.$transaction((tx) => sendPaymentSuccessNotification(tx, applied.orderId, now(), deps.notifyDeps), FOLLOW_UP_TX);
    } catch (error) {
      logger.warn(`Payment-success WhatsApp notification errored for order ${applied.orderId}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return applied;
}
