import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { startWebhookWorker } from "../shopify/shopify.webhook.worker.js";
import { loadShiprocketAbandonmentWebhookConfig } from "./shiprocket.abandonment.config.js";
import { handleAbandonmentWebhook } from "./shiprocket.abandonment.webhook.handler.js";
import { processAbandonmentEvent } from "./shiprocket.abandonment.processor.js";

// Express wiring for POST /api/webhooks/shiprocket/abandoned-cart. server.ts mounts this router with
// express.raw() before the JSON parser and the sanitizer, same reason as every other webhook route.

export const SHIPROCKET_CHECKOUT_PROVIDER = "SHIPROCKET_CHECKOUT";
const store = createPrismaWebhookStore(prisma, SHIPROCKET_CHECKOUT_PROVIDER);

async function process(eventId: string) {
  try {
    return await processAbandonmentEvent(eventId, { store, runner: prisma });
  } catch (error) {
    logger.error("Shiprocket Checkout abandonment webhook processing crashed", error);
    return "failed";
  }
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
      { config: loadShiprocketAbandonmentWebhookConfig(), store, schedule: (id) => void setImmediate(() => void process(id)) },
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
