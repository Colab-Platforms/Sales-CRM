import { ActivitySource, ActivityType, AbandonmentStatus, AbandonmentType } from "../../../generated/prisma/enums.js";
import LeadService from "../lead/lead.service.js";
import { normalizeEmail, normalizeMobile } from "../../lib/leadIdentity.js";
import { safeMessage, type Db, type TxRunner } from "../integrations/integrations.common.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";
import { logger } from "@/utils/logger.js";
import { ingestionMetrics } from "./shiprocket.abandonment.metrics.js";
import type { Prisma } from "../../../generated/prisma/client.js";
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
  /** false = a recovery / reconciliation pass: the abandonment is saved but NEVER auto-assigned. Default true (live deliveries). */
  autoAssign?: boolean;
}

// Why these numbers exist (measured on live data, 2026-10-13): saving one delivery takes ~4.4 s of database round trips. Prisma's interactive-transaction default is 5 s, so the
// work sat on the edge of its limit all day and, once the database got slightly slower (~10:18 IST), most deliveries timed out and - after the shared 8 attempts - were dropped.
//  - the SAVE (lead, abandonment, activity) now has an explicit, generous timeout and is committed on its own;
//  - auto-assignment (round-robin cursor locks, assignment history) is a SECOND, separate transaction: a slow or failed assignment can no longer fail or roll back the save;
//  - a failed delivery is retried for ~11 hours (24 attempts, backoff capped at 30 min) instead of ~2 hours, and can be re-driven by a bounded recovery pass.
export const SAVE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;
export const ASSIGN_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;
export const ABANDONMENT_MAX_ATTEMPTS = 24;
export const abandonmentBackoffMs = (attempts: number): number => Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60_000);

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
export function buildCartSnapshot(event: ParsedAbandonment, previous?: unknown): Record<string, unknown> {
  const before = (previous && typeof previous === "object" ? previous : {}) as Record<string, unknown>;
  const hasLines = event.lines.length > 0;
  // Deliveries can arrive out of order (a retry of an older one after a newer one). An OLDER delivery never overwrites what a newer one saved; it only
  // supplies what the saved snapshot does not have yet.
  const savedAt = typeof before.capturedAt === "string" ? new Date(before.capturedAt) : null;
  const olderThanSaved = Boolean(event.abandonedAt && savedAt && !Number.isNaN(savedAt.getTime()) && event.abandonedAt.getTime() < savedAt.getTime());
  if (olderThanSaved) {
    const have = (k: string) => (Array.isArray(before[k]) ? (before[k] as unknown[]).length > 0 : before[k] !== undefined && before[k] !== null);
    return {
      ...before,
      ...(have("lines") ? {} : { lines: event.lines }),
      ...(have("shippingAddress") ? {} : { shippingAddress: event.shippingAddress }),
      ...(have("billingAddress") ? {} : { billingAddress: event.billingAddress }),
    };
  }
  return {
    // Prefill data for the Create Order form (read by the order-prefill endpoint only; the list/detail APIs whitelist their own fields).
    // A repeat delivery for the same cart refreshes what it carries and KEEPS what it does not: a customer who typed an address
    // and then stalled before the next webhook must not lose it just because that delivery had none.
    lines: hasLines ? event.lines : before.lines ?? [],
    totals: event.totals.total || event.totals.shipping || event.totals.discount ? event.totals : before.totals ?? event.totals,
    shippingAddress: event.shippingAddress ?? before.shippingAddress ?? null,
    billingAddress: event.billingAddress ?? before.billingAddress ?? null,
    customer: { firstName: event.firstName, lastName: event.lastName, phone: event.phone, email: event.email },
    capturedAt: (event.abandonedAt ?? new Date()).toISOString(),
    sourceName: event.sourceName ?? (before.sourceName as string | null | undefined) ?? null,
    cartValue: event.cartValue,
    currency: event.currency,
    itemCount: event.itemCount,
    itemNames: event.itemNames,
    items: event.items.map((i) => ({ productId: i.productId, variantId: i.variantId, sku: i.sku, name: i.name, quantity: i.quantity })),
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

  // The phone number identifies the customer first, the email second - never "whichever row the database returns first", so a cart whose phone and
  // email belong to two different leads is attached to the phone's lead every time.
  if (normalizedMobile) {
    const byPhone = await tx.lead.findFirst({ where: { normalizedMobile }, select: { id: true }, orderBy: { createdAt: "asc" } });
    if (byPhone) return byPhone;
  }
  if (normalizedEmail) {
    const byEmail = await tx.lead.findFirst({ where: { normalizedEmail }, select: { id: true }, orderBy: { createdAt: "asc" } });
    if (byEmail) return byEmail;
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

export interface SaveAbandonmentOptions {
  /** Provenance of the row. Defaults describe a live Shiprocket Checkout webhook delivery; a CSV import overrides them. */
  referenceType?: string;
  activitySource?: ActivitySource;
  createdTitle?: string;
  updatedTitle?: string;
}

/** The SAVE step: resolves (or creates) the lead, then creates or refreshes the one open CHECKOUT abandonment for the cart. Shared by the webhook processor and the CSV import. */
export async function saveAbandonment(tx: Db, event: ParsedAbandonment, now: Date, options: SaveAbandonmentOptions = {}): Promise<{ leadId: string; created: boolean }> {
  const lead = await resolveLead(tx, event);
  const { score, reason } = priorityFromCartValue(event.cartValue);
  const detectedAt = event.abandonedAt ?? now;

  // One open (ACTIVE/IN_PROGRESS) CHECKOUT abandonment per cart: a repeat delivery for the same
  // cart (Shiprocket Checkout may resend as the customer keeps stalling) refreshes it in place
  // instead of flooding the queue with duplicates for a lead who has not been called yet.
  const existing = event.externalId
    ? await tx.abandonment.findFirst({
        where: { leadId: lead.id, type: AbandonmentType.CHECKOUT, referenceId: event.externalId, status: { in: [AbandonmentStatus.ACTIVE, AbandonmentStatus.IN_PROGRESS] } },
        select: { id: true, detectedAt: true },
      })
    : null;

  const previousSnapshot = existing
    ? (await tx.abandonment.findUnique({ where: { id: existing.id }, select: { cartSnapshot: true } }))?.cartSnapshot
    : undefined;
  const cartSnapshot = buildCartSnapshot(event, previousSnapshot) as Prisma.InputJsonObject;

  const abandonment = existing
    ? await tx.abandonment.update({
        where: { id: existing.id },
        data: { detectedAt: detectedAt.getTime() >= existing.detectedAt.getTime() ? detectedAt : existing.detectedAt, priorityScore: score, priorityReason: reason, cartSnapshot },
      })
    : await tx.abandonment.create({
        data: {
          leadId: lead.id,
          type: AbandonmentType.CHECKOUT,
          sourceId: await ensureCheckoutSource(tx),
          referenceType: options.referenceType ?? "ShiprocketCheckoutCart",
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
      source: options.activitySource ?? ActivitySource.SHIPROCKET_WEBHOOK,
      title: existing ? (options.updatedTitle ?? "Checkout abandonment updated") : (options.createdTitle ?? "Checkout abandoned"),
      description: summarize(event),
    },
  });

  await tx.lead.update({ where: { id: lead.id }, data: { lastActivityAt: detectedAt } });
  return { leadId: lead.id, created: !existing };
}

export async function processAbandonmentEvent(eventId: string, deps: AbandonmentProcessorDeps): Promise<AbandonmentProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const stored = await deps.store.claim(eventId, now());
  if (!stored) return "skipped";
  return processClaimedAbandonmentEvent(stored, deps);
}

/** Processes an event the caller has ALREADY claimed (the live path claims through the store; the recovery pass claims dead events itself). */
export async function processClaimedAbandonmentEvent(stored: { id: string; payload: unknown; attempts: number }, deps: AbandonmentProcessorDeps): Promise<AbandonmentProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const eventId = stored.id;
  const started = Date.now();

  try {
    const event = parseAbandonmentEvent(stored.payload);
    if (!event) {
      ingestionMetrics.inc("unusableNoContact");
      await deps.store.complete(eventId, "IGNORED", now());
      return "ignored";
    }

    // 1) THE SAVE - its own transaction, committed before anything else is attempted.
    const saved = await deps.runner.$transaction((tx) => saveAbandonment(tx, event, now()), SAVE_TX_OPTIONS);

    // 2) AUTO-ASSIGNMENT - separate and best-effort. Only a genuinely new abandonment tries it (a repeat delivery for the same cart never re-triggers it, matching manual assignment's own
    //    "don't clobber an existing owner" behaviour), and never during a recovery pass. If it fails the checkout is already saved: the lead simply stays unassigned (visible on the
    //    distribution dashboard) rather than the whole delivery failing and, eventually, being lost.
    if (saved.created && deps.autoAssign !== false) {
      try {
        await deps.runner.$transaction(async (tx) => {
          const fullLead = await tx.lead.findUniqueOrThrow({ where: { id: saved.leadId } });
          await leadService.autoAssignAbandonedLead(tx, fullLead);
        }, ASSIGN_TX_OPTIONS);
      } catch (error) {
        ingestionMetrics.inc("autoAssignFailed");
        logger.warn(`fastrr.ingest auto_assign_failed event=${eventId} reason=${safeMessage(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
      }
    }

    await deps.store.complete(eventId, "PROCESSED", now());
    ingestionMetrics.inc("processed");
    logger.info(`fastrr.ingest processed event=${eventId} attempts=${stored.attempts} created=${saved.created} ms=${Date.now() - started}`);
    return "processed";
  } catch (error) {
    ingestionMetrics.inc("failedAttempts");
    const exhausted = stored.attempts >= ABANDONMENT_MAX_ATTEMPTS;
    if (exhausted) ingestionMetrics.inc("exhausted");
    const message = safeMessage(error instanceof Error ? error.message : String(error));
    await deps.store.fail(eventId, message, exhausted ? null : new Date(now().getTime() + abandonmentBackoffMs(stored.attempts)));
    logger.warn(`fastrr.ingest failed event=${eventId} attempts=${stored.attempts} exhausted=${exhausted} ms=${Date.now() - started} reason=${message.slice(0, 120)}`);
    return exhausted ? "failed" : "retry";
  }
}
