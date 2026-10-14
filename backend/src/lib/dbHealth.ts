import { classifyDatabaseError } from "@/utils/databaseErrors.js";

// Readiness probe for GET /api/health/db. /api/health stays a plain liveness check on purpose: a monitor that pinged the database every few minutes would keep a scale-to-zero Neon
// compute awake around the clock and burn the compute-hours quota. This one is for a person (or a deploy check) to confirm the database is reachable - and, on a suspended Neon
// compute, a successful call is also what wakes it.

export interface DatabaseHealth {
  ok: boolean;
  /** Round trip in ms, including any compute wake-up. */
  ms: number;
  /** Present only when not ok. Never the raw error. */
  reason?: "quota" | "unavailable" | "timeout";
}

export const DB_HEALTH_TIMEOUT_MS = 20_000;

export async function checkDatabase(db: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }, timeoutMs: number = DB_HEALTH_TIMEOUT_MS): Promise<DatabaseHealth> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("ETIMEDOUT: timed out waiting for the database"), { code: "ETIMEDOUT" })), timeoutMs);
      }),
    ]);
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, reason: classifyDatabaseError(error)?.kind ?? "unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The last result is reused for this long, and concurrent callers share one in-flight query, so repeated calls cannot each reach (and keep awake) the database. */
export const DB_HEALTH_CACHE_MS = 30_000;

export function createCachedDatabaseCheck(db: Parameters<typeof checkDatabase>[0], { ttlMs = DB_HEALTH_CACHE_MS, timeoutMs = DB_HEALTH_TIMEOUT_MS, now = () => Date.now() } = {}) {
  let last: { at: number; health: DatabaseHealth } | null = null;
  let inflight: Promise<DatabaseHealth> | null = null;
  return async (): Promise<DatabaseHealth & { cached: boolean }> => {
    if (last && now() - last.at < ttlMs) return { ...last.health, cached: true };
    inflight ??= checkDatabase(db, timeoutMs)
      .then((health) => ((last = { at: now(), health }), health))
      .finally(() => { inflight = null; });
    return { ...(await inflight), cached: false };
  };
}
