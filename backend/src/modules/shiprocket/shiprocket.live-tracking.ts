import { ShiprocketClient, type TrackingResult } from "./shiprocket.client.js";
import { loadShiprocketConfig, ShiprocketConfigError } from "./shiprocket.config.js";

// A pure, read-only "what does Shiprocket say right now" lookup - unlike refreshTracking() in
// shiprocket.shipments.service.ts, this never writes back to the CRM's own Shipment row. It exists
// so Shipments/Order Detail/Customer 360 can show a live status alongside the CRM's own record
// without turning every page view into a write. Reuses the same ShiprocketClient (and its shared,
// cached token provider) - no second client/auth implementation.
export interface LiveTrackingResult {
  tracking: TrackingResult | null;
  error?: string;
}

interface CacheEntry {
  value: LiveTrackingResult;
  expiresAt: number;
}

// Same in-process TTL Map idiom as orders.live.service.ts. Not RBAC-sensitive (tracking status isn't
// tied to who's asking), so the cache key is just the AWB. A short TTL keeps repeated page views/
// refreshes from hammering Shiprocket while still surfacing a status change within a minute.
const TRACKING_CACHE_TTL_MS = 60_000;
const trackingCache = new Map<string, CacheEntry>();

let sharedClient: ShiprocketClient | null = null;
function getClient(): ShiprocketClient {
  if (!sharedClient) sharedClient = new ShiprocketClient(loadShiprocketConfig());
  return sharedClient;
}

/** Live tracking for one AWB, cached briefly. Never throws - a disabled/misconfigured/unreachable
 *  Shiprocket, or an AWB it doesn't recognise, is reported via `error`/`tracking: null`. */
export async function getLiveTracking(awb: string): Promise<LiveTrackingResult> {
  const cached = trackingCache.get(awb);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let result: LiveTrackingResult;
  try {
    const tracking = await getClient().track(awb);
    result = { tracking };
  } catch (error) {
    result = {
      tracking: null,
      error: error instanceof ShiprocketConfigError ? "Shiprocket is not configured" : "Could not reach Shiprocket for live tracking",
    };
  }

  trackingCache.set(awb, { value: result, expiresAt: Date.now() + TRACKING_CACHE_TTL_MS });
  return result;
}

/** Fetches live tracking for several AWBs in parallel (bounded by the caller's own page size - this
 *  never fetches more than the AWBs it's given). Failures are isolated per-AWB via getLiveTracking's
 *  own try/catch, so one bad/unreachable lookup never affects the others. */
export async function getLiveTrackingBatch(awbs: string[]): Promise<Map<string, LiveTrackingResult>> {
  const unique = [...new Set(awbs)];
  const results = await Promise.all(unique.map(async (awb) => [awb, await getLiveTracking(awb)] as const));
  return new Map(results);
}
