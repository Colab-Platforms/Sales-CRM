import type { Prisma } from "../../../generated/prisma/client.js";
import { derivePaymentMode, derivePaymentStatus } from "../orders/orders.filters.js";
import { loadLiveShopifyOrders, type LiveHistoryClientFactory, type LiveHistoryStatus } from "./abandonment.shopify-history.js";

// What the abandoned-lead page shows about the CUSTOMER beyond the cart: the full delivery address and every earlier order. Nothing here is invented: the address is read from the saved
// checkout (and, failing that, the customer's latest order), and the orders are the customer's real Order rows - CRM-created and Shopify-synced alike.

export interface AbandonmentAddress {
  name: string | null;
  phone: string | null;
  line1: string | null;
  line2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
  /** Every available part in reading order, e.g. "12 MG Road, Near Station, Pune, Maharashtra, 411001, India". */
  formatted: string;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
const first = (r: Record<string, unknown>, ...keys: string[]) => keys.map((k) => text(r[k])).find((v) => v !== null) ?? null;

/** One tolerant reader for both stored shapes: the checkout snapshot's (line1/pincode) and an order's (line1|address1 / pincode|zip, state|province). Null when there is nothing usable. */
export function readAddress(value: unknown): AbandonmentAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const name = first(r, "name") ?? ([text(r.firstName ?? r.first_name), text(r.lastName ?? r.last_name)].filter(Boolean).join(" ") || null);
  const a = {
    name,
    phone: first(r, "phone"),
    line1: first(r, "line1", "address1", "line_1", "address_line_1", "address"),
    line2: first(r, "line2", "address2", "line_2", "address_line_2"),
    landmark: first(r, "landmark"),
    city: first(r, "city"),
    state: first(r, "state", "province"),
    pincode: first(r, "pincode", "zip", "postal_code", "postcode"),
    country: first(r, "country"),
  };
  const parts = [a.line1, a.line2, a.landmark, a.city, a.state, a.pincode, a.country].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return { ...a, formatted: parts.join(", ") };
}

export interface CustomerIdentity {
  id: string;
  firstName: string;
  normalizedMobile: string | null;
  normalizedEmail: string | null;
}

const PLACEHOLDER_NAME = /^shiprocket checkout lead$/i;
const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
const unknownName = (v: string) => norm(v) === "" || PLACEHOLDER_NAME.test(v.trim());

/**
 * Is `candidate` the same customer as `subject`? A lead id match is. Otherwise: the same e-mail is, and the same phone is - UNLESS something contradicts it (two different e-mails, or two
 * different first names), because one phone number can be shared by several people. A name that was never captured (the checkout placeholder) cannot contradict anything.
 */
export function isSameCustomer(subject: CustomerIdentity, candidate: CustomerIdentity): boolean {
  if (subject.id === candidate.id) return true;
  const sameEmail = Boolean(subject.normalizedEmail && candidate.normalizedEmail && subject.normalizedEmail === candidate.normalizedEmail);
  if (sameEmail) return true;
  const samePhone = Boolean(subject.normalizedMobile && candidate.normalizedMobile && subject.normalizedMobile === candidate.normalizedMobile);
  if (!samePhone) return false;
  if (subject.normalizedEmail && candidate.normalizedEmail && subject.normalizedEmail !== candidate.normalizedEmail) return false;
  if (unknownName(subject.firstName) || unknownName(candidate.firstName)) return true;
  return norm(subject.firstName) === norm(candidate.firstName);
}

export interface PreviousOrderItem {
  id: string;
  orderNumber: string;
  /** Shopify's own order name (#1234) for a synced order. */
  externalNumber: string | null;
  createdAt: Date;
  totalAmount: string;
  currency: string;
  status: string;
  paymentMode: "COD" | "PREPAID" | null;
  paymentStatus: string | null;
  /** Latest shipment status, when the order has been shipped. */
  fulfillmentStatus: string | null;
  /** Created in the CRM or synced from Shopify. */
  origin: "CRM" | "SHOPIFY";
  /** Free-text fulfilment state for an order known only from Shopify (e.g. "Fulfilled"), where there is no shipment row. */
  fulfillmentLabel?: string | null;
  /** The courier tracking, when the order has shipped with one. */
  tracking?: { number: string | null; company: string | null; url: string | null } | null;
  /** false = read live from Shopify and not (yet) a CRM order. Its link opens the live order page. */
  inCrm?: boolean;
}

export interface CustomerContext {
  addresses: {
    shipping: AbandonmentAddress | null;
    billing: AbandonmentAddress | null;
    /** Where `shipping` came from: the saved checkout, or the customer's latest order. */
    source: "CHECKOUT" | "LAST_ORDER" | null;
    /** The lead's own short location text ("City, State"): shown only when nothing fuller exists. */
    leadLocation: string | null;
  };
  /** `shopify`: whether the store's own order history was checked too (NOT_CHECKED = not asked). */
  previousOrders: {
    total: number;
    items: PreviousOrderItem[];
    shopify: LiveHistoryStatus | "NOT_CHECKED";
    /** A store customer was positively matched. With shopify OK: false = "searched, no such customer"; true + no items = "customer found, no orders". */
    shopifyCustomerFound: boolean;
    /** More store orders exist than were read. */
    shopifyTruncated: boolean;
    /** Different store customers that matched (> 1 with status AMBIGUOUS). */
    shopifyMatchCount: number;
  };
}

const MAX_PREVIOUS_ORDERS = 50;

type Db = Pick<Prisma.TransactionClient, "lead" | "order">;

export async function loadCustomerContext(db: Db, leadId: string, cartSnapshot: unknown, liveHistory: LiveHistoryClientFactory | null = null): Promise<CustomerContext> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, firstName: true, normalizedMobile: true, normalizedEmail: true, location: true } });
  const snapshot = cartSnapshot && typeof cartSnapshot === "object" ? (cartSnapshot as Record<string, unknown>) : {};
  const checkoutShipping = readAddress(snapshot.shippingAddress);
  const checkoutBilling = readAddress(snapshot.billingAddress);
  if (!lead) return { addresses: { shipping: checkoutShipping, billing: checkoutBilling, source: checkoutShipping ? "CHECKOUT" : null, leadLocation: null }, previousOrders: { total: 0, items: [], shopify: "NOT_CHECKED", shopifyCustomerFound: false, shopifyTruncated: false, shopifyMatchCount: 0 } };

  // Candidates share a phone or e-mail with this lead; isSameCustomer then decides which of them are really the same person.
  const or: Prisma.LeadWhereInput[] = [];
  if (lead.normalizedMobile) or.push({ normalizedMobile: lead.normalizedMobile });
  if (lead.normalizedEmail) or.push({ normalizedEmail: lead.normalizedEmail });
  const candidates = or.length > 0 ? await db.lead.findMany({ where: { OR: or }, select: { id: true, firstName: true, normalizedMobile: true, normalizedEmail: true }, take: 200 }) : [];
  const ids = [...new Set([lead.id, ...candidates.filter((c) => isSameCustomer(lead, c)).map((c) => c.id)])];

  const where: Prisma.OrderWhereInput = { leadId: { in: ids } };
  const [total, rows] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_PREVIOUS_ORDERS,
      select: {
        id: true, orderNumber: true, externalNumber: true, externalSource: true, externalId: true, createdAt: true, totalAmount: true, currency: true, status: true, shippingAddress: true,
        payments: { select: { status: true, method: true } },
        shipments: { select: { status: true, trackingNumber: true, courier: true, trackingUrl: true }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
  ]);

  // The store's own history (orders that never reached the CRM, or reached it under another lead). Failure never breaks the page.
  const live = liveHistory ? await loadLiveShopifyOrders(liveHistory, lead, new Set(rows.map((o) => o.externalId).filter((v): v is string => Boolean(v)))) : null;
  const liveItems = live?.items ?? [];

  const lastOrderAddress = checkoutShipping ? null : rows.map((o) => readAddress(o.shippingAddress)).find((a) => a !== null) ?? null;
  return {
    addresses: {
      shipping: checkoutShipping ?? lastOrderAddress,
      billing: checkoutBilling,
      source: checkoutShipping ? "CHECKOUT" : lastOrderAddress ? "LAST_ORDER" : null,
      leadLocation: lead.location,
    },
    previousOrders: {
      total: total + liveItems.length,
      shopify: live ? live.status : "NOT_CHECKED",
      shopifyCustomerFound: live?.customerFound ?? false,
      shopifyTruncated: live?.truncated ?? false,
      shopifyMatchCount: live?.matchCount ?? 0,
      items: [...rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        externalNumber: o.externalNumber,
        createdAt: o.createdAt,
        totalAmount: o.totalAmount.toString(),
        currency: o.currency,
        status: o.status,
        paymentMode: derivePaymentMode(o.payments),
        paymentStatus: derivePaymentStatus(o.payments),
        fulfillmentStatus: o.shipments[0]?.status ?? null,
        origin: o.externalSource ? ("SHOPIFY" as const) : ("CRM" as const),
        inCrm: true,
        tracking: o.shipments[0]?.trackingNumber ? { number: o.shipments[0].trackingNumber, company: o.shipments[0].courier, url: o.shipments[0].trackingUrl } : null,
      })), ...liveItems].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    },
  };
}
