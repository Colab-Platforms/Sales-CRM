import { logger } from "@/utils/logger.js";
import { sweepNewUnassigned } from "./abandonment.pool.service.js";

// Retry for the 24/7 pool: every few minutes, leads that arrived after the pool was switched on and still have no owner (a failed or skipped assignment) are given one. Does nothing while the pool is off
// (no state row / disabled) and never touches the older backlog. Idempotent and safe across instances: each assignment locks the pool row and skips an owned lead.
const TICK_MS = 5 * 60_000;
let running = false;

export async function abandonedPoolTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await sweepNewUnassigned();
    if (r && r.considered > 0) logger.info(`abandoned_pool sweep considered=${r.considered} assigned=${r.assigned} skipped=${r.skipped} failed=${r.failed}`);
  } catch (error) {
    logger.warn(`abandoned_pool sweep_failed reason=${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
  } finally {
    running = false;
  }
}

export function startAbandonedPoolSweep(): NodeJS.Timeout {
  const timer = setInterval(() => void abandonedPoolTick(), TICK_MS);
  timer.unref?.();
  return timer;
}
