import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { startWebhookWorker } from "../shopify/shopify.webhook.worker.js";
import { loadCashfreeWebhookConfig } from "./cashfree.config.js";
import { handleCashfreeWebhook } from "./cashfree.webhook.handler.js";
import { processCashfreeEvent } from "./cashfree.webhook.processor.js";

// Express wiring for POST /api/webhooks/cashfree. server.ts mounts this router with express.raw() BEFORE the JSON parser
// and the sanitizer, so the signature is checked against the exact bytes Cashfree sent.

export const CASHFREE_PROVIDER = "CASHFREE";
const store = createPrismaWebhookStore(prisma, CASHFREE_PROVIDER);

async function process(eventId: string) {
  try {
    return await processCashfreeEvent(eventId, { store, runner: prisma });
  } catch (error) {
    logger.error("Cashfree webhook processing crashed", error);
    return "failed";
  }
}

const router = Router();

router.post("/", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleCashfreeWebhook({ rawBody, headers: req.headers }, { config: loadCashfreeWebhookConfig(), store, schedule: (id) => void setImmediate(() => void process(id)) });
    res.status(result.status).json({ success: result.status < 300, message: result.message, data: null });
  } catch (error) {
    // A 5xx makes Cashfree retry, which is what we want if the database is briefly unavailable.
    logger.error("Cashfree webhook receive failed", error);
    res.status(500).json({ success: false, message: "Could not record webhook", data: null });
  }
});

export default router;

/** Starts the background retry loop, only when Cashfree is enabled and has a secret. */
export function startCashfreeWebhookWorker() {
  if (!loadCashfreeWebhookConfig()) return null;
  logger.info("Cashfree webhook worker started");
  return startWebhookWorker({ store, process, onError: (e) => logger.error("Cashfree webhook worker error", e) });
}
