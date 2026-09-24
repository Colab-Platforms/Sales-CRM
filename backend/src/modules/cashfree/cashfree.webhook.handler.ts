import type { WebhookStore } from "../shopify/shopify.webhook.store.js";
import { deliveryId, eventType, SUPPORTED_TYPES } from "./cashfree.events.js";
import { verifyCashfreeSignature } from "./cashfree.hmac.js";

// Receives one Cashfree webhook delivery: authenticate against the raw bytes, record, acknowledge, and leave the actual
// work to the background processor. Cashfree retries until it gets a 200, so anything that is safely recorded (even a
// type the CRM does not act on) is answered 200; only a bad signature or unreadable body is refused.

export interface CashfreeWebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface CashfreeWebhookResponse {
  status: number;
  message: string;
}

export interface CashfreeHandlerDeps {
  /** null when Cashfree is not enabled / has no secret: every delivery is refused. */
  config: { readonly secret: string } | null;
  store: WebhookStore;
  schedule: (eventId: string) => void;
}

export async function handleCashfreeWebhook(req: CashfreeWebhookRequest, deps: CashfreeHandlerDeps): Promise<CashfreeWebhookResponse> {
  const { config, store, schedule } = deps;
  if (!config) return { status: 503, message: "Cashfree webhooks are not configured" };

  // 1. Authenticate before anything is parsed.
  if (!verifyCashfreeSignature(req.rawBody, req.headers, config.secret)) return { status: 401, message: "Invalid signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return { status: 400, message: "Body is not valid JSON" };
  }

  const type = eventType(payload);
  if (!type) return { status: 400, message: "Missing event type" };

  // 2. Record. The unique delivery id makes a repeat harmless.
  const supported = (SUPPORTED_TYPES as readonly string[]).includes(type);
  const { id, duplicate } = await store.record({ eventType: type, externalEventId: deliveryId(req.headers, req.rawBody), payload, ignored: !supported });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };
  if (!supported) return { status: 200, message: "Event type not handled" };

  // 3. Acknowledge now, process afterwards.
  schedule(id);
  return { status: 200, message: "Received" };
}
