import { asRecord, asString, ProviderHttpError, requestJson } from "../integrations/integrations.common.js";
import type { ShiprocketConfig } from "./shiprocket.config.js";

// Shiprocket's API token lifecycle. From Shiprocket's API helpsheet: POST /auth/login with the API user's email and
// password returns a token, valid for 240 hours (10 days), sent on every call as "Authorization: Bearer <token>".
//
//  - The token is cached in memory and renewed a day before it would expire.
//  - Concurrent callers share ONE login (single-flight), so a burst of requests never triggers a burst of logins.
//  - After a failed login the provider refuses to try again for a short while, so wrong credentials can not be
//    hammered against Shiprocket (which can lock the account).
//  - A 401 from any call invalidates the cached token; the client then logs in once more and retries that call.
//
// UNCONFIRMED until live credentials are available: whether a new login invalidates the previous token. If it does,
// running several backend instances would make them evict each other's tokens; the 401 retry above absorbs that.

export const TOKEN_LIFETIME_MS = 240 * 3_600_000;
export const RENEW_BEFORE_MS = 24 * 3_600_000;
export const LOGIN_FAILURE_COOLDOWN_MS = 30_000;

export class ShiprocketTokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;
  private failedUntil = 0;
  private lastFailure: ProviderHttpError | null = null;

  constructor(
    private readonly config: ShiprocketConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.token && this.now() < this.expiresAt - RENEW_BEFORE_MS) return this.token;
    if (this.inflight) return this.inflight;
    if (this.lastFailure && this.now() < this.failedUntil) throw this.lastFailure;

    this.inflight = this.login().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget a token Shiprocket rejected. Only the token that was actually rejected is dropped, so a fresh one is never discarded by a stale caller. */
  invalidate(rejected?: string): void {
    if (rejected === undefined || rejected === this.token) {
      this.token = null;
      this.expiresAt = 0;
    }
  }

  private async login(): Promise<string> {
    try {
      const { json } = await requestJson({
        provider: "SHIPROCKET",
        fetchImpl: this.fetchImpl,
        url: `${this.config.baseUrl}/auth/login`,
        method: "POST",
        headers: {},
        body: { email: this.config.email, password: this.config.password },
      });
      const token = asString(asRecord(json).token);
      if (!token) throw new ProviderHttpError("SHIPROCKET", null, "Shiprocket login did not return a token", false);
      this.token = token;
      this.expiresAt = this.now() + TOKEN_LIFETIME_MS;
      this.lastFailure = null;
      return token;
    } catch (error) {
      const failure = error instanceof ProviderHttpError ? error : new ProviderHttpError("SHIPROCKET", null, "Shiprocket login failed", true);
      this.lastFailure = failure;
      this.failedUntil = this.now() + LOGIN_FAILURE_COOLDOWN_MS;
      throw failure;
    }
  }
}

// One provider per credential set for the whole process, so every service instance shares one token.
const shared = new Map<string, ShiprocketTokenProvider>();

export function sharedTokenProvider(config: ShiprocketConfig): ShiprocketTokenProvider {
  const key = `${config.baseUrl}|${config.email}`;
  let provider = shared.get(key);
  if (!provider) {
    provider = new ShiprocketTokenProvider(config);
    shared.set(key, provider);
  }
  return provider;
}
