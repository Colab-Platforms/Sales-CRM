import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { startWebhookWorker } from "../shopify/shopify.webhook.worker.js";
import { isCashfreeEnabled, loadCashfreeConfig, loadCashfreeWebhookConfig } from "./cashfree.config.js";
import { CashfreeClient } from "./cashfree.client.js";
import CashfreePaymentsService from "./cashfree.payments.service.js";
import { createCashfreeReconciler, loadReconcileMinutes } from "./cashfree.catchup.js";
import { handleCashfreeWebhook } from "./cashfree.webhook.handler.js";
import { processCashfreeEvent } from "./cashfree.webhook.processor.js";

// Express wiring for POST /api/webhooks/cashfree. server.ts mounts this router with express.raw() BEFORE the JSON parser
// and the sanitizer, so the signature is checked against the exact bytes Cashfree sent.

export const CASHFREE_PROVIDER = "CASHFREE";
const store = createPrismaWebhookStore(prisma, CASHFREE_PROVIDER);

async function process(eventId: string) {
  try {
    return await processCashfreeEvent(eventId, { store, runner: prisma, verifyLink: (linkId) => new CashfreeClient(loadCashfreeConfig()).getLink(linkId) });
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

/** Starts the reconciliation of open payment links (missed webhooks). Only when Cashfree is enabled and fully configured. */
export function startCashfreeReconciler() {
  const minutes = loadReconcileMinutes();
  if (minutes === 0 || !isCashfreeEnabled()) return null;
  try {
    loadCashfreeConfig();
  } catch {
    return null;
  }
  const service = new CashfreePaymentsService(prisma);
  const runner = createCashfreeReconciler({
    runner: prisma,
    reconcile: (id) => service.reconcileOpenPayment(id),
    onError: (e) => logger.error("Cashfree reconciliation error", e),
  });
  const run = async () => {
    const pass = await runner.tick();
    if (pass && pass.updated > 0) logger.info(`Cashfree reconciliation: ${pass.updated} of ${pass.checked} open payments updated`);
  };
  const first = setTimeout(() => void run(), 45_000);
  const timer = setInterval(() => void run(), minutes * 60_000);
  first.unref();
  timer.unref();
  logger.info(`Cashfree reconciliation started (every ${minutes} min)`);
  return { tick: run, stop: () => { clearTimeout(first); clearInterval(timer); } };
}
