import { addressColumnsFromSnapshot, composeAddress, type AddressColumns } from "../../lib/addressColumns.js";
import { normalizeEmail, normalizeMobile } from "../../lib/leadIdentity.js";
import { asRecord, asString } from "../integrations/integrations.common.js";
import { MAX_CART_LINES, parseAbandonmentEvent, parseAddress, type ParsedAbandonment, type ParsedAddress } from "../shiprocket/shiprocket.abandonment.mapper.js";

// Turns one record of the Fastrr reporting API (data.abandonCarts[]) into what the CRM's existing abandonment save step takes (ParsedAbandonment).
//
// Fields observed in the listing: cart, custName, custPhone, custEmail, timeInitiated, amount, subTotal, checkoutStage, latestStage, orderId, items, shippingCharges, codCharges,
// couponDiscount, notificationTime. The listing's ADDRESS field names were not captured, so the address is read tolerantly (several plausible keys, an object or a plain string) and
// anything it does not provide stays empty - nothing is guessed or composed from other data. Every field is validated; one bad record never stops the others.

/** A cart as the preview, the export and the import all see it. */
export interface RecoveryCart {
  /** Fastrr's cart id (the `cart` field), trimmed - the key every duplicate check uses. null only for a record that has none. */
  cartId: string | null;
  customerName: string;
  /** As Fastrr gave it. Never logged. */
  phone: string | null;
  email: string | null;
  itemsText: string;
  cartValue: number | null;
  abandonedAt: Date | null;
  stage: string | null;
  /** Fastrr's order id for this cart, when the checkout was completed. */
  orderId: string | null;
  /** Fastrr couponDiscount, as a number (null when absent or unreadable). */
  couponDiscount: number | null;
  address: AddressColumns;
  /** null when the record cannot be imported (see invalidReason). */
  parsed: ParsedAbandonment | null;
  invalidReason: string | null;
}

const IST_OFFSET = "+05:30";

/** Fastrr's checkout time: an ISO string with or without a zone (no zone = India Standard Time, like the webhook), an epoch in seconds or milliseconds, or "YYYY-MM-DD HH:mm:ss". null when unreadable. */
export function parseCheckoutTime(value: unknown): Date | null {
  let date: Date;
  if (typeof value === "number" && Number.isFinite(value)) date = new Date(value < 1e11 ? value * 1000 : value);
  else {
    const text = asString(value);
    if (!text) return null;
    if (/^\d{9,13}$/.test(text)) {
      const n = Number(text);
      date = new Date(n < 1e11 ? n * 1000 : n);
    } else if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(\s?(Z|[+-]\d{2}:?\d{2}))?$/i.test(text)) {
      const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
      const normalised = text.replace(" ", "T").replace(/\s/g, "");
      date = new Date(hasZone ? normalised : `${normalised.includes("T") ? normalised : `${normalised}T00:00:00`}${IST_OFFSET}`);
    } else return null;
  }
  const year = date.getUTCFullYear();
  return Number.isNaN(date.getTime()) || year < 2020 || year > 2100 ? null : date;
}

function amountOf(value: unknown): number | null {
  const text = asString(value);
  if (!text) return null;
  const cleaned = text.replace(/[,₹\s]/g, "").replace(/^INR/i, "");
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function readItems(raw: unknown): { name: string; sku: string | null; quantity: number | null; price: string | null; productId: string | null; variantId: string | null }[] {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, MAX_CART_LINES)) {
    const r = asRecord(entry);
    const name = asString(r.name) ?? asString(r.title) ?? asString(r.productName) ?? asString(r.product_name);
    if (!name) continue;
    const qty = Number(r.quantity ?? r.qty);
    const price = amountOf(r.price ?? r.unitPrice ?? r.unit_price ?? r.sellingPrice);
    out.push({
      name,
      sku: asString(r.sku) ?? asString(r.SKU),
      quantity: Number.isInteger(qty) && qty > 0 && qty <= 10_000 ? qty : null,
      price: price === null ? null : String(price),
      productId: asString(r.productId) ?? asString(r.product_id),
      variantId: asString(r.variantId) ?? asString(r.variant_id),
    });
  }
  return out;
}

const ADDRESS_KEYS = ["shippingAddress", "shipping_address", "deliveryAddress", "delivery_address", "customerAddress", "customer_address", "address"];
const FULL_TEXT_KEYS = ["fullAddress", "full_address", "formattedAddress", "formatted_address", "completeAddress", "complete_address"];

/** The shipping address of a listing record. Parts come only from fields the record carries; the original text is kept whole when the record gives it as one. */
export function readFastrrAddress(record: Record<string, unknown>): { parts: ParsedAddress | null; text: string | null } {
  for (const key of ADDRESS_KEYS) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return { parts: null, text: v.trim() };
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = asRecord(v);
      const parts = parseAddress(obj);
      const own = FULL_TEXT_KEYS.map((k) => asString(obj[k])).find(Boolean) ?? null;
      if (parts || own) return { parts, text: own ?? (parts ? composeAddress(parts) || null : null) };
    }
  }
  // Flat fields on the record itself (only when the record really has them).
  const flat: Record<string, unknown> = {};
  for (const [from, to] of [["address1", "address1"], ["address2", "address2"], ["addressLine1", "address1"], ["addressLine2", "address2"], ["landmark", "landmark"], ["city", "city"], ["state", "state"], ["pincode", "pincode"], ["zipcode", "pincode"], ["zip", "pincode"], ["country", "country"]] as const) {
    const v = asString(record[from]);
    if (v && flat[to] === undefined) flat[to] = v;
  }
  const parts = Object.keys(flat).length > 0 ? parseAddress(flat) : null;
  const own = FULL_TEXT_KEYS.map((k) => asString(record[k])).find(Boolean) ?? null;
  return { parts, text: own ?? (parts ? composeAddress(parts) || null : null) };
}

/** One Fastrr record -> a RecoveryCart. Never throws: an unusable record comes back with parsed=null and the reason. */
export function mapFastrrCart(raw: unknown): RecoveryCart {
  const r = asRecord(raw);
  const cartId = asString(r.cart) ?? asString(r.cartId) ?? asString(r.cart_id);
  const nameText = asString(r.custName) ?? "";
  const rawPhone = asString(r.custPhone);
  const normalizedPhone = normalizeMobile(rawPhone);
  const email = normalizeEmail(asString(r.custEmail));
  const abandonedAt = parseCheckoutTime(r.timeInitiated);
  const items = readItems(r.items);
  const amount = amountOf(r.amount) ?? amountOf(r.subTotal);
  const stage = asString(r.latestStage) ?? asString(r.checkoutStage);
  const orderId = asString(r.orderId);
  const { parts, text } = readFastrrAddress(r);

  const snapshotLike = { shippingAddress: parts, shippingAddressText: text };
  const base = {
    cartId,
    customerName: nameText,
    phone: rawPhone,
    email: asString(r.custEmail),
    itemsText: items.map((i) => (i.quantity && i.quantity > 1 ? `${i.name} x ${i.quantity}` : i.name)).join(", "),
    cartValue: amount,
    abandonedAt,
    stage,
    orderId,
    couponDiscount: amountOf(r.couponDiscount),
    address: addressColumnsFromSnapshot(snapshotLike),
  };
  const invalid = (reason: string): RecoveryCart => ({ ...base, parsed: null, invalidReason: reason });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base, cartId: null, parsed: null, invalidReason: "Record is not an object" };
  if (!cartId) return invalid("Missing cart id");
  if (cartId.length > 255) return invalid("Cart id is too long");
  if (!normalizedPhone && !email) return invalid(rawPhone ? "Phone number is not valid and there is no email" : "No phone number or email");
  if (!abandonedAt) return invalid("Missing or unreadable checkout time");
  if (items.length === 0) return invalid("Cart has no valid product data");

  const [first, ...rest] = nameText.split(/\s+/).filter(Boolean);
  const body: Record<string, unknown> = {
    cart_id: cartId,
    phone_number: normalizedPhone ? rawPhone : undefined,
    email: email ?? undefined,
    first_name: first,
    last_name: rest.length > 0 ? rest.join(" ") : undefined,
    total_price: amount === null ? undefined : String(amount),
    currency: "INR",
    latest_stage: stage ?? undefined,
    source_name: "fastrr",
    shipping_price: amountOf(r.shippingCharges) === null ? undefined : String(amountOf(r.shippingCharges)),
    total_discount: amountOf(r.couponDiscount) === null ? undefined : String(amountOf(r.couponDiscount)),
    items: items.map((i) => ({ name: i.name, sku: i.sku ?? undefined, quantity: i.quantity ?? undefined, price: i.price ?? undefined, product_id: i.productId ?? undefined, variant_id: i.variantId ?? undefined })),
    shipping_address: parts ? { ...parts, address1: parts.line1, address2: parts.line2, zip: parts.pincode } : undefined,
  };
  const parsed = parseAbandonmentEvent(body);
  if (!parsed) return invalid("No usable phone number or email");
  parsed.abandonedAt = abandonedAt;
  parsed.shippingAddressText = text;
  parsed.fastrrOrderId = orderId;
  return { ...base, parsed, invalidReason: null };
}
