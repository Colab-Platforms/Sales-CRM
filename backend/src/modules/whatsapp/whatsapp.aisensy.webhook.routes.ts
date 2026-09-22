import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { startWebhookWorker } from "../shopify/shopify.webhook.worker.js";
import { loadAiSensyProjectWebhookConfig } from "./whatsapp.aisensy.webhook.config.js";
import { handleAiSensyProjectWebhook } from "./whatsapp.aisensy.webhook.handler.js";
import { processAiSensyProjectWebhookEvent } from "./whatsapp.aisensy.webhook.processor.js";

// Express wiring for POST /api/webhooks/aisensy - AiSensy's Project Webhook (contact.*, message.*,
// payment.*, order.placed, lead_form.submitted), NOT the same endpoint as the existing
// /api/webhooks/whatsapp/aisensy (that one is the Direct/Campaign webhook whatsapp.webhook.routes.ts
// already handles, with its own confirmed X-AiSensy-Signature verification and message/status
// parsing - untouched by this file). server.ts mounts this router with express.raw() before the
// JSON parser and the sanitizer, same convention as every other webhook group, so the exact bytes
// received are what gets hashed for deduplication.
//
// Every delivery is recorded synchronously; only message.status.updated (the one confirmed topic -
// see whatsapp.aisensy.webhook.handler.ts) is then scheduled for async processing, same
// record-then-process split as every other webhook module here.

export const AISENSY_PROJECT_WEBHOOK_PROVIDER = "AISENSY_PROJECT_WEBHOOK";
const store = createPrismaWebhookStore(prisma, AISENSY_PROJECT_WEBHOOK_PROVIDER);

async function process(eventId: string) {
  try {
    return await processAiSensyProjectWebhookEvent(eventId, { store, db: prisma });
  } catch (error) {
    logger.error("AiSensy Project Webhook processing crashed", error);
    return "failed";
  }
}

const router = Router();

router.post("/", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleAiSensyProjectWebhook(
      { rawBody, headers: req.headers, query: req.query as Record<string, unknown> },
      { config: loadAiSensyProjectWebhookConfig(), store, schedule: (id) => void setImmediate(() => void process(id)) },
    );
    res.status(result.status).json({ success: result.status < 300, message: result.message, data: null });
  } catch (error) {
    // A 5xx makes AiSensy retry (if it retries on failure at all - undocumented, but harmless to
    // assume so), which is what we want if the database is briefly unavailable.
    logger.error("AiSensy Project Webhook receive failed", error);
    res.status(500).json({ success: false, message: "Could not record webhook", data: null });
  }
});

export default router;

/** Starts the background retry loop for message.status.updated processing failures (e.g. a brief DB outage). */
export function startAiSensyProjectWebhookWorker() {
  logger.info("AiSensy Project Webhook worker started");
  return startWebhookWorker({ store, process, onError: (e) => logger.error("AiSensy Project Webhook worker error", e) });
}
