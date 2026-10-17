import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";

export const REFRESH_COOKIE_NAME = "crm_refresh";
/** The cookie is only sent to the auth routes, never to the rest of the API. */
const REFRESH_COOKIE_PATH = "/api/auth";
/** A rotated token shown again within this window is a parallel tab / retry, not theft. */
export const ROTATION_GRACE_MS = 30_000;

type Env = Record<string, string | undefined>;

/** REFRESH_TOKEN_TTL_DAYS (default 30). REFRESH_TOKEN_TTL_MINUTES, when set, wins - handy for testing expiry. */
export function refreshTtlMs(env: Env = process.env): number {
  const minutes = Number((env.REFRESH_TOKEN_TTL_MINUTES ?? "").trim());
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60_000;
  const days = Number((env.REFRESH_TOKEN_TTL_DAYS ?? "").trim());
  return (Number.isFinite(days) && days > 0 ? days : 30) * 86_400_000; // 30 days in milliseconds
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Cross-site deployments (frontend and API on different registrable domains) need SameSite=None; Secure. Same-site setups
 * (localhost, or sibling subdomains) can use lax. REFRESH_COOKIE_SAMESITE overrides: none | lax | strict.
 */
function cookieOptions(env: Env): CookieOptions {
  const production = env.NODE_ENV === "production";
  const configured = (env.REFRESH_COOKIE_SAMESITE ?? "").trim().toLowerCase();
  const sameSite =
    configured === "none" || configured === "lax" || configured === "strict"
      ? configured
      : production
        ? "none"
        : "lax";
  return {
    httpOnly: true,
    secure: production || sameSite === "none",
    sameSite,
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(
  res: Response,
  token: string,
  env: Env = process.env,
): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...cookieOptions(env),
    maxAge: refreshTtlMs(env),
  });
}

export function clearRefreshCookie(
  res: Response,
  env: Env = process.env,
): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions(env));
}

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === REFRESH_COOKIE_NAME) {
      const value = part.slice(index + 1).trim();
      return value || null;
    }
  }
  return null;
}
