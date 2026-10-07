import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource } from "../../../generated/prisma/enums.js";
import { ShopifyClient } from "./shopify.client.js";
import { loadShopifyConfig, loadWebhookConfig } from "./shopify.config.js";
import { checkConnection } from "./shopify.orders.js";
import { runSync, syncCustomerById, syncOrderById, syncProductById, type SyncDeps } from "./shopify.sync.js";
import { createCatchUp, loadCatchUpConfig } from "./shopify.catchup.js";
import { createCashfreeAutoVerifyHook } from "../refunds/refunds.autoverify.js";
import { isValidTimeZone, startFloor } from "./shopify.window.js";
import { handleShopifyWebhook } from "./shopify.webhook.handler.js";
import { processWebhookEvent } from "./shopify.webhook.processor.js";
import { createPrismaWebhookStore } from "./shopify.webhook.store.js";
import { startWebhookWorker } from "./shopify.webhook.worker.js";

// Express wiring for POST /api/webhooks/shopify. server.ts mounts this router with express.raw() BEFORE the JSON
// parser and the sanitizer, so the signature is checked against the exact bytes Shopify sent.

const store = createPrismaWebhookStore(prisma);

// Built per event so the current environment is always used, and a misconfiguration surfaces as a recorded failure.
const syncDeps = (): SyncDeps => {
  const client = new ShopifyClient(loadShopifyConfig());
  return { client, runner: prisma, afterCommit: createCashfreeAutoVerifyHook(client, prisma) };
};

// The CRM keeps orders from SHOPIFY_SYNC_START_DATE onwards. Editing an old order in Shopify must not pull it in, so
// webhook processing ignores anything created before that day. The store's time zone (one query, then remembered)
// decides where the day starts.
let floor: Promise<Date> | null = null;
const syncFloor = () =>
  (floor ??= (async () => {
    const config = loadShopifyConfig();
    const { timeZone } = await checkConnection(new ShopifyClient(config));
    return startFloor(config.syncStartDate, timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC");
  })().catch((error) => {
    floor = null;
    throw error;
  }));

async function process(eventId: string) {
  try {
    // "notFound" below also means "deliberately not imported" (older than the start date): either way the event is ignored.
    return await processWebhookEvent(eventId, {
      store,
      sync: {
        order: async (id) => {
          const outcome = await syncOrderById(syncDeps(), id, { notBefore: await syncFloor(), source: ActivitySource.SHOPIFY_WEBHOOK });
          return { notFound: outcome.notFound || outcome.outOfWindow };
        },
        product: (id) => syncProductById(syncDeps(), id),
        customer: async (id) => {
          const outcome = await syncCustomerById(syncDeps(), id, { notBefore: await syncFloor() });
          return { notFound: outcome.notFound || outcome.result === null };
        },
      },
    });
  } catch (error) {
    // The processor records its own failures; this only catches problems talking to the database itself.
    logger.error("Shopify webhook processing crashed", error);
    return "failed";
  }
}

const router = Router();

router.post("/", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleShopifyWebhook(
      { rawBody, headers: req.headers },
      { config: loadWebhookConfig(), store, schedule: (id) => void setImmediate(() => void process(id)) },
    );
    res.status(result.status).json({ success: result.status < 300, message: result.message, data: null });
  } catch (error) {
    // A 5xx makes Shopify retry the delivery, which is what we want if the database is briefly unavailable.
    logger.error("Shopify webhook receive failed", error);
    res.status(500).json({ success: false, message: "Could not record webhook", data: null });
  }
});

export default router;

/** Starts the background retry loop, but only when webhooks are configured and sync is switched on. */
export function startShopifyWebhookWorker() {
  const config = loadWebhookConfig();
  if (!config?.syncEnabled) return null;
  logger.info("Shopify webhook worker started");
  return startWebhookWorker({ store, process, onError: (e) => logger.error("Shopify webhook worker error", e) });
}

/**
 * Starts the periodic catch-up (see shopify.catchup.ts) so an order whose webhook was missed or failed still becomes a CRM order. Only when
 * SHOPIFY_SYNC_ENABLED=true and the interval is not 0; otherwise nothing runs.
 */
export function startShopifyCatchUp() {
  const config = loadCatchUpConfig();
  if (!config) return null;
  const runner = createCatchUp({
    config,
    run: (options) => {
      const shopify = loadShopifyConfig();
      const client = new ShopifyClient(shopify);
      return runSync({ client, runner: prisma, defaultStart: shopify.syncStartDate, afterCommit: createCashfreeAutoVerifyHook(client, prisma) }, options);
    },
    onResult: (report) => {
      const c = report.counts.orders;
      if (c.created + c.updated + c.failed > 0) logger.info(`Shopify catch-up: ${c.created} created, ${c.updated} updated, ${c.failed} failed`);
    },
    onError: (error) => logger.error("Shopify catch-up failed", error),
  });
  // First pass shortly after start (picks up what was missed while the server was down), then on the interval.
  const first = setTimeout(() => void runner.tick(), 60_000);
  const timer = setInterval(() => void runner.tick(), config.intervalMinutes * 60_000);
  first.unref();
  timer.unref();
  logger.info(`Shopify catch-up started (every ${config.intervalMinutes} min, look-back ${config.lookbackHours} h)`);
  return { tick: runner.tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}
