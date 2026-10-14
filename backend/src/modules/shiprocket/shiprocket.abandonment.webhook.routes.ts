import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { abandonmentStore, SHIPROCKET_CHECKOUT_PROVIDER } from "./shiprocket.abandonment.store.js";
import { startWebhookWorker } from "../shopify/shopify.webhook.worker.js";
import { loadShiprocketAbandonmentWebhookConfig } from "./shiprocket.abandonment.config.js";
import { handleAbandonmentWebhook } from "./shiprocket.abandonment.webhook.handler.js";
import { processAbandonmentEvent } from "./shiprocket.abandonment.processor.js";
import { reconcileFailedAbandonmentEvents } from "./shiprocket.abandonment.reconcile.js";

// Express wiring for POST /api/webhooks/shiprocket/abandoned-cart. server.ts mounts this router with
// express.raw() before the JSON parser and the sanitizer, same reason as every other webhook route.

export { SHIPROCKET_CHECKOUT_PROVIDER };
const store = abandonmentStore;

async function process(eventId: string) {
  try {
    return await processAbandonmentEvent(eventId, { store, runner: prisma });
  } catch (error) {
    logger.error("Shiprocket Checkout abandonment webhook processing crashed", error);
    return "failed";
  }
}

// Deliveries are acknowledged as soon as they are RECORDED (one insert); saving happens afterwards. At most a few are saved at once in this process, so a burst cannot pile onto the
// database and push every save toward its timeout - the rest wait in memory and, if this process dies, are picked up from webhook_events by the retry worker.
const MAX_CONCURRENT_SAVES = 3;
let active = 0;
const waiting: string[] = [];
function pump(): void {
  while (active < MAX_CONCURRENT_SAVES && waiting.length > 0) {
    const id = waiting.shift()!;
    active++;
    void process(id).finally(() => {
      active--;
      pump();
    });
  }
}
function scheduleSave(id: string): void {
  waiting.push(id);
  setImmediate(pump);
}

const router = Router();

// Some webhook dashboards (Shiprocket Checkout's included, going by the 404s this endpoint logged
// on a plain GET during setup) ping the endpoint with a GET before/while saving the webhook config,
// to confirm it is reachable, and may refuse to actually start sending real events if that ping
// fails. This route never carries a delivery - POST is the only method Shiprocket Checkout's docs
// describe for the abandoned-cart payload itself.
router.get("/", (_req, res) => {
  res.status(200).json({ success: true, message: "Shiprocket Checkout abandonment webhook endpoint is reachable", data: null });
});

router.post("/", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleAbandonmentWebhook(
      { rawBody, headers: req.headers },
      { config: loadShiprocketAbandonmentWebhookConfig(), store, schedule: scheduleSave },
    );
    res.status(result.status).json({ success: result.status < 300, message: result.message, data: null });
  } catch (error) {
    // A 5xx makes the sender retry, which is what we want if the database is briefly unavailable.
    logger.error("Shiprocket Checkout abandonment webhook receive failed", error);
    res.status(500).json({ success: false, message: "Could not record webhook", data: null });
  }
});

export default router;

/** Starts the background retry loop, only when a webhook secret is configured. */
export function startAbandonmentWebhookWorker() {
  if (!loadShiprocketAbandonmentWebhookConfig()) return null;
  logger.info("Shiprocket Checkout abandonment webhook worker started");
  return startWebhookWorker({ store, process, onError: (e) => logger.error("Shiprocket Checkout abandonment webhook worker error", e) });
}

/**
 * Opt-in periodic recovery of stored deliveries that failed for good (ABANDONMENT_RECONCILE_MINUTES; unset or 0 = off, same convention as CASHFREE_RECONCILE_MINUTES). Bounded per pass
 * (ABANDONMENT_RECONCILE_HOURS window, default 48; ABANDONMENT_RECONCILE_BATCH, default 50), never auto-assigns, and only runs when the webhook is configured.
 */
export function startAbandonmentReconcileJob(env: Record<string, string | undefined> = globalThis.process.env) {
  const minutes = Number((env.ABANDONMENT_RECONCILE_MINUTES ?? "").trim());
  if (!Number.isFinite(minutes) || minutes <= 0 || !loadShiprocketAbandonmentWebhookConfig()) return null;
  const hours = Number((env.ABANDONMENT_RECONCILE_HOURS ?? "").trim()) || undefined;
  const limit = Number((env.ABANDONMENT_RECONCILE_BATCH ?? "").trim()) || undefined;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileFailedAbandonmentEvents({ db: prisma, runner: prisma, store, provider: SHIPROCKET_CHECKOUT_PROVIDER }, { sinceHours: hours, limit });
    } catch (error) {
      logger.error("Fastrr reconciliation pass failed", error);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void run(), 90_000);
  const timer = setInterval(() => void run(), minutes * 60_000);
  first.unref();
  timer.unref();
  logger.info(`Fastrr abandoned-cart reconciliation started (every ${minutes} min)`);
  return { tick: run, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

