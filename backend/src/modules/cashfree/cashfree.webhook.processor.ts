import { ActivitySource } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { logger } from "@/utils/logger.js";
import { toCents } from "../shopify/shopify.money.js";
import { UUID_PATTERN, safeMessage, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import { linkToUpdate, type PaymentUpdate } from "./cashfree.apply.js";
import { parseEvent, type CashfreeEvent } from "./cashfree.events.js";
import { reconcileCashfreePayment } from "./cashfree.reconcile.js";
import type { CashfreeLink } from "./cashfree.client.js";
import type { OrderNotifyDeps } from "../whatsapp/whatsapp.order-notify.service.js";
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
  notifyDeps?: OrderNotifyDeps;
  /**
   * Read-only lookup of a payment link at Cashfree. When given, a SUCCESS delivery is only applied once Cashfree itself confirms the link is PAID for the
   * amount the CRM expects - the webhook body is never trusted on its own. Left out (tests), the signed delivery is applied as before.
   */
  verifyLink?: (linkId: string) => Promise<CashfreeLink>;
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

async function findPayment(tx: Db, event: CashfreeEvent): Promise<{ id: string; externalId: string | null; amount: string } | null> {
  const ids = event.kind === "link" ? [event.linkId, event.orderId] : [event.orderId, event.linkId];
  const keys = ids.filter((id): id is string => !!id);
  const or: Prisma.PaymentWhereInput[] = [];
  if (keys.length > 0) or.push({ externalId: { in: keys } }, { providerOrderId: { in: keys } });
  if (event.crmPaymentId && UUID_PATTERN.test(event.crmPaymentId)) or.push({ id: event.crmPaymentId });
  if (or.length === 0) return null;
  const found = await tx.payment.findFirst({ where: { externalSource: "CASHFREE", OR: or }, select: { id: true, externalId: true, amount: true } });
  return found ? { id: found.id, externalId: found.externalId, amount: found.amount.toString() } : null;
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

    const payment = await deps.runner.$transaction((tx) => findPayment(tx, event));
    if (!payment) {
      logger.info(`Cashfree webhook ${stored.eventType} matched no CRM payment; ignored`);
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }

    // Do not trust the delivery alone for money: ask Cashfree. A failed lookup throws, so the delivery is retried with backoff rather than guessed at.
    if (update.status === "SUCCESS" && deps.verifyLink && payment.externalId) {
      const link = await deps.verifyLink(payment.externalId);
      if (link.linkStatus !== "PAID" || toCents(link.linkAmountPaid) !== toCents(payment.amount)) {
        logger.warn(`Cashfree webhook claimed payment for ${payment.externalId}, but Cashfree reports ${link.linkStatus} (${link.linkAmountPaid ?? "no amount"} of ${payment.amount}); not applied`);
        await deps.store.complete(eventId, "IGNORED", now());
        return "ignored";
      }
    }

    // The same reconciliation Refresh and the scheduled catch-up use (apply -> Shopify -> notification), so all three produce the same result.
    const applied = await reconcileCashfreePayment({ runner: deps.runner, now, getShopifyClient: deps.getShopifyClient, notifyDeps: deps.notifyDeps }, payment.id, update, { source: ActivitySource.CASHFREE_WEBHOOK });
    if (applied.outcome === "not_found") {
      logger.info(`Cashfree webhook ${stored.eventType} matched no CRM payment; ignored`);
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }

    await deps.store.complete(eventId, "PROCESSED", now());
    return "processed";
  } catch (error) {
    const exhausted = stored.attempts >= MAX_ATTEMPTS;
    await deps.store.fail(eventId, safeMessage(error instanceof Error ? error.message : String(error)), exhausted ? null : new Date(now().getTime() + backoffMs(stored.attempts)));
    return exhausted ? "failed" : "retry";
  }
}
