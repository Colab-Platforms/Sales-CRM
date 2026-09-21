import type { WebhookStore } from "../shopify/shopify.webhook.store.js";
import { deliveryId, parseShiprocketEvent, verifyShiprocketToken } from "./shiprocket.events.js";

// Receives one Shiprocket tracking webhook: authenticate, record, acknowledge; the update itself happens afterwards.
// Shiprocket has no signature scheme the CRM can rely on, only the optional shared token it sends as x-api-key - so the
// CRM requires that token and refuses everything without it. A body that names no shipment is recorded but ignored.

export interface ShiprocketWebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface ShiprocketWebhookResponse {
  status: number;
  message: string;
}

export interface ShiprocketHandlerDeps {
  /** null when Shiprocket is not enabled / has no token configured: every delivery is refused. */
  config: { readonly token: string } | null;
  store: WebhookStore;
  schedule: (eventId: string) => void;
}

export const EVENT_TYPE = "shipment.status";

export async function handleShiprocketWebhook(req: ShiprocketWebhookRequest, deps: ShiprocketHandlerDeps): Promise<ShiprocketWebhookResponse> {
  const { config, store, schedule } = deps;
  if (!config) return { status: 503, message: "Shiprocket webhooks are not configured" };
  if (!verifyShiprocketToken(req.headers, config.token)) return { status: 401, message: "Invalid token" };

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return { status: 400, message: "Body is not valid JSON" };
  }

  const usable = parseShiprocketEvent(payload) !== null;
  const { id, duplicate } = await store.record({ eventType: EVENT_TYPE, externalEventId: deliveryId(req.rawBody), payload, ignored: !usable });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };
  if (!usable) return { status: 200, message: "Delivery does not identify a shipment" };

  schedule(id);
  return { status: 200, message: "Received" };
}
