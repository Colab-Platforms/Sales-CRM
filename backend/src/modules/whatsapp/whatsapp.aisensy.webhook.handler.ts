import { timingSafeEqual } from "node:crypto";
import type { AiSensyProjectWebhookConfig } from "./whatsapp.aisensy.webhook.config.js";
import { deliveryId, extractTopic } from "./whatsapp.aisensy.webhook.events.js";
import type { WebhookStore } from "../shopify/shopify.webhook.store.js";

// Receives one AiSensy Project Webhook delivery (contact.*, message.*, payment.*, order.placed,
// lead_form.submitted - see whatsapp.aisensy.webhook.events.ts). No signature/verification header is
// documented for this feature (see whatsapp.aisensy.webhook.config.ts), so, per this task's own
// instructions, nothing here invents a verification mechanism.
//
// Every syntactically valid delivery is safely recorded and deduplicated regardless of topic.
// PROCESSED_TOPICS is the only set of topics whose payload shape is actually confirmed
// (whatsapp.aisensy.webhook.events.ts / .processor.ts) - only those are scheduled for further
// processing; every other topic is stored with `ignored: true`, exactly as before, so a human can
// inspect real deliveries later and this file can be extended once a given topic's schema is
// confirmed - grep this codebase for "AISENSY_PROJECT_WEBHOOK" to find every place that would need
// updating.

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
  /** Called only for a topic in PROCESSED_TOPICS, after the delivery is durably recorded. */
  schedule: (eventId: string) => void;
}

/** The only topics with a confirmed real payload today - see whatsapp.aisensy.webhook.processor.ts. */
const PROCESSED_TOPICS = new Set(["message.status.updated"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export async function handleAiSensyProjectWebhook(req: AiSensyProjectWebhookRequest, deps: AiSensyProjectWebhookHandlerDeps): Promise<AiSensyProjectWebhookResponse> {
  const { config, store, schedule } = deps;

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
  const willProcess = PROCESSED_TOPICS.has(topic);

  // 2. Record. `ignored: true` for every topic without a confirmed payload shape is honest, not a
  // placeholder - see this file's header comment.
  const { id, duplicate } = await store.record({ eventType: topic, externalEventId: deliveryId(req.rawBody), payload, ignored: !willProcess });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };

  // 3. Acknowledge now; process afterwards - only for a topic whose shape is actually confirmed.
  if (willProcess) schedule(id);

  return {
    status: 200,
    message: willProcess
      ? `Received (topic "${topic}") - queued for processing`
      : `Received (topic "${topic}") - stored for later reconciliation; no automatic processing is implemented for this topic yet`,
  };
}
