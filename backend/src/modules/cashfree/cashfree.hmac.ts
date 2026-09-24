import { createHmac, timingSafeEqual } from "node:crypto";
import { headerOf } from "../integrations/integrations.common.js";

// Cashfree signs every webhook. From Cashfree's signature-verification page:
//   signature = Base64( HMAC-SHA256( x-webhook-timestamp + rawBody, <PG client secret> ) )
// sent in the x-webhook-signature header. The body must be the exact bytes received: re-serialising parsed JSON changes
// decimal amounts (e.g. 100.00 -> 100) and breaks the match.
//
// UNCONFIRMED until a sandbox webhook is received: the prose on that page says "timestamp.rawPayload" while its own
// sample code joins them with no separator. The sample code (no separator) is implemented; SEPARATOR is the one place
// to change if a real delivery shows otherwise.
export const SEPARATOR = "";

export function computeSignature(timestamp: string, rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(timestamp + SEPARATOR).update(rawBody).digest("base64");
}

export function verifyCashfreeSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secret: string): boolean {
  const timestamp = headerOf(headers, "x-webhook-timestamp")?.trim();
  const signature = headerOf(headers, "x-webhook-signature")?.trim();
  if (!timestamp || !signature) return false;
  const expected = Buffer.from(computeSignature(timestamp, rawBody, secret));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
