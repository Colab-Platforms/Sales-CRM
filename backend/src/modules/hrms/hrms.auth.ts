import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "@/utils/logger.js";
import { SlidingWindowLimiter } from "../agency/agency.ratelimit.js";

// AUTHENTICATION OF THE HRMS REPORTING API (/api/hrms/v1). One shared secret, HRMS_INTEGRATION_API_KEY, sent as the X-HRMS-Key header. It is NOT a CRM user login and carries no CRM role: it can only reach this
// read-only API. The order of the checks is deliberate:
//   1. integration key not configured (unset / blank / too short to be a real secret)  -> 503, for every request: an unset key can never let anything through;
//   2. any method other than GET (HEAD and OPTIONS included)                          -> 405;
//   3. key missing or wrong (compared in constant time)                                -> 401 (429 once one address keeps failing);
//   4. key right, but this caller is over its per-minute allowance                     -> 429.
// Nothing here logs the key, a header, a query string or a body: a rejected request is logged as method, path, status and a short hash of the caller's address.

export const HRMS_KEY_HEADER = "x-hrms-key";
/** A secret shorter than this is treated as not configured: a guessable key is no key. */
export const MIN_KEY_LENGTH = 16;
export const DEFAULT_PER_MINUTE = 60;
export const DEFAULT_FAILED_PER_MINUTE = 10;

export type HrmsErrorCode = "HRMS_NOT_CONFIGURED" | "METHOD_NOT_ALLOWED" | "INVALID_KEY" | "RATE_LIMITED" | "INVALID_REQUEST" | "NOT_FOUND" | "INTERNAL_ERROR";

export class HrmsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: HrmsErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The configured secret, or null when the integration is not (properly) configured. Read from the environment on every request, so a restart with a new key needs no code change. */
export function readIntegrationKey(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.HRMS_INTEGRATION_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  return raw.length >= MIN_KEY_LENGTH ? raw : null;
}

/**
 * Constant-time comparison. Both sides are hashed first so they have the same length: neither the content nor the LENGTH of the real key can be learned from how long the comparison takes.
 */
export function keysMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const positiveInt = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * The caller's address. Behind a proxy (Render) the socket address is the proxy's, so the address the proxy appended to X-Forwarded-For is used: `hops` is how many trusted proxies sit in front of the app
 * (default 1; set HRMS_TRUSTED_PROXY_HOPS, 0 = use the socket address and ignore the header). Entries further left are client-supplied and never trusted.
 */
export function clientAddress(req: Pick<Request, "headers" | "socket">, hops: number): string {
  if (hops > 0) {
    const raw = req.headers["x-forwarded-for"];
    const list = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length >= hops) return list[list.length - hops]!;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8);

export interface HrmsGuardOptions {
  env?: Record<string, string | undefined>;
  /** Requests per minute per caller address (HRMS_RATE_LIMIT_PER_MINUTE, default 60). */
  perMinute?: number;
  /** Wrong / missing key attempts per minute per address before further failures are answered 429 (HRMS_FAILED_AUTH_PER_MINUTE, default 10). */
  failedPerMinute?: number;
  trustedProxyHops?: number;
  now?: () => number;
}

export function createHrmsGuard(options: HrmsGuardOptions = {}) {
  const env = options.env ?? process.env;
  const perMinute = options.perMinute ?? positiveInt(env.HRMS_RATE_LIMIT_PER_MINUTE, DEFAULT_PER_MINUTE);
  const failedPerMinute = options.failedPerMinute ?? positiveInt(env.HRMS_FAILED_AUTH_PER_MINUTE, DEFAULT_FAILED_PER_MINUTE);
  const hops = options.trustedProxyHops ?? (env.HRMS_TRUSTED_PROXY_HOPS !== undefined && env.HRMS_TRUSTED_PROXY_HOPS !== "" ? Math.max(0, Math.floor(Number(env.HRMS_TRUSTED_PROXY_HOPS)) || 0) : 1);
  const general = new SlidingWindowLimiter(60_000, options.now);
  const failures = new SlidingWindowLimiter(60_000, options.now);

  const reject = (req: Request, res: Response, status: number, code: HrmsErrorCode, message: string, extra: Record<string, string> = {}): void => {
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    // path only (no query string, no headers, no body); the address as a short hash
    if (status !== 503 || code !== "HRMS_NOT_CONFIGURED") logger.warn(`HRMS API rejected ${req.method} ${req.baseUrl}${req.path} -> ${status} ${code} caller=${shortHash(clientAddress(req, hops))}`);
    res.status(status).json({ success: false, error: { code, message } });
  };

  return function hrmsGuard(req: Request, res: Response, next: NextFunction): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const expected = readIntegrationKey(env);
    if (!expected) return reject(req, res, 503, "HRMS_NOT_CONFIGURED", "The HRMS reporting integration is not configured on this server.");
    if (req.method !== "GET") return reject(req, res, 405, "METHOD_NOT_ALLOWED", "This API is read-only: only GET is allowed.", { Allow: "GET" });

    const header = req.headers[HRMS_KEY_HEADER];
    const provided = typeof header === "string" ? header.trim() : "";
    const address = clientAddress(req, hops);
    if (!provided || !keysMatch(provided, expected)) {
      const f = failures.take(address, failedPerMinute);
      if (!f.allowed) return reject(req, res, 429, "RATE_LIMITED", "Too many failed attempts. Try again later.", { "Retry-After": String(f.retryAfterSeconds) });
      return reject(req, res, 401, "INVALID_KEY", "Invalid or missing API key.");
    }

    const g = general.take(address, perMinute);
    res.setHeader("X-RateLimit-Limit", String(perMinute));
    res.setHeader("X-RateLimit-Remaining", String(g.remaining));
    if (!g.allowed) return reject(req, res, 429, "RATE_LIMITED", "Rate limit exceeded. Try again shortly.", { "Retry-After": String(g.retryAfterSeconds) });
    next();
  };
}
