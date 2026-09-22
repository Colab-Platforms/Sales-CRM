import { asRecord, asString, sha256Hex } from "../integrations/integrations.common.js";

// AiSensy Project Webhook topic handling - deliberately minimal. See whatsapp.aisensy.webhook.config.ts
// for why. This file exists to answer exactly two questions, both purely for observability/idempotency,
// never for business logic:
//   1. What topic did this delivery say it was? (best-effort label only)
//   2. How do we recognise the exact same delivery again? (dedup key)
//
// TOPICS_OBSERVED_IN_DASHBOARD lists the topic names seen in this account's AiSensy Webhook UI
// (contact.created is also independently confirmed by AiSensy's own Project API docs as a real
// `topics` value - https://aisensy.stoplight.io/docs/project-api/5c31957223dc7-webhook). The exact
// JSON payload AiSensy POSTs for ANY of these topics is NOT documented anywhere this task could
// reach (the Stoplight docs describe the webhook SUBSCRIPTION object, not an individual delivery).
// Nothing here parses a topic's fields or acts on them - see whatsapp.aisensy.webhook.handler.ts.
export const TOPICS_OBSERVED_IN_DASHBOARD = [
  "contact.created",
  "contact.tag.updated",
  "contact.chat.requesting",
  "contact.chat.intervened",
  "contact.chat.closed",
  "contact.campaign.sent",
  "contact.campaign.read",
  "message.created",
  "message.status.updated",
  "message.sender.user",
  "payment.captured",
  "payment.refunded",
  "order.placed",
  "lead_form.submitted",
] as const;

/**
 * Best-effort topic label for one delivery - tries the field names other webhook-topic systems
 * commonly use (`type`, `topic`, `event`), same defensive, never-throws, label-only spirit as the
 * existing Direct-webhook handler's `payload.type` read (whatsapp.webhook.handler.ts). Returns null,
 * never a guess, when none of those fields is present or is not a string.
 */
export function extractTopic(payload: unknown): string | null {
  const body = asRecord(payload);
  return asString(body.type) ?? asString(body.topic) ?? asString(body.event);
}

/**
 * AiSensy's Project Webhook docs do not name a per-delivery id field (unlike, say, Cashfree's
 * x-idempotency-key header), so - exactly as instructed when no provider id is available - this
 * falls back to a hash of the exact raw bytes received. Limitation, stated plainly: two genuinely
 * different events that happen to serialise to byte-identical JSON would collide; a real retry of
 * the same delivery (the actual case this exists to catch) always does.
 */
export function deliveryId(rawBody: Buffer): string {
  return `sha256:${sha256Hex(rawBody)}`;
}
