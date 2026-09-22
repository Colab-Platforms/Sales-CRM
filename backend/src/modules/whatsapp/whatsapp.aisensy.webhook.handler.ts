import { timingSafeEqual } from "node:crypto";
import type { AiSensyProjectWebhookConfig } from "./whatsapp.aisensy.webhook.config.js";
import { deliveryId, extractTopic } from "./whatsapp.aisensy.webhook.events.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";

// Receives one AiSensy Project Webhook delivery (contact.*, message.*, payment.*, order.placed,
// lead_form.submitted - see whatsapp.aisensy.webhook.events.ts). Deliberately does NOT parse any
// topic's fields or write any CRM record: AiSensy's documented Project API covers the webhook
// SUBSCRIPTION object, not the shape of an individual delivery, and no signature/verification header
// is documented for this feature (see whatsapp.aisensy.webhook.config.ts) - so, per this task's own
// instructions, nothing here guesses a payload schema or invents a verification mechanism. Every
// syntactically valid delivery is safely recorded (deduplicated, never processed further) so a human
// can inspect real deliveries later and this file can be extended once AiSensy's actual schema for a
// given topic is confirmed - grep this codebase for "AISENSY_PROJECT_WEBHOOK" to find every place
// that would need updating.

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export interface AiSensyProjectWebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Express still parses the query string even under express.raw() - see the CRM-chosen `token` safeguard below. */
  query: Record<string, unknown>;
}

export interface AiSensyProjectWebhookResponse {
  status: number;
  message: string;
}

export interface AiSensyProjectWebhookHandlerDeps {
  config: AiSensyProjectWebhookConfig;
  store: WebhookStore;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export async function handleAiSensyProjectWebhook(req: AiSensyProjectWebhookRequest, deps: AiSensyProjectWebhookHandlerDeps): Promise<AiSensyProjectWebhookResponse> {
  const { config, store } = deps;

  // 1. The CRM's own optional safeguard (never claimed to be an AiSensy-verified signature - see
  // whatsapp.aisensy.webhook.config.ts). Skipped entirely when no token is configured.
  if (config.token) {
    const given = req.query.token;
    if (typeof given !== "string" || !timingSafeStringEqual(given, config.token)) {
      return { status: 401, message: "Invalid or missing token" };
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return { status: 400, message: "Body is not valid JSON" };
  }
  if (!isObject(payload) && !Array.isArray(payload)) {
    // Valid JSON but not a structure any topic could plausibly use (e.g. a bare number/string) -
    // still worth keeping for reconciliation, never worth guessing at.
    payload = { raw: payload };
  }

  const topic = extractTopic(payload) ?? "unknown";

  // 2. Record only - see this file's header comment for why nothing is processed further yet.
  // `ignored: true` is honest, not a placeholder: no business logic exists for any topic today.
  const { duplicate } = await store.record({ eventType: topic, externalEventId: deliveryId(req.rawBody), payload, ignored: true });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };

  return { status: 200, message: `Received (topic "${topic}") - stored for later reconciliation; no automatic processing is implemented for AiSensy Project Webhook topics yet` };
}
