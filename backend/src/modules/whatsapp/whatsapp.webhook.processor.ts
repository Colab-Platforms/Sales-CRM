import type { NormalizedIncomingMessage, NormalizedStatusUpdate, WhatsAppProvider } from "./whatsapp.provider.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "./whatsapp.webhook.store.js";

// Turns one stored delivery into database writes. Both parseIncomingWebhook and
// parseDeliveryStatusWebhook are always attempted: each only recognises its own payload shape and
// returns [] otherwise (see whatsapp.provider.ts's contract), so a delivery that is purely a
// message, purely a status update, or - for a provider that ever batches both - a mix of the two,
// is all handled the same way without needing to trust a topic/eventType label to route on.

export interface ProcessorDeps {
  store: WebhookStore;
  provider: WhatsAppProvider;
  persist: {
    message(m: NormalizedIncomingMessage): Promise<void>;
    status(s: NormalizedStatusUpdate): Promise<void>;
  };
  now?: () => Date;
}

export type ProcessOutcome = "processed" | "ignored" | "retry" | "failed" | "skipped";

export async function processWhatsAppWebhookEvent(id: string, deps: ProcessorDeps): Promise<ProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const event = await deps.store.claim(id, now());
  if (!event) return "skipped";

  try {
    const messages = deps.provider.parseIncomingWebhook(event.payload);
    const statuses = deps.provider.parseDeliveryStatusWebhook(event.payload);

    for (const m of messages) await deps.persist.message(m);
    for (const s of statuses) await deps.persist.status(s);

    const handled = messages.length > 0 || statuses.length > 0;
    await deps.store.complete(id, handled ? "PROCESSED" : "IGNORED", now());
    return handled ? "processed" : "ignored";
  } catch (error) {
    const exhausted = event.attempts >= MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.fail(id, message, exhausted ? null : new Date(now().getTime() + backoffMs(event.attempts)));
    return exhausted ? "failed" : "retry";
  }
}
