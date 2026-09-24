import { DOMAIN_PATTERN, type ShopifyWebhookConfig } from "./shopify.config.js";
import { bodyDigest, verifyHmac } from "./shopify.webhook.hmac.js";
import type { WebhookStore } from "./shopify.webhook.store.js";

// Receives one webhook delivery. It authenticates, records, and acknowledges; the actual sync happens afterwards
// (Shopify only allows a few seconds to reply). The payload is never trusted as the full record: processing
// re-fetches the current data from Shopify.

const ORDER_TOPICS = ["orders/create", "orders/updated", "orders/cancelled", "orders/paid", "orders/fulfilled"];
// These carry the order's id in `order_id`; they only signal that the order needs re-reading.
const ORDER_CHILD_TOPICS = ["fulfillments/create", "fulfillments/update", "refunds/create"];
const CUSTOMER_TOPICS = ["customers/create", "customers/update"];
const PRODUCT_TOPICS = ["products/create", "products/update"];

export const SUPPORTED_TOPICS = [...ORDER_TOPICS, ...ORDER_CHILD_TOPICS, ...CUSTOMER_TOPICS, ...PRODUCT_TOPICS];

export type Target = { kind: "order" | "customer" | "product"; id: string };

/** Which Shopify record a delivery is about, or null if the payload does not say. */
export function resolveTarget(topic: string, payload: unknown): Target | null {
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const idOf = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : null);

  if (ORDER_CHILD_TOPICS.includes(topic)) {
    const id = idOf(body.order_id);
    return id ? { kind: "order", id } : null;
  }
  const kind = ORDER_TOPICS.includes(topic) ? "order" : CUSTOMER_TOPICS.includes(topic) ? "customer" : PRODUCT_TOPICS.includes(topic) ? "product" : null;
  if (!kind) return null;
  const id = idOf(body.admin_graphql_api_id) ?? idOf(body.id);
  return id ? { kind, id } : null;
}

const header = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookResponse {
  status: number;
  message: string;
}

export interface HandlerDeps {
  /** null when webhooks are not configured. */
  config: ShopifyWebhookConfig | null;
  store: WebhookStore;
  /** Starts processing of a stored event in the background. */
  schedule: (eventId: string) => void;
}

export async function handleShopifyWebhook(req: WebhookRequest, deps: HandlerDeps): Promise<WebhookResponse> {
  const { config, store, schedule } = deps;
  if (!config) return { status: 503, message: "Shopify webhooks are not configured" };

  // 1. Authenticate against the raw bytes, before anything is parsed.
  if (!verifyHmac(req.rawBody, header(req.headers, "x-shopify-hmac-sha256"), config.secret)) {
    return { status: 401, message: "Invalid signature" };
  }
  // The signature already proves the delivery is from Shopify for this app. The shop header is only sanity-checked:
  // a store has several myshopify.com names (its original one and its current one), and Shopify sends whichever it
  // considers current, so it can not be compared for equality with the configured SHOPIFY_STORE_DOMAIN.
  const shop = header(req.headers, "x-shopify-shop-domain")?.trim().toLowerCase();
  if (!shop || !DOMAIN_PATTERN.test(shop)) return { status: 401, message: "Unexpected shop" };

  const topic = header(req.headers, "x-shopify-topic")?.trim();
  if (!topic) return { status: 400, message: "Missing topic" };

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody.toString("utf8"));
  } catch {
    return { status: 400, message: "Body is not valid JSON" };
  }

  // 2. Record it. The unique delivery id makes a repeat harmless.
  const deliveryId = header(req.headers, "x-shopify-webhook-id")?.trim() || bodyDigest(req.rawBody);
  const supported = SUPPORTED_TOPICS.includes(topic);
  const { id, duplicate } = await store.record({ eventType: topic, externalEventId: deliveryId, payload, ignored: !supported });
  if (duplicate) return { status: 200, message: "Duplicate delivery ignored" };
  if (!supported) return { status: 200, message: "Topic not handled" };

  // 3. Acknowledge now; process afterwards. With sync switched off the event stays recorded for later.
  if (config.syncEnabled) schedule(id);
  return { status: 200, message: "Received" };
}
