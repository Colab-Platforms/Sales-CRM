import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import routes from "./routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { notFoundHandler } from "./middlewares/notFoundHandler.js";
import sanitizeMiddleware from "./middlewares/sanitize.js";
import shopifyWebhookRoutes, { startShopifyWebhookWorker } from "./modules/shopify/shopify.webhook.routes.js";

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

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.use(sanitizeMiddleware);

app.use("/api", routes);

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  startShopifyWebhookWorker();
});
