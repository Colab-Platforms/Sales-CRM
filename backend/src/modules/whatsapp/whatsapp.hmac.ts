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

// Meta's official WhatsApp Cloud API signs each webhook delivery with X-Hub-Signature-256: the
// hex-encoded HMAC-SHA256 of the raw request body, prefixed "sha256=", keyed with the app's App
// Secret (documented Meta Graph API webhook behavior - same scheme Meta uses for every Graph API
// webhook product, not WhatsApp-specific). Same shape as verifyAiSensyHmac, just with the prefix.
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const expected = Buffer.from(prefix + createHmac("sha256", appSecret).update(rawBody).digest("hex"));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Meta's GET webhook verification handshake: pure decision logic, factored out of
 *  whatsapp.meta.webhook.routes.ts so it is testable without Express or a database. Returns the
 *  challenge string to echo back on success, or null to respond 403 - never throws. */
export function resolveMetaWebhookChallenge(
  query: { mode: unknown; verifyToken: unknown; challenge: unknown },
  expectedVerifyToken: string | null,
): string | null {
  if (query.mode !== "subscribe" || typeof query.challenge !== "string" || !expectedVerifyToken) return null;
  const given = Buffer.from(String(query.verifyToken ?? ""));
  const expected = Buffer.from(expectedVerifyToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return query.challenge;
}
