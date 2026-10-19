import { normalizeMobile } from "@/lib/leadIdentity.js";
import { logger } from "@/utils/logger.js";
import { ShopifyClient, ShopifyApiError } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { listCustomersForDisplay, type NormalizedCustomerListItem } from "../shopify/shopify.customers.js";
import { listOrdersForDisplay, type NormalizedOrderListItem } from "../shopify/shopify.orders.js";
import { mapListOrderStatusAndPayments } from "../shopify/shopify.mapper.js";
import { derivePaymentMode, derivePaymentStatus } from "../orders/orders.filters.js";
import { LIVE_ORDER_ID_PREFIX } from "../orders/orders.live.types.js";
import type { PreviousOrderItem } from "./abandonment.customer-context.js";

// Why an abandoned checkout lead showed no earlier orders: the CRM's own Order table only holds orders that were created in the CRM or already synced from Shopify. A customer who
// bought on the store earlier, and whose order never reached the CRM (or reached it under a different lead), has their history ONLY in Shopify. This looks it up live - the same
// read-only calls the Orders and Customers pages already make - and merges it with the CRM rows. Nothing here writes to Shopify or to the database.

/** E-mail addresses a checkout provider invents when the shopper gave none (Shiprocket Checkout / Fastrr: "<phone>@fastrr.com"). They identify nobody. */
const GENERATED_EMAIL_DOMAINS = new Set(["fastrr.com", "shiprocket.in", "shiprocket.co", "shiprocketcheckout.com"]);

export function isGeneratedEmail(email: string | null | undefined, mobile?: string | null): boolean {
  if (!email) return true;
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  if (!domain) return true;
  if (GENERATED_EMAIL_DOMAINS.has(domain)) return true;
  // "<digits>@anything" where the digits ARE the phone number is a placeholder too.
  const digits = local.replace(/\D/g, "");
  const phone = (mobile ?? "").replace(/\D/g, "");
  return Boolean(digits.length >= 8 && phone.length >= 8 && phone.endsWith(digits.slice(-10)));
}

/** OK = the store was searched (a customer may or may not have been found - see `customerFound`); AMBIGUOUS = several different store customers match, so none is used. */
export type LiveHistoryStatus = "OK" | "NOT_CONFIGURED" | "UNAVAILABLE" | "AMBIGUOUS";

export interface LiveHistoryResult {
  status: LiveHistoryStatus;
  items: PreviousOrderItem[];
  /** Shopify orders that were NOT already in the CRM list (what was added). */
  added: number;
  /** A store customer was positively matched (phone / real e-mail). false + OK = "searched, no such customer". */
  customerFound: boolean;
  /** More orders exist than were read (the page cap was reached). */
  truncated: boolean;
  /** How many different store customers matched (> 1 = AMBIGUOUS). */
  matchCount: number;
}

const NONE = (status: LiveHistoryStatus, extra: Partial<LiveHistoryResult> = {}): LiveHistoryResult => ({ status, items: [], added: 0, customerFound: false, truncated: false, matchCount: 0, ...extra });

export interface LiveHistoryClient {
  /** Shopify customers whose phone/e-mail search hits. */
  findCustomers(search: string): Promise<NormalizedCustomerListItem[]>;
  /** ALL of the customer's orders, page by page, newest first (up to the cap). */
  ordersOfCustomer(customerExternalId: string): Promise<{ items: NormalizedOrderListItem[]; truncated: boolean }>;
}

const MAX_CUSTOMERS = 3;
const PAGE_SIZE = 50;
const MAX_PAGES = 6; // 300 orders; beyond that the page says so instead of silently stopping
const quoted = (v: string) => `"${v.replace(/"/g, '\\"')}"`;

export function shopifyHistoryClient(client: ShopifyClient): LiveHistoryClient {
  return {
    async findCustomers(search) {
      return (await listCustomersForDisplay(client, { first: 5, search })).items;
    },
    async ordersOfCustomer(id) {
      const items: NormalizedOrderListItem[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res = await listOrdersForDisplay(client, { first: PAGE_SIZE, after, search: `customer_id:${id}` });
        items.push(...res.items);
        if (!res.hasNextPage || !res.endCursor) return { items, truncated: false };
        after = res.endCursor;
      }
      return { items, truncated: true };
    },
  };
}

/** The client is only created when asked for, so a missing Shopify configuration is a normal "not configured" answer rather than an error at start-up. */
export type LiveHistoryClientFactory = () => LiveHistoryClient;
export const defaultLiveHistoryClient: LiveHistoryClientFactory = () => shopifyHistoryClient(new ShopifyClient(loadShopifyConfig()));

const sameDigits = (a: string | null | undefined, b: string | null) => {
  const n = normalizeMobile(a ?? null);
  return Boolean(n && b && n === b);
};

/**
 * A Shopify customer is "the same person" as the lead only on a VERIFIED signal:
 *  - the customer's own phone normalises to the lead's phone, or
 *  - the customer's e-mail equals the lead's REAL e-mail (never a generated one) and the customer's phone, if it has one, is not a different number.
 * Names and addresses alone never match.
 */
export function verifiedCustomers(lead: { normalizedMobile: string | null; normalizedEmail: string | null }, candidates: NormalizedCustomerListItem[]): NormalizedCustomerListItem[] {
  const realEmail = lead.normalizedEmail && !isGeneratedEmail(lead.normalizedEmail, lead.normalizedMobile) ? lead.normalizedEmail : null;
  const out: NormalizedCustomerListItem[] = [];
  for (const c of candidates) {
    const phoneMatch = sameDigits(c.phone, lead.normalizedMobile);
    const customerPhone = normalizeMobile(c.phone);
    const emailMatch = Boolean(realEmail && c.email && c.email.trim().toLowerCase() === realEmail && (!customerPhone || customerPhone === lead.normalizedMobile));
    if ((phoneMatch || emailMatch) && !out.some((o) => o.externalId === c.externalId)) out.push(c);
  }
  return out.slice(0, MAX_CUSTOMERS);
}

function toItem(o: NormalizedOrderListItem): PreviousOrderItem {
  const { status, payments } = mapListOrderStatusAndPayments({
    id: o.id,
    currency: o.currency ?? "INR",
    cancelledAt: o.cancelledAt,
    financialStatus: o.financialStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    returnStatus: o.returnStatus,
    fulfillments: o.fulfillments,
    tags: o.tags,
    paymentGateways: o.paymentGateways,
    transactions: o.transactions,
    amounts: { subtotal: null, discount: null, tax: null, shipping: null, total: o.totalAmount, refunded: o.refundedAmount },
    processedAt: o.processedAt,
    updatedAt: o.createdAt,
  });
  const shipped = o.fulfillments.find((f) => f.trackingNumber) ?? null;
  return {
    id: `${LIVE_ORDER_ID_PREFIX}${o.externalId}`,
    orderNumber: o.name,
    externalNumber: o.name,
    createdAt: new Date(o.createdAt),
    totalAmount: o.totalAmount ?? "0",
    currency: o.currency ?? "INR",
    status,
    paymentMode: derivePaymentMode(payments),
    paymentStatus: derivePaymentStatus(payments),
    fulfillmentStatus: null,
    fulfillmentLabel: o.fulfillments[0]?.displayStatus ?? o.fulfillmentStatus ?? null,
    tracking: shipped ? { number: shipped.trackingNumber, company: shipped.trackingCompany, url: shipped.trackingUrl } : null,
    origin: "SHOPIFY",
    inCrm: false,
  };
}

/**
 * The lead's earlier orders from Shopify, minus the ones the CRM already lists. `crmExternalIds` is every Shopify order id found in the CRM rows (so an order is never listed twice,
 * and an order already synced keeps its CRM link).
 */
export async function loadLiveShopifyOrders(
  getClient: LiveHistoryClientFactory,
  lead: { normalizedMobile: string | null; normalizedEmail: string | null },
  crmExternalIds: ReadonlySet<string>,
): Promise<LiveHistoryResult> {
  const realEmail = lead.normalizedEmail && !isGeneratedEmail(lead.normalizedEmail, lead.normalizedMobile) ? lead.normalizedEmail : null;
  const terms: string[] = [];
  if (lead.normalizedMobile) terms.push(`phone:${quoted(lead.normalizedMobile)}`);
  if (realEmail) terms.push(`email:${quoted(realEmail)}`);
  if (terms.length === 0) return NONE("OK");

  let client: LiveHistoryClient;
  try {
    client = getClient();
  } catch (error) {
    if (error instanceof ShopifyConfigError) return NONE("NOT_CONFIGURED");
    logger.error("Shopify history: client could not be created", error instanceof Error ? error.message : String(error));
    return NONE("UNAVAILABLE");
  }

  const cacheKey = `${lead.normalizedMobile ?? ""}|${realEmail ?? ""}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return withoutCrm(hit, crmExternalIds);

  try {
    const customers = verifiedCustomers(lead, await client.findCustomers(terms.join(" OR ")));
    // Phone and e-mail naming DIFFERENT store customers (or two customers on one phone) is not resolved by guessing: no history is attached, and the page says why.
    if (customers.length > 1) {
      const ambiguous = { items: [], customerFound: false, truncated: false, matchCount: customers.length, ambiguous: true, expiresAt: Date.now() + CACHE_TTL_MS };
      cache.set(cacheKey, ambiguous);
      return withoutCrm(ambiguous, crmExternalIds);
    }
    const all: { externalId: string; item: PreviousOrderItem }[] = [];
    let truncated = false;
    const [customer] = customers;
    if (customer) {
      const fetched = await client.ordersOfCustomer(customer.externalId);
      truncated = fetched.truncated;
      const seen = new Set<string>();
      for (const order of fetched.items) {
        if (seen.has(order.externalId)) continue;
        seen.add(order.externalId);
        all.push({ externalId: order.externalId, item: toItem(order) });
      }
    }
    const entry = { items: all, customerFound: Boolean(customer), truncated, matchCount: customers.length, ambiguous: false, expiresAt: Date.now() + CACHE_TTL_MS };
    cache.set(cacheKey, entry);
    return withoutCrm(entry, crmExternalIds);
  } catch (error) {
    // A failed lookup is reported as a failure - never as "no orders". Failures are not cached, so the next view retries.
    logger.error("Shopify history lookup failed", error instanceof ShopifyApiError ? error.message : error instanceof Error ? error.message : String(error));
    return NONE("UNAVAILABLE");
  }
}

const CACHE_TTL_MS = 60_000;
interface CacheEntry { items: { externalId: string; item: PreviousOrderItem }[]; customerFound: boolean; truncated: boolean; matchCount: number; ambiguous: boolean; expiresAt: number }
const cache = new Map<string, CacheEntry>();
/** Test helper: forget cached lookups. */
export const clearLiveHistoryCache = () => cache.clear();

function withoutCrm(entry: CacheEntry, crmExternalIds: ReadonlySet<string>): LiveHistoryResult {
  const items = entry.items.filter((o) => !crmExternalIds.has(o.externalId)).map((o) => o.item).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return { status: entry.ambiguous ? "AMBIGUOUS" : "OK", items, added: items.length, customerFound: entry.customerFound, truncated: entry.truncated, matchCount: entry.matchCount };
}
