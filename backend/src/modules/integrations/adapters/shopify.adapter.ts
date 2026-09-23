import { createHmac, timingSafeEqual } from "node:crypto";
import { SourceType } from "../../../../generated/prisma/enums.js";
import type { IntegrationAdapter, DecryptedCredentials, MappedLeadData, WebhookHeaders } from "./adapter.types.js";

interface ShopifyCustomer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  created_at?: string;
  updated_at?: string;
  default_address?: {
    city?: string;
  };
}

// customers/update fires for ANY change to a customer (address added at checkout,
// marketing-consent toggles, order stats, tags, ...) — not just the onboarding
// profile form. To avoid turning every existing shopper's routine store activity
// into a "new lead", only treat an update as a fresh signup if it lands within
// this window of the customer's creation (OTP verify -> profile save is normally
// a couple of minutes).
const NEW_SIGNUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function isRecentSignup(customer: ShopifyCustomer): boolean {
  if (!customer.created_at || !customer.updated_at) return true;
  const created = Date.parse(customer.created_at);
  const updated = Date.parse(customer.updated_at);
  if (Number.isNaN(created) || Number.isNaN(updated)) return true;
  return updated - created <= NEW_SIGNUP_WINDOW_MS;
}

function headerValue(headers: WebhookHeaders, key: string): string | null {
  const value = headers[key];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

export const shopifyAdapter: IntegrationAdapter = {
  provider: SourceType.SHOPIFY,

  resolveExternalAccountId(_body: unknown, headers: WebhookHeaders): string | null {
    return headerValue(headers, "x-shopify-shop-domain");
  },

  resolveEventType(_body: unknown, headers: WebhookHeaders): string {
    return headerValue(headers, "x-shopify-topic") ?? "unknown";
  },

  verifySignature(rawBody: string, headers: WebhookHeaders, credentials: DecryptedCredentials): boolean {
    const webhookSecret = credentials.webhookSecret;
    if (!webhookSecret) return false;

    const signature = headerValue(headers, "x-shopify-hmac-sha256");
    if (!signature) return false;

    const expected = createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("base64");

    const expectedBuf = Buffer.from(expected, "base64");
    const providedBuf = Buffer.from(signature, "base64");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  },

  parseWebhookPayload(body: unknown): unknown[] {
    return body ? [body] : [];
  },

  mapToLeadData(entry: unknown): MappedLeadData | null {
    const customer = entry as ShopifyCustomer;

    // This store creates the Customer record right at OTP verification, with only
    // `phone` set — first_name/last_name/email are filled in later on a separate
    // profile step, which fires a `customers/update` webhook, not `customers/create`.
    // Skip bare-phone entries here so we don't create a lead with the phone number
    // standing in for a name; wait for the update event that carries real details.
    if (!customer.first_name?.trim() && !customer.email) return null;

    // Skip updates on customers created long ago — those are existing shoppers
    // touching their record during a routine store action, not a new signup.
    if (!isRecentSignup(customer)) return null;

    return {
      firstName: customer.first_name!.trim() || customer.email!,
      lastName: customer.last_name,
      mobile: customer.phone,
      email: customer.email,
      location: customer.default_address?.city,
    };
  },
};
