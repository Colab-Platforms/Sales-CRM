import { timingSafeEqual } from "node:crypto";
import { unwrapAddress } from "@/lib/addressReader.js";
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

/** One cart line with what the checkout order form needs: unit price, variant label, picture. Anything Fastrr did not send is null - nothing is invented. */
export interface ParsedCheckoutLine {
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantTitle: string | null;
  imageUrl: string | null;
  quantity: number | null;
  /** The unit price Fastrr reported (a decimal string). A hint for the salesperson - the CRM re-prices every line itself. */
  unitPrice: string | null;
}

/** A shipping / billing address exactly as the customer entered it at checkout (every field optional). */
export interface ParsedAddress {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  phone: string | null;
  line1: string | null;
  line2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
  company: string | null;
}

export interface ParsedCheckoutTotals {
  total: string | null;
  shipping: string | null;
  tax: string | null;
  discount: string | null;
  discountCodes: string[];
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
  /** Everything the Create Order form can prefill from this checkout. Null / empty when the customer had not got that far. */
  lines: ParsedCheckoutLine[];
  totals: ParsedCheckoutTotals;
  shippingAddress: ParsedAddress | null;
  billingAddress: ParsedAddress | null;
  /** The platform that sent the cart (Fastrr reports source_name). */
  sourceName: string | null;
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
  for (const entry of raw.slice(0, MAX_CART_LINES)) {
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

/** Fastrr's own address object -> one tolerant shape. Only fields the customer actually supplied are set; an object with nothing usable is null. */
export function parseAddress(value: unknown): ParsedAddress | null {
  // A provider may nest the address ({ shippingAddress: { address: {...} } }); read the object that actually holds the fields.
  const r = asRecord(unwrapAddress(value) ?? value);
  const address: ParsedAddress = {
    firstName: asString(r.first_name) ?? asString(r.firstName),
    lastName: asString(r.last_name) ?? asString(r.lastName),
    name: asString(r.name) ?? asString(r.full_name),
    phone: asString(r.phone) ?? asString(r.phone_number) ?? asString(r.mobile),
    line1: asString(r.address1) ?? asString(r.line_1) ?? asString(r.address_line_1) ?? asString(r.line1) ?? asString(r.address),
    line2: asString(r.address2) ?? asString(r.line_2) ?? asString(r.address_line_2) ?? asString(r.line2),
    landmark: asString(r.landmark),
    city: asString(r.city),
    state: asString(r.state) ?? asString(r.province),
    pincode: asString(r.zip) ?? asString(r.pincode) ?? asString(r.postal_code) ?? asString(r.postcode) ?? asString(r.zipcode) ?? asString(r.postalCode),
    country: asString(r.country) ?? asString(r.country_code),
    company: asString(r.company),
  };
  return Object.values(address).some((v) => v !== null) ? address : null;
}

/** A cart is a handful of lines; anything beyond this is not a real cart and is not stored. */
export const MAX_CART_LINES = 100;
const DECIMAL = /^\d{1,9}(\.\d{1,4})?$/;

function parseLines(body: Record<string, unknown>): ParsedCheckoutLine[] {
  const raw = pick(body, ["items", "cart_items", "line_items", "products"]);
  if (!Array.isArray(raw)) return [];
  const lines: ParsedCheckoutLine[] = [];
  for (const entry of raw.slice(0, MAX_CART_LINES)) {
    const r = asRecord(entry);
    const name = asString(r.name) ?? asString(r.title) ?? asString(r.product_name);
    if (!name) continue;
    const qty = Number(r.quantity);
    const price = asString(r.price) ?? asString(r.unit_price);
    const title = asString(r.title);
    lines.push({
      productId: asString(r.product_id) ?? asString(r.productId),
      variantId: asString(r.variant_id) ?? asString(r.variantId),
      sku: asString(r.sku),
      name,
      variantTitle: title && title !== name ? title : asString(r.variant_title),
      imageUrl: asString(r.img_url) ?? asString(r.image_url) ?? asString(r.image),
      quantity: Number.isInteger(qty) && qty > 0 && qty <= 10_000 ? qty : null,
      unitPrice: price && DECIMAL.test(price) ? price : null,
    });
  }
  return lines;
}

function parseTotals(body: Record<string, unknown>): ParsedCheckoutTotals {
  const codes = body.discount_codes;
  return {
    total: asString(pick(body, ["total_price", "cart_value", "total", "amount", "order_value"])),
    shipping: asString(body.shipping_price),
    tax: asString(body.tax),
    discount: asString(body.total_discount),
    discountCodes: Array.isArray(codes) ? codes.map((c) => asString(c) ?? asString(asRecord(c).code)).filter((c): c is string => !!c).slice(0, 5) : [],
  };
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
    lines: parseLines(body),
    totals: parseTotals(body),
    shippingAddress: parseAddress(body.shipping_address),
    billingAddress: parseAddress(body.billing_address),
    sourceName: asString(body.source_name),
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
