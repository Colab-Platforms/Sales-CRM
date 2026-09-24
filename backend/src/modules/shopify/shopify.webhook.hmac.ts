import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Base64 HMAC-SHA256 of the raw request body, which is what Shopify puts in X-Shopify-Hmac-SHA256. */
export function computeHmac(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

/** Constant-time check of a delivery's signature. Must be given the body exactly as received, before any parsing. */
export function verifyHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(computeHmac(rawBody, secret));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Stand-in delivery id for the rare request that lacks X-Shopify-Webhook-Id, so it is still de-duplicated. */
export const bodyDigest = (rawBody: Buffer): string => `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
