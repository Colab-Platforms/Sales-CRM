import { ActivitySource, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { UUID_PATTERN, safeMessage, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import { applyPaymentUpdate, linkToUpdate, type PaymentUpdate } from "./cashfree.apply.js";
import { parseEvent, type CashfreeEvent } from "./cashfree.events.js";
import { sendPaymentSuccessNotification, syncShopifyPayment } from "./cashfree.payment-success.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";

// Turns a stored Cashfree delivery into an update of the CRM payment it belongs to. It only ever updates a payment the
// CRM itself created (externalSource CASHFREE); a delivery that matches none is ignored, never turned into a new payment.

export type ProcessOutcome = "processed" | "ignored" | "retry" | "failed" | "skipped";

export interface CashfreeProcessorDeps {
  store: WebhookStore;
  runner: TxRunner;
  now?: () => Date;
  /** Injectable so tests never construct a real Shopify client - same pattern as OrdersService's getShopifyClient. */
  getShopifyClient?: () => ShopifyClient;
}

/** What a delivery means for the payment, or null when it changes nothing (a failed attempt on a link that is still payable, a dropped checkout). */
export function eventToUpdate(event: CashfreeEvent, now: Date): PaymentUpdate | null {
  if (event.kind === "link") {
    const update = linkToUpdate({ linkStatus: event.rawStatus, linkAmountPaid: event.amountPaid });
    return {
      ...update,
      method: event.payment?.method ?? null,
      cfPaymentId: event.payment?.cfPaymentId ?? null,
      bankReference: event.payment?.bankReference ?? null,
      paidAt: event.payment?.paidAt ?? null,
      meta: { ...update.meta, ...(event.orderId ? { cashfreeOrderId: event.orderId } : {}) },
    };
  }
  switch (event.outcome) {
    case "SUCCESS":
      return {
        status: "SUCCESS",
        paidAmount: event.payment.amount,
        method: event.payment.method,
        cfPaymentId: event.payment.cfPaymentId,
        bankReference: event.payment.bankReference,
        paidAt: event.payment.paidAt,
        meta: { cashfreeOrderId: event.orderId, cfPaymentId: event.payment.cfPaymentId },
      };
    // A failed attempt does not close the link - the customer can try again - so the payment stays open and the
    // failure is only noted on it.
    case "FAILED":
      return { status: null, meta: { lastFailedAttempt: { at: now.toISOString(), cfPaymentId: event.payment.cfPaymentId, message: safeMessage(event.payment.message, "Payment attempt failed") } } };
    default:
      return null;
  }
}

async function findPaymentId(tx: Db, event: CashfreeEvent): Promise<string | null> {
  const ids = event.kind === "link" ? [event.linkId, event.orderId] : [event.orderId, event.linkId];
  const keys = ids.filter((id): id is string => !!id);
  const or: Prisma.PaymentWhereInput[] = [];
  if (keys.length > 0) or.push({ externalId: { in: keys } }, { providerOrderId: { in: keys } });
  if (event.crmPaymentId && UUID_PATTERN.test(event.crmPaymentId)) or.push({ id: event.crmPaymentId });
  if (or.length === 0) return null;
  const found = await tx.payment.findFirst({ where: { externalSource: "CASHFREE", OR: or }, select: { id: true } });
  return found?.id ?? null;
}

export async function processCashfreeEvent(eventId: string, deps: CashfreeProcessorDeps): Promise<ProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const stored = await deps.store.claim(eventId, now());
  if (!stored) return "skipped";

  try {
    const event = parseEvent(stored.payload);
    const update = event ? eventToUpdate(event, now()) : null;
    if (!event || !update) {
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }

    const applied = await deps.runner.$transaction(async (tx) => {
      const paymentId = await findPaymentId(tx, event);
      if (!paymentId) return null;
      const result = await applyPaymentUpdate(tx, paymentId, update, { source: ActivitySource.CASHFREE_WEBHOOK, now: now() });
      return result;
    });

    if (!applied || applied.outcome === "not_found") {
      logger.info(`Cashfree webhook ${stored.eventType} matched no CRM payment; ignored`);
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }

    // Best-effort follow-ups to a newly-SUCCESSFUL payment (Shopify reconciliation + "payment received" WhatsApp
    // notice). Neither can undo the payment above regardless of outcome - each runs in its own transaction, and a
    // failure here is only logged, never turned into a webhook retry (the payment itself was already applied).
    if (applied.outcome === "updated" && applied.to === PaymentStatus.SUCCESS) {
      try {
        await deps.runner.$transaction((tx) => syncShopifyPayment(tx, applied.orderId, { source: ActivitySource.CASHFREE_WEBHOOK, now: now(), getShopifyClient: deps.getShopifyClient }));
      } catch (error) {
        logger.warn(`Shopify payment sync errored for order ${applied.orderId}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
      }
      try {
        await deps.runner.$transaction((tx) => sendPaymentSuccessNotification(tx, applied.orderId, now()));
      } catch (error) {
        logger.warn(`Payment-success WhatsApp notification errored for order ${applied.orderId}: ${safeMessage(error instanceof Error ? error.message : String(error))}`);
      }
    }

    await deps.store.complete(eventId, "PROCESSED", now());
    return "processed";
  } catch (error) {
    const exhausted = stored.attempts >= MAX_ATTEMPTS;
    await deps.store.fail(eventId, safeMessage(error instanceof Error ? error.message : String(error)), exhausted ? null : new Date(now().getTime() + backoffMs(stored.attempts)));
    return exhausted ? "failed" : "retry";
  }
}
