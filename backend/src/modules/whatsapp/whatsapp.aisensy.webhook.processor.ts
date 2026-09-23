import { logger } from "@/utils/logger.js";
import type { DbClient } from "@/lib/leadScope.js";
import { safeMessage } from "../integrations/integrations.common.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import { parseAiSensyMessageCreated, parseAiSensyMessageStatusUpdate } from "./whatsapp.aisensy.webhook.events.js";
import WhatsAppService from "./whatsapp.service.js";

// Turns one stored AiSensy Project Webhook delivery into a CRM write - the ONLY topics processed
// today are message.status.updated and message.created (see whatsapp.aisensy.webhook.handler.ts,
// which only schedules those two; every other topic is recorded and left IGNORED, never reaching
// this file).
//
// Both branches deliberately reuse whatsapp.service.ts's existing methods rather than writing a
// second status/message-write path:
//   - recordStatusUpdate(): idempotent (provider, providerMessageId) lookup, the monotonic
//     status-rank rule (SENT < DELIVERED < READ < FAILED - a lower-rank event never moves status
//     backwards), the per-status timestamp field, and the Activity entry.
//   - recordInboundMessage(): idempotent (provider, providerMessageId) lookup, phone-based lead
//     matching (never creates a lead), and the Activity entry when matched.
// Both are already tested against the Direct WhatsApp webhook. This file's only job per branch is:
// is this delivery the one confirmed topic, does it parse, does the relevant CRM state exist - then
// hand off.

export type ProcessOutcome = "processed" | "ignored" | "retry" | "failed" | "skipped";

const STATUS_TOPIC = "message.status.updated";
const CREATED_TOPIC = "message.created";

export interface AiSensyProjectWebhookProcessorDeps {
  store: WebhookStore;
  db: DbClient;
  now?: () => Date;
}

export async function processAiSensyProjectWebhookEvent(id: string, deps: AiSensyProjectWebhookProcessorDeps): Promise<ProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const stored = await deps.store.claim(id, now());
  if (!stored) return "skipped";

  try {
    if (stored.eventType === STATUS_TOPIC) return await processStatusUpdate(stored.payload, deps, id, now);
    if (stored.eventType === CREATED_TOPIC) return await processMessageCreated(stored.payload, deps, id, now);

    // No other topic is auto-processed yet (see this file's header comment) - a stray scheduled
    // call for anything else is recorded but left alone, never guessed at.
    await deps.store.complete(id, "IGNORED", now());
    return "ignored";
  } catch (error) {
    const exhausted = stored.attempts >= MAX_ATTEMPTS;
    await deps.store.fail(id, safeMessage(error instanceof Error ? error.message : String(error)), exhausted ? null : new Date(now().getTime() + backoffMs(stored.attempts)));
    return exhausted ? "failed" : "retry";
  }
}

async function processStatusUpdate(payload: unknown, deps: AiSensyProjectWebhookProcessorDeps, id: string, now: () => Date): Promise<ProcessOutcome> {
  const update = parseAiSensyMessageStatusUpdate(payload, now);
  if (!update) {
    // Malformed/unsupported: no data.message, no messageId/status, or a status outside the
    // confirmed SENT/DELIVERED/READ set - the raw webhook_events row (already written) is the record of it.
    await deps.store.complete(id, "IGNORED", now());
    return "ignored";
  }

  // Checked here (read-only) purely so an unmatched messageId is visibly logged - see item 13 of
  // the task this implements. recordStatusUpdate() below re-checks this itself and is what
  // actually decides whether to write; this never duplicates that decision, only reports on it.
  const existing = await deps.db.whatsAppMessage.findUnique({
    where: { provider_providerMessageId: { provider: "AISENSY", providerMessageId: update.providerMessageId } },
    select: { id: true },
  });
  if (!existing) {
    logger.info(`AiSensy message.status.updated: no matching CRM WhatsAppMessage for messageId ${update.providerMessageId} - event stored, not applied`);
    await deps.store.complete(id, "IGNORED", now());
    return "ignored";
  }

  await new WhatsAppService(deps.db).recordStatusUpdate("AISENSY", update);
  await deps.store.complete(id, "PROCESSED", now());
  return "processed";
}

async function processMessageCreated(payload: unknown, deps: AiSensyProjectWebhookProcessorDeps, id: string, now: () => Date): Promise<ProcessOutcome> {
  const result = parseAiSensyMessageCreated(payload, now);

  if (result.kind === "outbound_ignored" || result.kind === "api_sender_ignored") {
    logger.info(`AiSensy message.created: ${result.reason}`);
    await deps.store.complete(id, "IGNORED", now());
    return "ignored";
  }
  if (result.kind === "unsupported") {
    logger.info(`AiSensy message.created: unsupported - ${result.reason}`);
    await deps.store.complete(id, "IGNORED", now());
    return "ignored";
  }

  // recordInboundMessage() itself is fully idempotent on (provider, providerMessageId) and never
  // creates a lead (matches an existing one by phone via matchSenderToLead, or leaves leadId null) -
  // exactly the "do not create duplicate/fake customers" rule this task requires, reused as-is.
  await new WhatsAppService(deps.db).recordInboundMessage("AISENSY", result.message);
  await deps.store.complete(id, "PROCESSED", now());
  return "processed";
}
