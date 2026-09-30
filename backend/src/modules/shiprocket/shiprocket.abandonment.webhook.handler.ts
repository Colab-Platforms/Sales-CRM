import { logger } from "@/utils/logger.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";
import { deliveryId, parseAbandonmentEvent, summarize, verifyAbandonmentSecret } from "./shiprocket.abandonment.mapper.js";

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
  // One short line per delivery - name + cart summary, never the raw payload (that stays on the
  // WebhookEvent row for the rare case it needs inspecting). Full name only, no phone/email, to keep
  // PII out of the terminal.
  logger.info(
    parsed
      ? `Shiprocket abandon-cart: ${parsed.firstName}${parsed.lastName ? ` ${parsed.lastName}` : ""} - ${summarize(parsed)}`
      : "Shiprocket abandon-cart delivery ignored (no usable phone/email)",
  );
  const { id, duplicate } = await store.record({ eventType: EVENT_TYPE, externalEventId: deliveryId(req.rawBody), payload, ignored: !usable });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };
  if (!usable) return { status: 200, message: "Delivery has no usable contact (phone/email)" };

  schedule(id);
  return { status: 200, message: "Received" };
}
