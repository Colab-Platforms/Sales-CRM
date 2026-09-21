import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource } from "../../../generated/prisma/enums.js";
import { ShopifyClient } from "./shopify.client.js";
import { loadShopifyConfig, loadWebhookConfig } from "./shopify.config.js";
import { checkConnection } from "./shopify.orders.js";
import { syncCustomerById, syncOrderById, syncProductById, type SyncDeps } from "./shopify.sync.js";
import { isValidTimeZone, startFloor } from "./shopify.window.js";
import { handleShopifyWebhook } from "./shopify.webhook.handler.js";
import { processWebhookEvent } from "./shopify.webhook.processor.js";
import { createPrismaWebhookStore } from "./shopify.webhook.store.js";
import { startWebhookWorker } from "./shopify.webhook.worker.js";

// Express wiring for POST /api/webhooks/shopify. server.ts mounts this router with express.raw() BEFORE the JSON
// parser and the sanitizer, so the signature is checked against the exact bytes Shopify sent.

const store = createPrismaWebhookStore(prisma);

// Built per event so the current environment is always used, and a misconfiguration surfaces as a recorded failure.
const syncDeps = (): SyncDeps => ({ client: new ShopifyClient(loadShopifyConfig()), runner: prisma });

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
