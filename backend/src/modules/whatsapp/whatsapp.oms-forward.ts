import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { OmsForwardStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { backoffMs, LEASE_MS, MAX_ATTEMPTS } from "./whatsapp.webhook.store.js";
import { startWebhookWorker } from "./whatsapp.webhook.worker.js";

// Forwards already-recorded WhatsApp webhook_events rows (any provider in practice only Meta, since
// that's the only one whose events the OMS cares about) to the OMS, independently of this backend's
// own processing of those same rows (whatsapp.webhook.processor.ts / whatsapp.meta.webhook.routes.ts's
// `process()`). Reuses that pipeline's proven claim/lease/backoff shape (same LEASE_MS, MAX_ATTEMPTS,
// backoffMs) and its generic `startWebhookWorker` loop -- only the forward-specific columns
// (oms_forward_*) are new; `status`/`attempts`/`error_message` (this backend's OWN processing state)
// are never read or written here, so a forwarding failure can never affect them, and a processing
// failure there can never affect forwarding here.
//
// The delivery digest OMS needs for its own idempotency is the SAME `externalEventId` this backend
// already computed and stored when the event was first recorded (whatsapp.webhook.handler.ts's
// `bodyDigest(rawBody)`, format "sha256:<hex>") -- never recomputed from the stored JSON payload,
// which (re-serialized) is not guaranteed byte-identical to Meta's original raw bytes.

const FORWARD_TIMEOUT_MS = 10_000;

interface ForwardConfig {
  url: string | undefined;
  secret: string | undefined;
}

function config(): ForwardConfig {
  return { url: process.env.OMS_WHATSAPP_FORWARD_URL, secret: process.env.SALES_CRM_FORWARD_SECRET };
}

/** Whether forwarding is configured at all -- both env vars must be set, mirroring
 *  whatsapp.meta.factory.ts's own "not configured -> fully off" convention. */
export function isForwardingConfigured(): boolean {
  const { url, secret } = config();
  return Boolean(url && secret);
}

async function dueForForward(now: Date, limit: number): Promise<string[]> {
  const rows = await prisma.webhookEvent.findMany({
    where: {
      OR: [
        { omsForwardStatus: OmsForwardStatus.PENDING },
        {
          omsForwardStatus: OmsForwardStatus.FAILED,
          omsForwardNextAttemptAt: { lte: now },
          omsForwardAttempts: { lt: MAX_ATTEMPTS },
        },
        { omsForwardStatus: OmsForwardStatus.FORWARDING, omsForwardNextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

interface ClaimedEvent {
  id: string;
  payload: Prisma.JsonValue;
  externalEventId: string | null;
  omsForwardAttempts: number;
}

async function claim(id: string, now: Date): Promise<ClaimedEvent | null> {
  const claimed = await prisma.webhookEvent.updateMany({
    where: {
      id,
      OR: [
        { omsForwardStatus: OmsForwardStatus.PENDING },
        {
          omsForwardStatus: OmsForwardStatus.FAILED,
          omsForwardNextAttemptAt: { lte: now },
          omsForwardAttempts: { lt: MAX_ATTEMPTS },
        },
        { omsForwardStatus: OmsForwardStatus.FORWARDING, omsForwardNextAttemptAt: { lte: now } },
      ],
    },
    data: {
      omsForwardStatus: OmsForwardStatus.FORWARDING,
      omsForwardAttempts: { increment: 1 },
      omsForwardNextAttemptAt: new Date(now.getTime() + LEASE_MS),
    },
  });
  if (claimed.count === 0) return null;
  return prisma.webhookEvent.findUnique({
    where: { id },
    select: { id: true, payload: true, externalEventId: true, omsForwardAttempts: true },
  });
}

async function complete(id: string, now: Date): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: {
      omsForwardStatus: OmsForwardStatus.FORWARDED,
      omsForwardedAt: now,
      omsForwardErrorMessage: null,
      omsForwardNextAttemptAt: null,
    },
  });
}

async function fail(id: string, message: string, attempts: number): Promise<void> {
  const exhausted = attempts >= MAX_ATTEMPTS;
  await prisma.webhookEvent.update({
    where: { id },
    data: {
      omsForwardStatus: OmsForwardStatus.FAILED,
      // Never cleared/deleted when exhausted -- stays visibly FAILED (ops-queryable) rather than
      // silently discarded; it simply stops being picked up by `dueForForward`'s attempts<MAX filter.
      omsForwardErrorMessage: message.slice(0, 1000),
      omsForwardNextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs(attempts)),
    },
  });
}

/** Forwards one claimed event's payload to the OMS. Never throws -- every failure path (claim
 *  miss, not-configured, network error, timeout, non-2xx) is caught and resolved internally, since
 *  this is wired into `startWebhookWorker`'s loop, which must keep running regardless. */
export async function forwardOne(id: string): Promise<"forwarded" | "skipped" | "retry" | "failed"> {
  const { url, secret } = config();
  if (!url || !secret) return "skipped"; // forwarding fully off -- not an error

  const now = new Date();
  const event = await claim(id, now);
  if (!event) return "skipped";

  if (!event.externalEventId) {
    // Should not happen in practice (handler always sets it via bodyDigest) -- but never forward
    // something OMS cannot deduplicate, and never crash the worker over it either.
    await fail(id, "Missing delivery digest (externalEventId) -- cannot forward safely", event.omsForwardAttempts);
    return "failed";
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ payload: event.payload, delivery_digest: event.externalEventId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      await fail(id, `OMS responded ${response.status}`, event.omsForwardAttempts);
      logger.warn(`whatsapp_oms_forward_failed: eventId=${id} status=${response.status}`);
      return event.omsForwardAttempts >= MAX_ATTEMPTS ? "failed" : "retry";
    }

    await complete(id, new Date());
    return "forwarded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fail(id, message, event.omsForwardAttempts);
    logger.warn(`whatsapp_oms_forward_failed: eventId=${id} reason=${message}`);
    return event.omsForwardAttempts >= MAX_ATTEMPTS ? "failed" : "retry";
  }
}

/** Starts the independent OMS-forwarding retry loop, reusing the same generic worker shape as the
 *  Meta webhook's own processing loop. A no-op (never starts a timer) when forwarding isn't
 *  configured, matching `isForwardingConfigured()`. */
export function startOmsForwardWorker() {
  if (!isForwardingConfigured()) {
    logger.info("whatsapp_oms_forward_worker_not_configured");
    return { tick: async () => 0, stop: () => {} };
  }
  logger.info("WhatsApp OMS-forward worker started");
  return startWebhookWorker({
    store: { due: dueForForward },
    process: forwardOne,
    onError: (e) => logger.error("whatsapp_oms_forward_worker_error", e),
  });
}
