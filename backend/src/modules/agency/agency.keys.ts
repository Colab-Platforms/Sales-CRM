// API keys for the external AI calling agency. A key looks like "avk_" + 43 random URL-safe characters. Only its SHA-256 hash is stored, so a database leak does not reveal a usable key; the key is
// shown once, when it is created (npm run agency:key -- create "<name>"). Keys are 256 bits of randomness, so a plain fast hash is the right tool (nothing to brute-force).
import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "avk_";

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 8), hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The key a request carries: `X-API-Key: avk_...` or `Authorization: Bearer avk_...`. null when absent or not shaped like one of ours (so junk never reaches the database). */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const direct = one(headers["x-api-key"])?.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(one(headers["authorization"])?.trim() ?? "")?.[1]?.trim();
  const candidate = direct || bearer || "";
  return /^avk_[A-Za-z0-9_-]{20,100}$/.test(candidate) ? candidate : null;
}
