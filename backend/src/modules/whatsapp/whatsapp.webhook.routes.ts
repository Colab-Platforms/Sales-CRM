import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import WhatsAppService from "./whatsapp.service.js";
import { getWhatsAppProvider } from "./whatsapp.factory.js";
import type { WhatsAppProvider, WhatsAppProviderId } from "./whatsapp.provider.js";
import { handleWhatsAppWebhook } from "./whatsapp.webhook.handler.js";
import { processWhatsAppWebhookEvent } from "./whatsapp.webhook.processor.js";
import { createWhatsAppWebhookStore } from "./whatsapp.webhook.store.js";
import { startWebhookWorker } from "./whatsapp.webhook.worker.js";

// Express wiring for POST /api/webhooks/whatsapp/:provider. server.ts mounts this router with
// express.raw() BEFORE the JSON parser and the sanitizer, so signatures/tokens are checked against
// the exact bytes the provider sent - same convention as the Shopify webhook route.

const service = new WhatsAppService();

/** The currently-configured provider, only if its id matches the URL's :provider segment. */
function activeProviderFor(param: string): WhatsAppProvider | null {
  const provider = getWhatsAppProvider();
  if (!provider) return null;
  return provider.id === param.trim().toUpperCase() ? provider : null;
}

async function process(providerId: WhatsAppProviderId, eventId: string) {
  const provider = getWhatsAppProvider();
  if (!provider || provider.id !== providerId) return "skipped"; // config changed/removed since the delivery arrived
  const store = createWhatsAppWebhookStore(prisma, providerId);
  try {
    return await processWhatsAppWebhookEvent(eventId, {
      store,
      provider,
      persist: {
        message: (m) => service.recordInboundMessage(providerId, m),
        status: (s) => service.recordStatusUpdate(providerId, s),
      },
    });
  } catch (error) {
    logger.error("WhatsApp webhook processing crashed", error);
    return "failed";
  }
}

const router = Router();

router.post("/:provider", async (req, res) => {
  try {
    const provider = activeProviderFor(req.params.provider);
    // A store is still needed to record (and thus 200-ack) a delivery for a provider that is not
    // currently active, so a stale/misdirected delivery does not loop-retry forever on the sender's
    // side; it is simply never processed. AISENSY is an arbitrary, harmless default provider tag
    // for that not-configured case - handleWhatsAppWebhook returns 503 before the store is ever
    // written to when provider is null, so nothing is actually recorded under it.
    const store = createWhatsAppWebhookStore(prisma, provider?.id ?? "AISENSY");

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await handleWhatsAppWebhook(
      { rawBody, headers: req.headers },
      { provider, store, schedule: (id) => void setImmediate(() => void process(provider!.id, id)) },
    );
    res.status(result.status).json({ success: result.status < 300, message: result.message, data: null });
  } catch (error) {
    // A 5xx makes the provider retry the delivery, which is what we want if the database is briefly unavailable.
    logger.error("WhatsApp webhook receive failed", error);
    res.status(500).json({ success: false, message: "Could not record webhook", data: null });
  }
});

export default router;

/** Starts the background retry loop for the currently-configured provider, if any. */
export function startWhatsAppWebhookWorker() {
  const provider = getWhatsAppProvider();
  if (!provider) return null;
  const store = createWhatsAppWebhookStore(prisma, provider.id);
  logger.info(`WhatsApp webhook worker started (${provider.id})`);
  return startWebhookWorker({ store, process: (id) => process(provider.id, id), onError: (e) => logger.error("WhatsApp webhook worker error", e) });
}
