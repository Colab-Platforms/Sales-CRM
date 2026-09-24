import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import WhatsAppService from "./whatsapp.service.js";
import { resolveMetaWebhookChallenge } from "./whatsapp.hmac.js";
import { getActiveVerifyToken, getMetaWhatsAppProvider } from "./whatsapp.meta.factory.js";
import { handleWhatsAppWebhook } from "./whatsapp.webhook.handler.js";
import { processWhatsAppWebhookEvent } from "./whatsapp.webhook.processor.js";
import { createWhatsAppWebhookStore } from "./whatsapp.webhook.store.js";
import { startWebhookWorker } from "./whatsapp.webhook.worker.js";

// Express wiring for the official Meta WhatsApp Cloud API webhook, mounted in server.ts at its own
// path ("/api/webhooks/whatsapp-cloud") - deliberately NOT under "/api/webhooks/whatsapp/:provider"
// (whatsapp.webhook.routes.ts), which selects its single active provider synchronously from env
// vars (whatsapp.factory.ts). Meta's config is DB-stored and looked up async (whatsapp.meta.factory.ts),
// so this stays a fully separate route: the existing AiSensy/Gupshup path has zero lines changed.
//
// POST reuses the existing, already provider-agnostic handleWhatsAppWebhook /
// processWhatsAppWebhookEvent / createWhatsAppWebhookStore("META") - no changes needed there.

const service = new WhatsAppService();

async function process(eventId: string) {
  const provider = await getMetaWhatsAppProvider();
  if (!provider) return "skipped"; // config changed/removed/undecryptable since the delivery arrived
  const store = createWhatsAppWebhookStore(prisma, "META");
  try {
    return await processWhatsAppWebhookEvent(eventId, {
      store,
      provider,
      persist: {
        message: (m) => service.recordInboundMessage("META", m),
        status: (s) => service.recordStatusUpdate("META", s),
      },
    });
  } catch (error) {
    logger.error("Meta WhatsApp Cloud API webhook processing crashed", error);
    return "failed";
  }
}

const router = Router();

// Meta's one-time verification handshake, sent whenever the webhook callback URL/verify token is
// (re)configured in the Meta App dashboard - GET with hub.mode=subscribe, hub.verify_token,
// hub.challenge. The raw challenge string is echoed back only when the token matches; a wrong or
// missing token is a plain 403, never a hint about why.
router.get("/", async (req, res) => {
  try {
    const verifyToken = await getActiveVerifyToken();
    const challenge = resolveMetaWebhookChallenge(
      { mode: req.query["hub.mode"], verifyToken: req.query["hub.verify_token"], challenge: req.query["hub.challenge"] },
      verifyToken,
    );
    if (!challenge) {
      res.status(403).send("Verification failed");
      return;
    }

    await prisma.activity.create({
      data: {
        type: ActivityType.WHATSAPP_CLOUD_CONFIG_WEBHOOK_VERIFIED,
        referenceType: "WhatsAppConfig",
        source: ActivitySource.WHATSAPP_CLOUD_WEBHOOK,
        title: "WhatsApp Cloud API webhook verified",
        description: "Meta's GET verification handshake succeeded",
      },
    });
    res.status(200).send(challenge);
  } catch (error) {
    logger.error("WhatsApp Cloud API webhook verification failed", error);
    res.status(403).send("Verification failed");
  }
});

router.post("/", async (req, res) => {
  try {
    const provider = await getMetaWhatsAppProvider();
    // Still record (and 200-ack) a delivery even if config was removed/misconfigured since it was
    // sent, so Meta does not retry/disable the subscription forever - see whatsapp.webhook.routes.ts's
    // identical rationale for AiSensy/Gupshup.
    const store = createWhatsAppWebhookStore(prisma, "META");

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleWhatsAppWebhook(
      { rawBody, headers: req.headers },
      { provider, store, schedule: (id) => void setImmediate(() => void process(id)) },
    );
    res.status(result.status).json({ success: result.status < 300, message: result.message, data: null });
  } catch (error) {
    logger.error("WhatsApp Cloud API webhook receive failed", error);
    res.status(500).json({ success: false, message: "Could not record webhook", data: null });
  }
});

export default router;

/** Starts the background retry loop for the Meta webhook, if a config is currently active. */
export function startMetaWebhookWorker() {
  const store = createWhatsAppWebhookStore(prisma, "META");
  logger.info("WhatsApp Cloud API (Meta) webhook worker started");
  return startWebhookWorker({ store, process, onError: (e) => logger.error("WhatsApp Cloud API webhook worker error", e) });
}
