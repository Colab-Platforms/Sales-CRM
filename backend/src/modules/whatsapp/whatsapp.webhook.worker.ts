import type { WebhookStore } from "./whatsapp.webhook.store.js";

// Small in-process retry loop over the webhook_events table, scoped to one WhatsApp provider's
// rows. Mirrors shopify.webhook.worker.ts's generic, provider-agnostic shape; kept as its own
// small file rather than imported from the Shopify module so the two integrations stay
// independent of each other's internals.

export interface WorkerOptions {
  store: WebhookStore;
  process: (eventId: string) => Promise<unknown>;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export function startWebhookWorker({ store, process, intervalMs = 30_000, batchSize = 20, now = () => new Date(), onError }: WorkerOptions) {
  let running = false;

  const tick = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    let handled = 0;
    try {
      for (const id of await store.due(now(), batchSize)) {
        await process(id);
        handled++;
      }
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
    }
    return handled;
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
