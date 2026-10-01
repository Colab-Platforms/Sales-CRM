import { ActivitySource, ActivityType, AbandonmentStatus, AbandonmentType } from "../../../generated/prisma/enums.js";
import LeadService from "../lead/lead.service.js";
import { normalizeEmail, normalizeMobile } from "@/utils/normalize.js";
import { safeMessage, type TxRunner } from "../integrations/integrations.common.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import { parseAbandonmentEvent, summarize, type ParsedAbandonment } from "./shiprocket.abandonment.mapper.js";

// Turns a stored "Abandon Cart" delivery into a Lead + Abandonment row. Mirrors
// shiprocket.webhook.processor.ts's claim/parse/apply/complete shape.
//
// Lead matching is deliberately NOT scoped to the Shiprocket Checkout Source the way
// LeadService.createLeadFromSource normally dedupes (source-scoped, same as WhatsApp/Meta): an
// abandoned checkout very often belongs to someone who already exists as a lead via the Shopify
// customer webhook, and the whole point of an abandonment record is to attach to that real person,
// not spawn a second lead under a different source. So this processor looks the person up by
// normalized mobile/email across every source first, and only falls back to
// createLeadFromSource (with a dedicated "Shiprocket Checkout" Source) for someone genuinely new.

export type AbandonmentProcessOutcome = "processed" | "ignored" | "retry" | "failed" | "skipped";

export interface AbandonmentProcessorDeps {
  store: WebhookStore;
  runner: TxRunner;
  now?: () => Date;
}

export const SHIPROCKET_CHECKOUT_SOURCE_NAME = "Shiprocket Checkout";
export const SHIPROCKET_CHECKOUT_SOURCE_CODE = "SHIPROCKET_CHECKOUT";

const leadService = new LeadService();

/** Cart value as a 0-999.99 priority score (Decimal(5,2) on the column) - a direct proxy for how much a
 *  recovery is worth, capped rather than normalized, since a bigger cart is unambiguously higher priority. */
function priorityFromCartValue(cartValue: string | null): { score: number | null; reason: string | null } {
  if (!cartValue) return { score: null, reason: null };
  const value = Number(cartValue);
  if (!Number.isFinite(value) || value <= 0) return { score: null, reason: null };
  return { score: Math.min(value, 999.99), reason: `Cart value ₹${value.toFixed(2)}` };
}

/** Structured cart detail stored on Abandonment.cartSnapshot, so the UI can render real list items,
 *  a formatted price and a clickable resume link instead of one flattened text blob. */
function buildCartSnapshot(event: ParsedAbandonment) {
  return {
    cartValue: event.cartValue,
    currency: event.currency,
    itemCount: event.itemCount,
    itemNames: event.itemNames,
    stage: event.stage,
    checkoutUrl: event.checkoutUrl,
  };
}

async function ensureCheckoutSource(tx: import("../integrations/integrations.common.js").Db): Promise<string> {
  const existing = await tx.source.findFirst({ where: { code: SHIPROCKET_CHECKOUT_SOURCE_CODE }, select: { id: true } });
  if (existing) return existing.id;
  const created = await tx.source.create({
    data: { name: SHIPROCKET_CHECKOUT_SOURCE_NAME, code: SHIPROCKET_CHECKOUT_SOURCE_CODE, type: "SHIPROCKET", status: "ACTIVE" },
    select: { id: true },
  });
  return created.id;
}

async function resolveLead(tx: import("../integrations/integrations.common.js").Db, event: ParsedAbandonment): Promise<{ id: string }> {
  const normalizedMobile = normalizeMobile(event.phone);
  const normalizedEmail = normalizeEmail(event.email);

  if (normalizedMobile || normalizedEmail) {
    const existing = await tx.lead.findFirst({
      where: { OR: [...(normalizedMobile ? [{ normalizedMobile }] : []), ...(normalizedEmail ? [{ normalizedEmail }] : [])] },
      select: { id: true },
    });
    if (existing) return existing;
  }

  const sourceId = await ensureCheckoutSource(tx);
  const lead = await leadService.createLeadFromSource(
    sourceId,
    {
      firstName: event.firstName,
      lastName: event.lastName ?? undefined,
      mobile: event.phone ?? undefined,
      email: event.email ?? undefined,
      location: event.location ?? undefined,
    },
    "Lead created from an abandoned Shiprocket Checkout cart",
    tx,
  );
  return { id: lead.id };
}

export async function processAbandonmentEvent(eventId: string, deps: AbandonmentProcessorDeps): Promise<AbandonmentProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const stored = await deps.store.claim(eventId, now());
  if (!stored) return "skipped";

  try {
    const event = parseAbandonmentEvent(stored.payload);
    if (!event) {
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }

    await deps.runner.$transaction(async (tx) => {
      const lead = await resolveLead(tx, event);
      const { score, reason } = priorityFromCartValue(event.cartValue);
      const detectedAt = event.abandonedAt ?? now();

      // One open (ACTIVE/IN_PROGRESS) CHECKOUT abandonment per cart: a repeat delivery for the same
      // cart (Shiprocket Checkout may resend as the customer keeps stalling) refreshes it in place
      // instead of flooding the queue with duplicates for a lead who has not been called yet.
      const existing = event.externalId
        ? await tx.abandonment.findFirst({
            where: { leadId: lead.id, type: AbandonmentType.CHECKOUT, referenceId: event.externalId, status: { in: [AbandonmentStatus.ACTIVE, AbandonmentStatus.IN_PROGRESS] } },
            select: { id: true },
          })
        : null;

      const cartSnapshot = buildCartSnapshot(event);

      const abandonment = existing
        ? await tx.abandonment.update({
            where: { id: existing.id },
            data: { detectedAt, priorityScore: score, priorityReason: reason, cartSnapshot },
          })
        : await tx.abandonment.create({
            data: {
              leadId: lead.id,
              type: AbandonmentType.CHECKOUT,
              sourceId: await ensureCheckoutSource(tx),
              referenceType: "ShiprocketCheckoutCart",
              referenceId: event.externalId,
              detectedAt,
              status: AbandonmentStatus.ACTIVE,
              priorityScore: score,
              priorityReason: reason,
              cartSnapshot,
            },
          });

      await tx.activity.create({
        data: {
          leadId: lead.id,
          type: ActivityType.ABANDONMENT,
          referenceType: "Abandonment",
          referenceId: abandonment.id,
          source: ActivitySource.SHIPROCKET_WEBHOOK,
          title: existing ? "Checkout abandonment updated" : "Checkout abandoned",
          description: summarize(event),
        },
      });

      await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: detectedAt } });

      // Only a genuinely new abandonment tries auto-assignment - a repeat delivery for the same cart
      // (the `existing` branch above) never re-triggers it, matching manual assignment's own "don't
      // clobber an existing owner" behavior. Each stage's toggle decides whether anything happens.
      if (!existing) {
        const fullLead = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
        await leadService.autoAssignAbandonedLead(tx, fullLead);
      }
    });

    await deps.store.complete(eventId, "PROCESSED", now());
    return "processed";
  } catch (error) {
    const exhausted = stored.attempts >= MAX_ATTEMPTS;
    await deps.store.fail(eventId, safeMessage(error instanceof Error ? error.message : String(error)), exhausted ? null : new Date(now().getTime() + backoffMs(stored.attempts)));
    return exhausted ? "failed" : "retry";
  }
}
