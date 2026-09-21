import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { startWebhookWorker } from "../shopify/shopify.webhook.worker.js";
import { loadShiprocketWebhookConfig } from "./shiprocket.config.js";
import { handleShiprocketWebhook } from "./shiprocket.webhook.handler.js";
import { processShiprocketEvent } from "./shiprocket.webhook.processor.js";

// Express wiring for POST /api/webhooks/shiprocket. server.ts mounts this router with express.raw() BEFORE the JSON
// parser and the sanitizer, so the body is recorded exactly as Shiprocket sent it.

export const SHIPROCKET_PROVIDER = "SHIPROCKET";
const store = createPrismaWebhookStore(prisma, SHIPROCKET_PROVIDER);

async function process(eventId: string) {
  try {
    return await processShiprocketEvent(eventId, { store, runner: prisma });
  } catch (error) {
    logger.error("Shiprocket webhook processing crashed", error);
    return "failed";
  }
}

const router = Router();

router.post("/", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleShiprocketWebhook({ rawBody, headers: req.headers }, { config: loadShiprocketWebhookConfig(), store, schedule: (id) => void setImmediate(() => void process(id)) });
    res.status(result.status).json({ success: result.status < 300, message: result.message, data: null });
  } catch (error) {
    // A 5xx makes Shiprocket retry, which is what we want if the database is briefly unavailable.
    logger.error("Shiprocket webhook receive failed", error);
    res.status(500).json({ success: false, message: "Could not record webhook", data: null });
  }
});

export default router;

/** Starts the background retry loop, only when Shiprocket is enabled and has a webhook token. */
export function startShiprocketWebhookWorker() {
  if (!loadShiprocketWebhookConfig()) return null;
  logger.info("Shiprocket webhook worker started");
  return startWebhookWorker({ store, process, onError: (e) => logger.error("Shiprocket webhook worker error", e) });
}
