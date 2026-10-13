import type { Prisma } from "../../../generated/prisma/client.js";
import { normalizeEmail, normalizeMobile } from "../../lib/leadIdentity.js";
import { parseAbandonmentEvent, parseAddress, type ParsedAddress, type ParsedCheckoutLine, type ParsedCheckoutTotals } from "../shiprocket/shiprocket.abandonment.mapper.js";

// What the Create Order form is prefilled with when it is opened from ONE abandoned checkout. Built only from what the checkout
// actually carried (the Abandonment's own saved cart, or - for rows saved before the cart detail was kept - the raw webhook delivery
// recorded for that same cart id). Nothing is invented: a missing product list / address is reported as missing.

type Db = Pick<Prisma.TransactionClient, "productVariant" | "product" | "webhookEvent">;

/** A saved cart older than this is shown as stale. The checkout platform offers no pull API, so it cannot be refreshed from here. */
export const PREFILL_STALE_AFTER_HOURS = 72;

export interface OrderPrefillLine {
  /** Stable per-line key (its position in the checkout), so a reload never duplicates a line. */
  key: string;
  /** The CRM product / variant this checkout line resolves to; null when it could not be matched (the salesperson must choose). */
  productId: string | null;
  variantId: string | null;
  matched: boolean;
  name: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  /** What the website charged per unit (a hint). The form prices a matched line from the CRM catalogue, as it always does. */
  websiteUnitPrice: string | null;
}

export interface OrderPrefillAddress {
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

export interface OrderPrefill {
  abandonmentId: string;
  leadId: string;
  /** Where the data came from: the cart saved on the abandonment, or the recorded checkout delivery for the same cart. */
  dataFrom: "saved_cart" | "checkout_delivery" | "none";
  sourceName: string | null;
  capturedAt: Date | null;
  stale: boolean;
  /** The checkout platform has no pull API: a stale cart cannot be refreshed from here. */
  refreshSupported: false;
  currency: string;
  customer: { name: string | null; phone: string | null; email: string | null };
  addressKind: "shipping" | "billing" | null;
  address: OrderPrefillAddress | null;
  lines: OrderPrefillLine[];
  totals: ParsedCheckoutTotals;
  /** Plain-language notes for the form: what was not captured, what could not be matched. */
  notes: string[];
}

interface Captured {
  lines: ParsedCheckoutLine[];
  totals: ParsedCheckoutTotals;
  shippingAddress: ParsedAddress | null;
  billingAddress: ParsedAddress | null;
  customer: { firstName: string | null; lastName: string | null; phone: string | null; email: string | null };
  capturedAt: Date | null;
  sourceName: string | null;
  currency: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const emptyTotals = (): ParsedCheckoutTotals => ({ total: null, shipping: null, tax: null, discount: null, discountCodes: [] });

/** Reads the saved snapshot JSON defensively (it is only written by buildCartSnapshot, but never trusted on the way out). */
export function readCaptured(snapshot: unknown): Captured {
  const v = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>;
  const lines: ParsedCheckoutLine[] = [];
  if (Array.isArray(v.lines)) {
    for (const entry of v.lines) {
      const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const name = str(e.name);
      if (!name) continue;
      const qty = Number(e.quantity);
      lines.push({
        productId: str(e.productId),
        variantId: str(e.variantId),
        sku: str(e.sku),
        name,
        variantTitle: str(e.variantTitle),
        imageUrl: str(e.imageUrl),
        quantity: Number.isInteger(qty) && qty > 0 ? qty : null,
        unitPrice: str(e.unitPrice),
      });
    }
  }
  const t = (v.totals && typeof v.totals === "object" ? v.totals : {}) as Record<string, unknown>;
  const c = (v.customer && typeof v.customer === "object" ? v.customer : {}) as Record<string, unknown>;
  const at = typeof v.capturedAt === "string" ? new Date(v.capturedAt) : null;
  return {
    lines,
    totals: { total: str(t.total) ?? str(v.cartValue), shipping: str(t.shipping), tax: str(t.tax), discount: str(t.discount), discountCodes: Array.isArray(t.discountCodes) ? t.discountCodes.filter((x): x is string => typeof x === "string") : [] },
    shippingAddress: parseAddress(v.shippingAddress),
    billingAddress: parseAddress(v.billingAddress),
    customer: { firstName: str(c.firstName), lastName: str(c.lastName), phone: str(c.phone), email: str(c.email) },
    capturedAt: at && !Number.isNaN(at.getTime()) ? at : null,
    sourceName: str(v.sourceName),
    currency: str(v.currency),
  };
}

/** Older abandonments (saved before the cart detail was kept) still have the raw delivery. Only a delivery for THIS cart id AND this customer is used. */
async function capturedFromDelivery(db: Db, referenceId: string, lead: { normalizedMobile: string | null; normalizedEmail: string | null }): Promise<Captured | null> {
  const event = await db.webhookEvent.findFirst({
    where: { provider: "SHIPROCKET_CHECKOUT", eventType: "checkout.abandoned", payload: { path: ["cart_id"], equals: referenceId } },
    orderBy: { receivedAt: "desc" },
    select: { payload: true },
  });
  if (!event) return null;
  const parsed = parseAbandonmentEvent(event.payload);
  if (!parsed) return null;
  // Never let one customer's cart be shown on another's lead: the delivery must belong to this lead's phone / email.
  const phone = normalizeMobile(parsed.phone);
  const email = normalizeEmail(parsed.email);
  const sameCustomer = (phone && lead.normalizedMobile && phone === lead.normalizedMobile) || (email && lead.normalizedEmail && email === lead.normalizedEmail);
  if (!sameCustomer) return null;
  return {
    lines: parsed.lines,
    totals: parsed.totals,
    shippingAddress: parsed.shippingAddress,
    billingAddress: parsed.billingAddress,
    customer: { firstName: parsed.firstName, lastName: parsed.lastName, phone: parsed.phone, email: parsed.email },
    capturedAt: parsed.abandonedAt,
    sourceName: parsed.sourceName,
    currency: parsed.currency,
  };
}

const shopifyIds = (id: string) => [id, `gid://shopify/ProductVariant/${id}`, `gid://shopify/Product/${id}`];

/** Maps each checkout line to the CRM's own product / variant (by the storefront ids, else SKU). A line that cannot be matched stays unmatched. */
async function matchLines(db: Db, lines: ParsedCheckoutLine[]): Promise<OrderPrefillLine[]> {
  const variantIds = [...new Set(lines.flatMap((l) => (l.variantId ? shopifyIds(l.variantId) : [])))];
  const productIds = [...new Set(lines.flatMap((l) => (l.productId ? shopifyIds(l.productId) : [])))];
  const skus = [...new Set(lines.map((l) => l.sku).filter((s): s is string => !!s))];
  const [variants, products] = await Promise.all([
    db.productVariant.findMany({
      where: { OR: [...(variantIds.length ? [{ externalId: { in: variantIds } }] : []), ...(skus.length ? [{ sku: { in: skus } }] : [])] },
      select: { id: true, productId: true, externalId: true, sku: true },
    }),
    db.product.findMany({
      where: { OR: [...(productIds.length ? [{ externalId: { in: productIds } }] : []), ...(skus.length ? [{ sku: { in: skus } }] : [])] },
      select: { id: true, externalId: true, sku: true, variants: { select: { id: true } } },
    }),
  ]);
  const norm = (id: string | null) => (id ? id.replace(/^gid:\/\/shopify\/\w+\//, "") : null);
  return lines.map((l, index) => {
    const base = { key: `checkout-${index}`, name: l.name, variantTitle: l.variantTitle, sku: l.sku, imageUrl: l.imageUrl, quantity: l.quantity ?? 1, websiteUnitPrice: l.unitPrice };
    const variant = variants.find((v) => (l.variantId && norm(v.externalId) === l.variantId) || (l.sku && v.sku === l.sku));
    if (variant) return { ...base, productId: variant.productId, variantId: variant.id, matched: true };
    const product = products.find((p) => (l.productId && norm(p.externalId) === l.productId) || (l.sku && p.sku === l.sku));
    // A single-variant product is unambiguous; with several variants the salesperson picks (never guessed).
    if (product) return { ...base, productId: product.id, variantId: product.variants.length === 1 ? product.variants[0]!.id : null, matched: true };
    return { ...base, productId: null, variantId: null, matched: false };
  });
}

export async function buildOrderPrefill(
  db: Db,
  row: { id: string; leadId: string; referenceId: string | null; cartSnapshot: unknown; lead: { firstName: string; lastName: string | null; mobile: string | null; email: string | null; normalizedMobile: string | null; normalizedEmail: string | null } },
  now: Date = new Date(),
): Promise<OrderPrefill> {
  let captured = readCaptured(row.cartSnapshot);
  let dataFrom: OrderPrefill["dataFrom"] = captured.lines.length > 0 || captured.shippingAddress || captured.billingAddress ? "saved_cart" : "none";
  if (dataFrom === "none" && row.referenceId) {
    const delivered = await capturedFromDelivery(db, row.referenceId, row.lead);
    if (delivered && (delivered.lines.length > 0 || delivered.shippingAddress || delivered.billingAddress)) {
      captured = { ...delivered, currency: delivered.currency ?? captured.currency };
      dataFrom = "checkout_delivery";
    }
  }

  const lines = await matchLines(db, captured.lines);
  const address = captured.shippingAddress ?? captured.billingAddress;
  const addressKind = captured.shippingAddress ? "shipping" : captured.billingAddress ? "billing" : null;
  const name = [captured.customer.firstName ?? row.lead.firstName, captured.customer.lastName ?? row.lead.lastName].filter(Boolean).join(" ") || null;
  const stale = captured.capturedAt ? now.getTime() - captured.capturedAt.getTime() > PREFILL_STALE_AFTER_HOURS * 3_600_000 : false;

  const notes: string[] = [];
  if (lines.length === 0) notes.push("No products were captured for this abandoned checkout. Add the products manually.");
  const unmatched = lines.filter((l) => !l.matched).length;
  if (unmatched > 0) notes.push(`${unmatched} checkout item${unmatched === 1 ? "" : "s"} could not be matched to a CRM product - choose the product for ${unmatched === 1 ? "it" : "each"}.`);
  if (!address) notes.push("No delivery address was captured for this abandoned checkout. Enter it manually.");
  else if (addressKind === "billing") notes.push("Only a billing address was captured - please confirm it is the delivery address.");
  if (stale) notes.push(`This saved cart was last updated ${captured.capturedAt!.toISOString().slice(0, 10)} and may be out of date. It cannot be refreshed automatically.`);

  const pick = (a: ParsedAddress | null): OrderPrefillAddress | null =>
    a ? { name: a.name ?? ([a.firstName, a.lastName].filter(Boolean).join(" ") || null), phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, state: a.state, pincode: a.pincode, country: a.country, company: a.company } : null;

  return {
    abandonmentId: row.id,
    leadId: row.leadId,
    dataFrom,
    sourceName: captured.sourceName,
    capturedAt: captured.capturedAt,
    stale,
    refreshSupported: false,
    currency: captured.currency ?? "INR",
    customer: { name, phone: captured.customer.phone ?? row.lead.mobile, email: captured.customer.email ?? row.lead.email },
    addressKind,
    address: pick(address),
    lines,
    totals: captured.totals ?? emptyTotals(),
    notes,
  };
}
