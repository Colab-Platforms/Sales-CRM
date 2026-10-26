import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { countRecords } from "../shopify/shopify.orders.js";

// How many orders Shopify itself says exist in a period. The Website Orders dashboard compares this with what the CRM holds, so a period the CRM only partly imported is reported as incomplete instead of being
// shown as a (wrong) smaller number or a (wrong) zero. READ-ONLY: one cheap `ordersCount` GraphQL query per period (nothing is downloaded, nothing is written), cached for a few minutes. When Shopify is not
// configured or does not answer the result is null = "could not verify", and the dashboard then never claims the period is complete.

export type ShopifyOrderCounter = (from: Date, to: Date) => Promise<number | null>;

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 30_000;

export function createShopifyOrderCounter(env: Record<string, string | undefined> = process.env, nowMs: () => number = () => Date.now()): ShopifyOrderCounter {
  let client: ShopifyClient | null | undefined;
  const cache = new Map<string, { at: number; ttl: number; value: number | null }>();
  return async (from, to) => {
    const key = `${from.toISOString()}|${to.toISOString()}`;
    const hit = cache.get(key);
    if (hit && nowMs() - hit.at < hit.ttl) return hit.value;
    let value: number | null = null;
    try {
      if (client === undefined) {
        try {
          client = new ShopifyClient(loadShopifyConfig(env));
        } catch {
          client = null; // Shopify is not configured in this environment
        }
      }
      if (client) {
        const r = await countRecords(client, "orders", `created_at:>='${from.toISOString()}' created_at:<'${to.toISOString()}'`);
        value = r.exact ? r.count : null;
      }
    } catch {
      value = null;
    }
    cache.set(key, { at: nowMs(), ttl: value === null ? FAIL_TTL_MS : OK_TTL_MS, value });
    return value;
  };
}

/** Process-wide counter, so the cache is shared by every request. */
export const defaultShopifyOrderCounter: ShopifyOrderCounter = createShopifyOrderCounter();
