import { bodyDigest } from "./whatsapp.hmac.js";
import type { RawWebhookRequest, WhatsAppProvider } from "./whatsapp.provider.js";
import type { WebhookStore } from "./whatsapp.webhook.store.js";

// Receives one WhatsApp webhook delivery. Authenticates, records, and acknowledges; the actual
// parsing/persistence happens afterwards (see whatsapp.webhook.processor.ts) - mirrors
// shopify.webhook.handler.ts's receive-then-process split.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export interface HandlerDeps {
  /** null when this provider is not the one configured (or WhatsApp is off entirely). */
  provider: WhatsAppProvider | null;
  store: WebhookStore;
  schedule: (eventId: string) => void;
}

export interface WebhookResponse {
  status: number;
  message: string;
}

export async function handleWhatsAppWebhook(req: RawWebhookRequest, deps: HandlerDeps): Promise<WebhookResponse> {
  const { provider, store, schedule } = deps;
  if (!provider) return { status: 503, message: "WhatsApp is not configured" };

  // 1. Authenticate against the raw bytes/headers, before anything is parsed.
  if (!provider.verifyWebhook(req)) return { status: 401, message: "Invalid signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return { status: 400, message: "Body is not valid JSON" };
  }

  // A label for observability only - which parser(s) actually apply is decided later, defensively,
  // in the processor, since neither BSP's exact envelope is assumed to be fully known up front.
  const eventType = isObject(payload) && typeof payload.type === "string" ? payload.type : "unknown";
  const deliveryId = bodyDigest(req.rawBody);

  // 2. Record it. The digest-based delivery id makes an exact repeat harmless.
  const { id, duplicate } = await store.record({ eventType, externalEventId: deliveryId, payload });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };

  // 3. Acknowledge now; process afterwards.
  schedule(id);
  return { status: 200, message: "Received" };
}
