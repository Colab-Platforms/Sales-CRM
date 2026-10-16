import { ShopifyApiError } from "./shopify.client.js";

/** A short, safe explanation of a failed Shopify call: never a token, a URL with credentials, or a response body. */
export function sanitizeSyncError(error: unknown): string {
  const raw = error instanceof ShopifyApiError || error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/(authorization|token|secret|password)\s*[:=]?\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

/** What the person looking at a partial sync should do next. Customer problems need a human decision; missing address/metadata/tags can be re-synced. */
export function syncAdvice(missing: string[], degraded: string[]): "NONE" | "RETRY" | "ADMIN" {
  if (missing.length === 0 && degraded.length === 0) return "NONE";
  if (degraded.some((d) => d.startsWith("customer"))) return "ADMIN";
  if (missing.some((m) => m.startsWith("lineItems.requiresShipping"))) return "ADMIN"; // Shopify cannot change this on an existing order
  return "RETRY";
}
