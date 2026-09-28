import { logger } from "@/utils/logger.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";
import { deliveryId, parseAbandonmentEvent, verifyAbandonmentSecret } from "./shiprocket.abandonment.mapper.js";

// Receives one Shiprocket Checkout "Abandon Cart" webhook delivery: authenticate, record, acknowledge;
// the lead/abandonment write happens afterwards. Mirrors shiprocket.webhook.handler.ts (the AWB/tracking
// webhook) - same record-then-process shape, different provider event and different auth (a shared
// secret header we chose ourselves, since the dashboard offers no signature scheme).

export interface AbandonmentWebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface AbandonmentWebhookResponse {
  status: number;
  message: string;
}

export interface AbandonmentHandlerDeps {
  /** null when no shared secret is configured: every delivery is refused. */
  config: { readonly secret: string } | null;
  store: WebhookStore;
  schedule: (eventId: string) => void;
}

export const EVENT_TYPE = "checkout.abandoned";

export async function handleAbandonmentWebhook(req: AbandonmentWebhookRequest, deps: AbandonmentHandlerDeps): Promise<AbandonmentWebhookResponse> {
  const { config, store, schedule } = deps;
  if (!config) return { status: 503, message: "Shiprocket Checkout abandonment webhook is not configured" };
  if (!verifyAbandonmentSecret(req.headers, config.secret)) return { status: 401, message: "Invalid or missing webhook secret" };

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return { status: 400, message: "Body is not valid JSON" };
  }

  const parsed = parseAbandonmentEvent(payload);
  const usable = parsed !== null;
  // Printed on every delivery while this integration is still being verified against real traffic -
  // the fastest way to see what Shiprocket Checkout actually sent without a DB query. Consider
  // trimming this once the mapper is confirmed stable, since it logs customer PII (phone/email/name).
  logger.info(`Shiprocket Checkout abandon-cart delivery received (usable=${usable}): ${JSON.stringify(payload)}`);
  if (parsed) logger.info(`Parsed as: ${JSON.stringify(parsed)}`);
  const { id, duplicate } = await store.record({ eventType: EVENT_TYPE, externalEventId: deliveryId(req.rawBody), payload, ignored: !usable });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };
  if (!usable) return { status: 200, message: "Delivery has no usable contact (phone/email)" };

  schedule(id);
  return { status: 200, message: "Received" };
}
