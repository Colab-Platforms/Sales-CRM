import { logger } from "@/utils/logger.js";
import type { DbClient } from "@/lib/leadScope.js";
import { safeMessage } from "../integrations/integrations.common.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "../shopify/shopify.webhook.store.js";
import { parseAiSensyMessageStatusUpdate } from "./whatsapp.aisensy.webhook.events.js";
import WhatsAppService from "./whatsapp.service.js";

// Turns one stored AiSensy Project Webhook delivery into a CRM WhatsAppMessage status update - the
// ONLY topic processed today is message.status.updated (see whatsapp.aisensy.webhook.handler.ts,
// which only schedules this for that one topic; every other topic is recorded and left IGNORED,
// never reaching this file).
//
// Deliberately reuses whatsapp.service.ts's existing recordStatusUpdate() rather than writing a
// second status-write path: that method already implements the idempotent (provider,
// providerMessageId) lookup, the monotonic status-rank rule (a lower-rank event never moves status
// backwards, e.g. a late SENT after READ), the per-status timestamp field, and the Activity entry -
// all exactly what this task's own idempotency/status-progression requirements ask for, already
// tested against the Direct webhook. This file's only job is: is this delivery the one confirmed
// topic, does it parse, does a matching CRM message exist - then hand off.

export type ProcessOutcome = "processed" | "ignored" | "retry" | "failed" | "skipped";

const PROCESSED_TOPIC = "message.status.updated";

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
    // No other topic is auto-processed yet (see this file's header comment) - a stray scheduled
    // call for anything else is recorded but left alone, never guessed at.
    if (stored.eventType !== PROCESSED_TOPIC) {
      await deps.store.complete(id, "IGNORED", now());
      return "ignored";
    }

    const update = parseAiSensyMessageStatusUpdate(stored.payload, now);
    if (!update) {
      // Malformed/unsupported: no data.message, no messageId/status, or a status outside the
      // confirmed SENT/READ set - the raw webhook_events row (already written) is the record of it.
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
  } catch (error) {
    const exhausted = stored.attempts >= MAX_ATTEMPTS;
    await deps.store.fail(id, safeMessage(error instanceof Error ? error.message : String(error)), exhausted ? null : new Date(now().getTime() + backoffMs(stored.attempts)));
    return exhausted ? "failed" : "retry";
  }
}
