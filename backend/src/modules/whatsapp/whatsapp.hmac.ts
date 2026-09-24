import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Stand-in delivery id when a provider gives no per-delivery id header, so a repeat is still deduplicated. */
export const bodyDigest = (rawBody: Buffer): string => `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;

// AiSensy signs each webhook delivery with X-AiSensy-Signature: the hex-encoded HMAC-SHA256 of the
// raw request body, keyed with the shared secret set in the AiSensy dashboard. Same idea as
// Shopify's X-Shopify-Hmac-SHA256 (shopify.webhook.hmac.ts), just hex instead of base64.
export function computeAiSensyHmac(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyAiSensyHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(computeAiSensyHmac(rawBody, secret));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Gupshup authenticates a callback URL with a system-generated Authorization token configured
// alongside the webhook URL, rather than a per-request signature: the endpoint checks the
// Authorization header sent with each delivery equals the token, in constant time.
export function verifyGupshupToken(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(token.trim());
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
