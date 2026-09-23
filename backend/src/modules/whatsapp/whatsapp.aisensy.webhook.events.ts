import { asRecord, asString, sha256Hex } from "../integrations/integrations.common.js";
import type { NormalizedIncomingMessage, NormalizedStatusUpdate, WhatsAppDeliveryStatus } from "./whatsapp.provider.js";

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
//
// CORRELATION KEY, confirmed 2026-09-23 from a real CRM-originated send: `data.message.messageId` is
// NOT stable for an outbound message across its own lifecycle - it is an AiSensy-internal
// "AS-..." id on the message.created delivery, and only becomes the real WhatsApp "wamid..." id once
// WhatsApp actually delivers it (both were observed for the exact same message in this account's real
// test). `data.message.submitted_message_id`, by contrast, was identical (a stable UUID) across
// message.created and every subsequent message.status.updated for that same message - it is the id
// AiSensy assigns at submission time, which is why AiSensyProvider.sendTemplateMessage() now captures
// it from the send response as providerMessageId (see whatsapp.aisensy.provider.ts). Matching
// therefore prefers submitted_message_id, falling back to messageId only when it is absent - which
// covers inbound messages (sender=USER), where submitted_message_id is always empty (the customer,
// not this CRM, originated the message) and messageId - a real wamid from the moment WhatsApp
// receives it - is already the correct, stable key (see parseAiSensyMessageCreated below, unchanged).

// Confirmed statuses so far: SENT, DELIVERED, READ (DELIVERED confirmed 2026-09-22 from a real
// chatbot delivery in this account - see the task that added it) - all three map 1:1 onto the CRM's
// own existing WhatsAppDeliveryStatus/WhatsAppMessageStatus values (whatsapp.provider.ts /
// prisma/schema/enums.prisma), so nothing new is invented here and no migration is needed. Any other
// status AiSensy might send (e.g. FAILED) is honestly reported as unsupported by
// parseAiSensyMessageStatusUpdate returning null, never guessed onto the closest value. The CRM's
// existing STATUS_RANK (whatsapp.service.ts: SENT=1 < DELIVERED=2 < READ=3 < FAILED=4) already
// enforces SENT -> DELIVERED -> READ and rejects any regression - reused as-is, not reimplemented.
const CONFIRMED_STATUS_MAP: Record<string, WhatsAppDeliveryStatus> = {
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
};

// Which of the confirmed AiSensy millisecond-epoch timestamp fields corresponds to which confirmed
// status - only the pairs actually observed (sent_at/delivered_at/read_at).
const CONFIRMED_TIMESTAMP_FIELD: Record<string, string> = {
  SENT: "sent_at",
  DELIVERED: "delivered_at",
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
 * no `data.message`, no correlation id, no `status`, or a status outside CONFIRMED_STATUS_MAP.
 *
 * providerMessageId is `submitted_message_id` when present (the correct, stable key for a
 * CRM-originated outbound message - see this file's header comment), falling back to `messageId`
 * only when it is not (inbound messages, and any older/synthetic payload that never had this field).
 */
export function parseAiSensyMessageStatusUpdate(payload: unknown, now: () => Date = () => new Date()): NormalizedStatusUpdate | null {
  const body = asRecord(payload);
  const message = asRecord(asRecord(body.data).message);

  const providerMessageId = asString(message.submitted_message_id) ?? asString(message.messageId);
  const rawStatus = asString(message.status);
  if (!providerMessageId || !rawStatus) return null;

  const status = CONFIRMED_STATUS_MAP[rawStatus.toUpperCase()];
  if (!status) return null;

  const tsField = CONFIRMED_TIMESTAMP_FIELD[status];
  const createdAt = asString(body.created_at);
  const timestamp = msEpochToDate(message[tsField]) ?? (createdAt ? new Date(createdAt) : null) ?? now();

  return { providerMessageId, status, timestamp };
}

// ---- message.created - the second topic with a CONFIRMED real payload. Three sender values have
// now been observed for real, and only these three: "USER" (a real inbound "Hello" from a customer's
// phone, captured 2026-09-22), "ASSISTANT" (a chatbot auto-reply, same date), and "API" (a real
// CRM-originated send through WhatsAppService.sendTemplateMessage(), captured 2026-09-23 - see
// whatsapp.aisensy.provider.ts). Everything below reads only fields actually present in those
// captured deliveries.
//
// Direction: the task this was first added for explicitly warned not to assume sender=ASSISTANT
// means inbound. The real captured deliveries settle it: sender "USER" is the customer (inbound to
// the CRM); "ASSISTANT" and "API" are both outbound - something the CRM either did not originate
// (the chatbot) or already recorded itself at send time (an API-originated send, via
// message.status.updated matching on submitted_message_id, not through this message.created event) -
// so neither is ever synced as a second/duplicate CRM message from this topic. No other sender value
// has been observed, so anything else is honestly reported as unsupported rather than guessed in
// either direction.
export type AiSensyMessageCreatedResult =
  | { kind: "inbound"; message: NormalizedIncomingMessage }
  /** sender "ASSISTANT": a real, recognised chatbot reply - by design not synced as a CRM message (see the processor). */
  | { kind: "outbound_ignored"; reason: string }
  /** sender "API": a real, recognised CRM-originated send - already recorded by the send itself; this event only confirms AiSensy received it, and is not a second write path. */
  | { kind: "api_sender_ignored"; reason: string }
  /** Recognised as message.created but outside the confirmed shape: unknown sender, unsupported message_type, or missing fields. */
  | { kind: "unsupported"; reason: string };

/** Only TEXT has a confirmed content field (`message_content.text`) - anything else is reported unsupported, never guessed at. */
const SUPPORTED_MESSAGE_TYPES = new Set(["TEXT"]);

export function parseAiSensyMessageCreated(payload: unknown, now: () => Date = () => new Date()): AiSensyMessageCreatedResult {
  const body = asRecord(payload);
  const message = asRecord(asRecord(body.data).message);

  const messageId = asString(message.messageId);
  const phone = asString(message.phone_number);
  const sender = asString(message.sender);
  if (!messageId || !phone || !sender) {
    return { kind: "unsupported", reason: "data.message is missing messageId, phone_number, or sender" };
  }

  if (sender === "ASSISTANT") {
    return { kind: "outbound_ignored", reason: "chatbot-generated reply (sender=ASSISTANT) - not something the CRM originated, so not synced as an outbound WhatsAppMessage" };
  }
  if (sender === "API") {
    return { kind: "api_sender_ignored", reason: "CRM-originated send (sender=API) - already recorded by WhatsAppService.sendTemplateMessage() at send time; not created again from this event" };
  }
  if (sender !== "USER") {
    return { kind: "unsupported", reason: `unrecognised sender "${sender}" - direction cannot be safely determined from confirmed data` };
  }

  const messageType = asString(message.message_type);
  if (!messageType || !SUPPORTED_MESSAGE_TYPES.has(messageType)) {
    return { kind: "unsupported", reason: `unsupported message_type "${messageType ?? "(none)"}" - only TEXT has a confirmed content field` };
  }
  const text = asString(asRecord(message.message_content).text);
  if (!text) return { kind: "unsupported", reason: "TEXT message with no message_content.text" };

  const createdAt = asString(body.created_at);
  const timestamp = msEpochToDate(message.sent_at) ?? (createdAt ? new Date(createdAt) : null) ?? now();

  return {
    kind: "inbound",
    message: { providerMessageId: messageId, from: phone, to: null, messageType: "TEXT", text, timestamp },
  };
}
