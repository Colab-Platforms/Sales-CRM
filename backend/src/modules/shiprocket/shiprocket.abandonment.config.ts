// Config for the Shiprocket Checkout (formerly Fastrr) "Abandon Cart" webhook. Distinct from
// shiprocket.config.ts (the AWB/tracking API + its own webhook), because Shiprocket Checkout is a
// separate product with its own dashboard (Settings > Webhooks) and its own auth: the dashboard UI
// only offers a free-form "Headers" field, so a shared-secret header is the whole auth story here -
// there is no HMAC signature scheme to verify against, unlike Shopify.

type Env = Record<string, string | undefined>;

/** What the webhook endpoint needs. null when not configured - every delivery is then refused. */
export function loadShiprocketAbandonmentWebhookConfig(env: Env = process.env): { readonly secret: string } | null {
  const secret = (env.SHIPROCKET_CHECKOUT_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return null;
  const config = {} as { secret: string };
  Object.defineProperty(config, "secret", { value: secret, enumerable: false, writable: false });
  return config;
}
