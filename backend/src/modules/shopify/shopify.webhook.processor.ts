import { resolveTarget } from "./shopify.webhook.handler.js";
import { backoffMs, MAX_ATTEMPTS, type WebhookStore } from "./shopify.webhook.store.js";

// Turns a stored delivery into a sync of the record it refers to. The webhook body is only used to find out
// WHICH record changed; the record itself is re-read from Shopify, so a stale or partial payload can't corrupt data.

export interface ProcessorDeps {
  store: WebhookStore;
  sync: {
    order(id: string): Promise<{ notFound: boolean }>;
    product(id: string): Promise<{ notFound: boolean }>;
    customer(id: string): Promise<{ notFound: boolean }>;
  };
  now?: () => Date;
}

/**
 * processed: synced. ignored: nothing to do. retry: failed, will be tried again later.
 * failed: gave up after MAX_ATTEMPTS. skipped: not ours to process (already done, or another worker holds it).
 */
export type ProcessOutcome = "processed" | "ignored" | "retry" | "failed" | "skipped";

const scrub = (text: string) => text.replace(/shp(?:at|ca|pa|ss)_[A-Za-z0-9]+/g, "[REDACTED]");

export async function processWebhookEvent(id: string, deps: ProcessorDeps): Promise<ProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const event = await deps.store.claim(id, now());
  if (!event) return "skipped";

  try {
    const target = resolveTarget(event.eventType, event.payload);
    if (!target) {
      await deps.store.complete(id, "IGNORED", now());
      return "ignored";
    }
    const { notFound } = await deps.sync[target.kind](target.id);
    await deps.store.complete(id, notFound ? "IGNORED" : "PROCESSED", now());
    return notFound ? "ignored" : "processed";
  } catch (error) {
    const exhausted = event.attempts >= MAX_ATTEMPTS;
    const message = scrub(error instanceof Error ? error.message : String(error));
    await deps.store.fail(id, message, exhausted ? null : new Date(now().getTime() + backoffMs(event.attempts)));
    return exhausted ? "failed" : "retry";
  }
}
