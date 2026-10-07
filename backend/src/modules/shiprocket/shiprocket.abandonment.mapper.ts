import { timingSafeEqual } from "node:crypto";
import { asRecord, asString, headerOf, sha256Hex } from "../integrations/integrations.common.js";

// Turns a Shiprocket Checkout (Fastrr) "Abandon Cart" webhook delivery into a small description of
// what happened. This is the one place that knows that payload's shape.
//
// CONFIRMED from live deliveries captured on 2026-09-28 (source_name: "fastrr") - field names below
// are the real top-level contract, not a guess: phone_number, email, first_name, last_name, cart_id,
// total_price, currency, items[] ({sku, name, title, price, quantity}), latest_stage, checkout_url,
// created_at/updated_at (no timezone - India Standard Time, per parseTimestamp below). The nested
// customer/buyer/contact-object and alternate-key fallbacks are kept as a defensive second attempt
// only, in case a different checkout flow (e.g. a different payment method or app version) ever
// shapes the payload differently - they are not known to ever actually fire.
//
// The raw payload is always recorded on the WebhookEvent row regardless of whether it parses (see
// shiprocket.abandonment.webhook.handler.ts), so a future shape change can still be inspected there.

/** One cart line with the stable identifiers Fastrr sent (any may be null - nothing is invented). */
export interface ParsedCartItem {
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  quantity: number | null;
}

export interface ParsedAbandonment {
  /** Cart id - used both to dedupe repeat deliveries for the same cart and as the lead's externalId. */
  externalId: string | null;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  /** Total cart value, as Shiprocket Checkout reports it - shown to the telecaller, never used for money math. */
  cartValue: string | null;
  currency: string | null;
  itemCount: number | null;
  /** Up to 3 product names, for a quick "was checking out X, Y" cue on the call. */
  itemNames: string[];
  /** Every cart line with its product/variant id and SKU where Fastrr gave them (what the Items filter matches on). */
  items: ParsedCartItem[];
  /** Free-text checkout stage if the payload names one (e.g. PAYMENT_INITIATED, ORDER_SCREEN). Never invented. */
  stage: string | null;
  abandonedAt: Date | null;
  /** The customer's own resume-checkout link, if Fastrr sent one - lets a telecaller send it directly. */
  checkoutUrl: string | null;
  /** City/state from the shipping (or billing) address, for the Lead's location field. */
  location: string | null;
}

function pick(body: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) return body[key];
  }
  return undefined;
}

const CUSTOMER_OBJECT_KEYS = ["customer", "buyer", "user", "contact"];

/** Same field, tried at the top level first (the confirmed shape), then inside a nested customer-ish object. */
function contactString(body: Record<string, unknown>, topKeys: string[], nestedKeys: string[]): string | null {
  const top = asString(pick(body, topKeys));
  if (top) return top;
  for (const key of CUSTOMER_OBJECT_KEYS) {
    const nested = asString(pick(asRecord(body[key]), nestedKeys));
    if (nested) return nested;
  }
  return null;
}

function fullNameParts(body: Record<string, unknown>): { firstName: string; lastName: string | null } {
  const topFirst = asString(body.first_name);
  if (topFirst) return { firstName: topFirst, lastName: asString(body.last_name) };

  for (const key of CUSTOMER_OBJECT_KEYS) {
    const nested = asRecord(body[key]);
    const first = asString(nested.first_name) ?? asString(nested.firstName);
    if (first) return { firstName: first, lastName: asString(nested.last_name) ?? asString(nested.lastName) };
    const full = asString(nested.name);
    if (full) {
      const [firstName, ...rest] = full.split(/\s+/);
      return { firstName, lastName: rest.length > 0 ? rest.join(" ") : null };
    }
  }
  const topFull = asString(body.customer_name) ?? asString(body.name);
  if (topFull) {
    const [firstName, ...rest] = topFull.split(/\s+/);
    return { firstName, lastName: rest.length > 0 ? rest.join(" ") : null };
  }
  return { firstName: "Shiprocket Checkout lead", lastName: null };
}

function parseTimestamp(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseItems(body: Record<string, unknown>): { itemCount: number | null; itemNames: string[]; items: ParsedCartItem[] } {
  const raw = pick(body, ["items", "cart_items", "line_items", "products"]);
  if (!Array.isArray(raw)) return { itemCount: null, itemNames: [], items: [] };
  const items: ParsedCartItem[] = [];
  for (const entry of raw) {
    const r = asRecord(entry);
    const name = asString(r.name) ?? asString(r.title) ?? asString(r.product_name);
    if (!name) continue;
    const qty = Number(r.quantity);
    items.push({
      productId: asString(r.product_id) ?? asString(r.productId),
      variantId: asString(r.variant_id) ?? asString(r.variantId),
      sku: asString(r.sku),
      name,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
    });
  }
  return { itemCount: raw.length, itemNames: items.map((i) => i.name), items };
}

/** shipping_address is what the customer will actually receive the order at; billing_address is the fallback. */
function parseLocation(body: Record<string, unknown>): string | null {
  const address = asRecord(body.shipping_address);
  const fallback = asRecord(body.billing_address);
  const city = asString(address.city) ?? asString(fallback.city);
  const state = asString(address.state) ?? asString(fallback.state);
  return [city, state].filter(Boolean).join(", ") || null;
}

export function parseAbandonmentEvent(payload: unknown): ParsedAbandonment | null {
  const body = asRecord(payload);
  const phone = contactString(body, ["phone_number", "phone", "mobile", "contact_number", "customer_phone"], ["phone", "mobile"]);
  const email = contactString(body, ["email", "customer_email"], ["email"]);
  // No lead can be created or matched without a way to contact the person, so a delivery with neither is not usable.
  if (!phone && !email) return null;

  const { firstName, lastName } = fullNameParts(body);
  const { itemCount, itemNames, items } = parseItems(body);

  return {
    externalId: asString(pick(body, ["cart_id", "checkout_id", "session_id", "id", "cart_token", "token"])),
    firstName,
    lastName,
    phone,
    email,
    cartValue: asString(pick(body, ["total_price", "cart_value", "total", "amount", "order_value"])),
    currency: asString(pick(body, ["currency", "currency_code"])) ?? "INR",
    itemCount,
    itemNames,
    items,
    stage: asString(pick(body, ["latest_stage", "stage", "status", "checkout_stage", "cart_status"])),
    abandonedAt: parseTimestamp(pick(body, ["updated_at", "created_at", "abandoned_at", "timestamp"])),
    checkoutUrl: asString(pick(body, ["checkout_url", "cart_url", "resume_url"])),
    location: parseLocation(body),
  };
}

export function verifyAbandonmentSecret(headers: Record<string, string | string[] | undefined>, secret: string): boolean {
  // The header name is our own choice, entered into the free-form "Headers" field when the webhook is
  // registered in the Shiprocket Checkout dashboard - there is no provider-mandated name to match.
  const given = headerOf(headers, "x-webhook-secret")?.trim();
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const deliveryId = (rawBody: Buffer): string => `sha256:${sha256Hex(rawBody)}`;

/** A short, human line for the abandonment queue and priority reasoning - never used for money math. */
export function summarize(event: ParsedAbandonment): string {
  const parts: string[] = [];
  if (event.cartValue) parts.push(`${event.currency ?? "INR"} ${event.cartValue}`);
  if (event.itemCount) parts.push(`${event.itemCount} item${event.itemCount === 1 ? "" : "s"}`);
  if (event.itemNames.length > 0) parts.push(event.itemNames.join(", "));
  if (event.stage) parts.push(`stage: ${event.stage}`);
  if (event.checkoutUrl) parts.push(`resume link: ${event.checkoutUrl}`);
  return parts.length > 0 ? parts.join(" · ") : "Cart abandoned before payment";
}
