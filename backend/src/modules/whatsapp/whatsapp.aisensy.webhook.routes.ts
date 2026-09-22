import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { loadAiSensyProjectWebhookConfig } from "./whatsapp.aisensy.webhook.config.js";
import { handleAiSensyProjectWebhook } from "./whatsapp.aisensy.webhook.handler.js";

// Express wiring for POST /api/webhooks/aisensy - AiSensy's Project Webhook (contact.*, message.*,
// payment.*, order.placed, lead_form.submitted), NOT the same endpoint as the existing
// /api/webhooks/whatsapp/aisensy (that one is the Direct/Campaign webhook whatsapp.webhook.routes.ts
// already handles, with its own confirmed X-AiSensy-Signature verification and message/status
// parsing - untouched by this file). server.ts mounts this router with express.raw() before the
// JSON parser and the sanitizer, same convention as every other webhook group, so the exact bytes
// received are what gets hashed for deduplication.
//
// No background worker: every delivery is recorded and immediately marked IGNORED in the same
// request (see whatsapp.aisensy.webhook.handler.ts) - there is no asynchronous processing step to
// retry, unlike Shopify/Cashfree/Shiprocket/the Direct WhatsApp webhook.

export const AISENSY_PROJECT_WEBHOOK_PROVIDER = "AISENSY_PROJECT_WEBHOOK";
const store = createPrismaWebhookStore(prisma, AISENSY_PROJECT_WEBHOOK_PROVIDER);

const router = Router();

router.post("/", async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleAiSensyProjectWebhook(
      { rawBody, headers: req.headers, query: req.query as Record<string, unknown> },
      { config: loadAiSensyProjectWebhookConfig(), store },
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
