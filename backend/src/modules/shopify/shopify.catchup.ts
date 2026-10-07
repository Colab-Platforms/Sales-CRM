import type { SyncOptions, SyncReport } from "./shopify.sync.js";

// A periodic catch-up for Shopify orders, so an order whose webhook was missed, failed for good, or arrived while processing was off does not stay
// "live-only" (no CRM Order, no payment, no refund) until somebody runs the sync command by hand. It is the same incremental sync the command already offers
// (`shopify:sync --updated-since`): orders changed in Shopify within the look-back are walked by update time and each one is upserted through the same
// idempotent path webhooks use, skipping every order whose stored version is already current - so repeating it is cheap and can never duplicate an order.
//
// This file holds the pure parts (config, window, the overlap-safe pass); the timer is started from shopify.webhook.routes.ts, the one place that may open the
// database. It runs only when SHOPIFY_SYNC_ENABLED=true (the existing switch for Shopify -> CRM syncing), so with sync off nothing here runs.
//   SHOPIFY_SYNC_POLL_MINUTES        how often (default 15; 0 switches the catch-up off while webhooks stay on)
//   SHOPIFY_SYNC_POLL_LOOKBACK_HOURS how far back "changed in Shopify" reaches each run (default 24)

export interface CatchUpConfig {
  intervalMinutes: number;
  lookbackHours: number;
}

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS = 24 * 14;

/** null when the catch-up is off: sync not enabled, or an interval of 0. A malformed number falls back to the default rather than switching anything on/off silently. */
export function loadCatchUpConfig(env: Record<string, string | undefined> = process.env): CatchUpConfig | null {
  if ((env.SHOPIFY_SYNC_ENABLED ?? "false").trim().toLowerCase() !== "true") return null;
  const number = (value: string | undefined, fallback: number) => {
    const n = Number((value ?? "").trim());
    return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const intervalMinutes = number(env.SHOPIFY_SYNC_POLL_MINUTES, DEFAULT_INTERVAL_MINUTES);
  if (intervalMinutes === 0) return null;
  const lookbackHours = Math.min(Math.max(number(env.SHOPIFY_SYNC_POLL_LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS), 1), MAX_LOOKBACK_HOURS);
  return { intervalMinutes: Math.max(intervalMinutes, 1), lookbackHours };
}

/** The options of one catch-up run: orders only, changed since `now - lookback`, never forced (unchanged orders are skipped without being fetched). */
export function catchUpOptions(config: CatchUpConfig, now: Date): SyncOptions {
  return {
    limit: null,
    window: { from: null, to: null, updatedSince: { kind: "instant", at: new Date(now.getTime() - config.lookbackHours * 3_600_000) } },
    only: ["orders"],
    force: false,
    dryRun: false,
  };
}

export interface CatchUpDeps {
  config: CatchUpConfig;
  run: (options: SyncOptions) => Promise<SyncReport>;
  now?: () => Date;
  onResult?: (report: SyncReport) => void;
  onError?: (error: unknown) => void;
}

/** One pass. Never throws; a problem is reported through onError and the next pass tries again. */
export function createCatchUp({ config, run, now = () => new Date(), onResult, onError }: CatchUpDeps) {
  let running = false;
  const tick = async (): Promise<boolean> => {
    if (running) return false; // a slow run is never overlapped by the next timer tick
    running = true;
    try {
      const report = await run(catchUpOptions(config, now()));
      if (report.error) onError?.(report.error);
      else onResult?.(report);
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
    }
    return true;
  };
  return { tick };
}
