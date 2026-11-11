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

/** The destination as it is safe to log: scheme, host, port and path only - never credentials or a query string. */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(invalid OMS_WHATSAPP_FORWARD_URL)";
  }
}

/**
 * Why a forward attempt failed, in words. Node's fetch reports every network problem as the unhelpful "fetch failed" and puts the real reason (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, a TLS error ...)
 * in `error.cause`, sometimes one level deeper (AggregateError when both IPv6 and IPv4 are tried). This unwraps that, adds the target, and never includes the secret.
 */
export function describeForwardError(error: unknown, url: string): string {
  const target = describeTarget(url);
  if (!(error instanceof Error)) return `${String(error)} (target ${target})`;
  if (error.name === "AbortError") return `no response from OMS within ${FORWARD_TIMEOUT_MS / 1000}s (timeout) (target ${target})`;
  const reasons: string[] = [];
  const walk = (e: unknown, depth: number) => {
    if (!e || typeof e !== "object" || depth > 3) return;
    const x = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
    const text = [typeof x.code === "string" ? x.code : null, typeof x.message === "string" && x.message !== "fetch failed" ? x.message : null].filter(Boolean).join(": ");
    if (text && !reasons.includes(text)) reasons.push(text);
    if (Array.isArray(x.errors)) for (const inner of x.errors) walk(inner, depth + 1);
    walk(x.cause, depth + 1);
  };
  walk(error.cause, 0);
  const hint = reasons.some((r) => /ECONNREFUSED/.test(r)) ? " - nothing is listening there; is the OMS running and is OMS_WHATSAPP_FORWARD_URL right?" : reasons.some((r) => /ENOTFOUND|EAI_AGAIN/.test(r)) ? " - the host name does not resolve (DNS)" : "";
  return `${error.message}${reasons.length ? `: ${reasons.join("; ")}` : ""} (target ${target})${hint}`;
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
      // A short, single-line excerpt of what the OMS said (it usually explains a 401 / 422), never the request or the secret.
      const excerpt = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
      const detail = `OMS responded ${response.status} (target ${describeTarget(url)})${excerpt ? `: ${excerpt}` : ""}`;
      await fail(id, detail, event.omsForwardAttempts);
      logger.warn(`whatsapp_oms_forward_failed: eventId=${id} status=${response.status} attempt=${event.omsForwardAttempts}/${MAX_ATTEMPTS} target=${describeTarget(url)}${excerpt ? ` body="${excerpt}"` : ""}`);
      return event.omsForwardAttempts >= MAX_ATTEMPTS ? "failed" : "retry";
    }

    await complete(id, new Date());
    return "forwarded";
  } catch (error) {
    const message = describeForwardError(error, url);
    await fail(id, message, event.omsForwardAttempts);
    logger.warn(`whatsapp_oms_forward_failed: eventId=${id} attempt=${event.omsForwardAttempts}/${MAX_ATTEMPTS} reason=${message}`);
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
