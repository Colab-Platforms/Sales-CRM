import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import routes from "./routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { notFoundHandler } from "./middlewares/notFoundHandler.js";
import sanitizeMiddleware from "./middlewares/sanitize.js";
import shopifyWebhookRoutes, { startShopifyWebhookWorker } from "./modules/shopify/shopify.webhook.routes.js";
import whatsappWebhookRoutes, { startWhatsAppWebhookWorker } from "./modules/whatsapp/whatsapp.webhook.routes.js";
import cashfreeWebhookRoutes, { startCashfreeWebhookWorker } from "./modules/cashfree/cashfree.webhook.routes.js";
import shiprocketWebhookRoutes, { startShiprocketWebhookWorker } from "./modules/shiprocket/shiprocket.webhook.routes.js";
import aisensyProjectWebhookRoutes, { startAiSensyProjectWebhookWorker } from "./modules/whatsapp/whatsapp.aisensy.webhook.routes.js";
import whatsappMetaWebhookRoutes, { startMetaWebhookWorker } from "./modules/whatsapp/whatsapp.meta.webhook.routes.js";
import legalRoutes from "./modules/legal/legal.routes.js";
import { startLifecycleAutomationScheduler } from "./modules/whatsapp/whatsapp.automation.scheduler.js";
import { startCampaignScheduler } from "./modules/whatsapp/whatsapp.campaign.scheduler.js";

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL?.replace(/\/$/, ""),
].filter(Boolean) as string[];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.log("Origin not allowed by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  }),
);
app.use(helmet());
app.use(compression());
// Shopify signs the exact bytes it sends, so this route reads the raw body. It must stay ahead of the JSON parser
// and the sanitizer, which would otherwise change what the signature is checked against.
app.use("/api/webhooks/shopify", express.raw({ type: "*/*", limit: "5mb" }), shopifyWebhookRoutes);
// AiSensy/Gupshup sign or token-authenticate the exact bytes they sent, same reason as Shopify above.
app.use("/api/webhooks/whatsapp", express.raw({ type: "*/*", limit: "5mb" }), whatsappWebhookRoutes);
// Cashfree signs the exact bytes it sends (re-serialised JSON would change decimal amounts and break the signature), and
// Shiprocket's body is recorded as received - both read the raw body, ahead of the JSON parser and the sanitizer.
app.use("/api/webhooks/cashfree", express.raw({ type: "*/*", limit: "5mb" }), cashfreeWebhookRoutes);
app.use("/api/webhooks/shiprocket", express.raw({ type: "*/*", limit: "5mb" }), shiprocketWebhookRoutes);
// AiSensy's separate "Project Webhook" feature (contact.*/message.*/payment.*/order.placed/
// lead_form.submitted) - distinct from /api/webhooks/whatsapp/aisensy above. No signature scheme is
// documented for it (see whatsapp.aisensy.webhook.config.ts), so this still reads the raw body only
// to support the CRM's own optional shared-token safeguard and exact-byte deduplication.
app.use("/api/webhooks/aisensy", express.raw({ type: "*/*", limit: "5mb" }), aisensyProjectWebhookRoutes);
// Official Meta WhatsApp Cloud API webhook - a distinct path from /api/webhooks/whatsapp/:provider
// above (that route's provider selection is synchronous/env-based; this one is DB-config-backed and
// async - see whatsapp.meta.webhook.routes.ts). Meta signs the exact bytes it sends, same reason as
// every other raw-body route here.
app.use("/api/webhooks/whatsapp-cloud", express.raw({ type: "*/*", limit: "5mb" }), whatsappMetaWebhookRoutes);

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.use(sanitizeMiddleware);

// Public legal pages required for Meta App publishing (HTML, no auth).
app.use(legalRoutes);

app.use("/api", routes);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  startShopifyWebhookWorker();
  startWhatsAppWebhookWorker();
  startCashfreeWebhookWorker();
  startShiprocketWebhookWorker();
  startAiSensyProjectWebhookWorker();
  startMetaWebhookWorker();
  startLifecycleAutomationScheduler();
  startCampaignScheduler();
});
