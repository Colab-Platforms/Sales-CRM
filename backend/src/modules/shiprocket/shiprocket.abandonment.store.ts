import { prisma } from "@/lib/prisma.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { ABANDONMENT_MAX_ATTEMPTS } from "./shiprocket.abandonment.processor.js";

export const SHIPROCKET_CHECKOUT_PROVIDER = "SHIPROCKET_CHECKOUT";

/** The one store for Fastrr abandon-cart deliveries: the shared webhook_events table, with this provider's longer retry ceiling. */
export const abandonmentStore = createPrismaWebhookStore(prisma, SHIPROCKET_CHECKOUT_PROVIDER, { maxAttempts: ABANDONMENT_MAX_ATTEMPTS });
