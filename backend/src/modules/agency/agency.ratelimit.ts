// Small in-memory sliding-window rate limiter. Per process: with several server instances each keeps its own window, so the real ceiling is (limit x instances) - the per-recipient cap and the
// idempotency rules, which live in the database, are what protect a customer. Entries are dropped as they age out, so memory stays bounded.
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Records one hit for `key` unless it is already at `limit` inside the window. */
  take(key: string, limit: number): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (fresh.length >= limit) {
      this.hits.set(key, fresh);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((fresh[0]! + this.windowMs - t) / 1000)) };
    }
    fresh.push(t);
    this.hits.set(key, fresh);
    if (this.hits.size > 10_000) this.sweep(t);
    return { allowed: true, remaining: limit - fresh.length, retryAfterSeconds: 0 };
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.every((h) => t - h >= this.windowMs)) this.hits.delete(k);
  }
}
