import { asRecord, asString, sha256Hex } from "../integrations/integrations.common.js";
import type { NormalizedStatusUpdate, WhatsAppDeliveryStatus } from "./whatsapp.provider.js";

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

// ---- message.status.updated - the one topic with a CONFIRMED real payload (captured 2026-09-22
// from this account's own AiSensy project; see whatsapp.aisensy.webhook.processor.ts for how this
// is used). Everything below reads only fields that were actually present in that captured delivery
// - nothing here is guessed. No other topic gets a parser yet; see TOPICS_OBSERVED_IN_DASHBOARD above.

// Confirmed statuses so far: SENT, READ - both map 1:1 onto the CRM's own existing
// WhatsAppDeliveryStatus values (whatsapp.provider.ts), so nothing new is invented here. Any other
// status AiSensy might send (e.g. DELIVERED, FAILED) is honestly reported as unsupported by
// parseAiSensyMessageStatusUpdate returning null, never guessed onto the closest value.
const CONFIRMED_STATUS_MAP: Record<string, WhatsAppDeliveryStatus> = {
  SENT: "SENT",
  READ: "READ",
};

// Which of the confirmed AiSensy millisecond-epoch timestamp fields corresponds to which confirmed
// status - only the two pairs actually observed (sent_at for SENT, read_at for READ).
const CONFIRMED_TIMESTAMP_FIELD: Record<string, string> = {
  SENT: "sent_at",
  READ: "read_at",
};

function msEpochToDate(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value) : null;
}

/**
 * Parses one message.status.updated delivery's confirmed `data.message` shape into the exact
 * NormalizedStatusUpdate shape whatsapp.service.ts's existing recordStatusUpdate() already consumes
 * (E7.1) - so that method's own idempotency/monotonic-status logic is reused as-is, never
 * duplicated. Returns null - never a guess - when the delivery does not match the confirmed shape:
 * no `data.message`, no `messageId`, no `status`, or a status outside CONFIRMED_STATUS_MAP.
 */
export function parseAiSensyMessageStatusUpdate(payload: unknown, now: () => Date = () => new Date()): NormalizedStatusUpdate | null {
  const body = asRecord(payload);
  const message = asRecord(asRecord(body.data).message);

  const messageId = asString(message.messageId);
  const rawStatus = asString(message.status);
  if (!messageId || !rawStatus) return null;

  const status = CONFIRMED_STATUS_MAP[rawStatus.toUpperCase()];
  if (!status) return null;

  const tsField = CONFIRMED_TIMESTAMP_FIELD[status];
  const createdAt = asString(body.created_at);
  const timestamp = msEpochToDate(message[tsField]) ?? (createdAt ? new Date(createdAt) : null) ?? now();

  return { providerMessageId: messageId, status, timestamp };
}
