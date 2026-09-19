import type { WebhookStore } from "./shopify.webhook.store.js";

// A small in-process retry loop over the webhook_events table. It picks up deliveries that were recorded but not
// processed (a restart, a crash) and failures whose retry time has come. Claims are atomic in the database, so
// running more than one instance is safe.

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

  /** One pass. Exposed so tests (and a manual trigger) don't have to wait for the timer. */
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
