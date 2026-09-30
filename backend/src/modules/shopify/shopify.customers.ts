import { z } from "zod";
import type { ShopifyClient } from "./shopify.client.js";
import { CUSTOMER_LIST_QUERY } from "./shopify.queries.js";
import { parseOrFail } from "./shopify.orders.js";

// Live Shopify customer listing/lookup - the Customers-page and Customer-360 analog of
// shopify.orders.ts's listOrdersForDisplay. Read-only, same ShopifyClient, no second GraphQL client.

const addressSchema = z.object({
  address1: z.string().nullish(),
  address2: z.string().nullish(),
  city: z.string().nullish(),
  province: z.string().nullish(),
  zip: z.string().nullish(),
  country: z.string().nullish(),
});

const customerListNodeSchema = z.object({
  id: z.string(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  numberOfOrders: z.union([z.string(), z.number()]).nullish(),
  amountSpent: z.object({ amount: z.string(), currencyCode: z.string() }).nullish(),
  defaultAddress: addressSchema.nullish(),
});

const customerListResponse = z.object({
  customers: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), hasPreviousPage: z.boolean(), startCursor: z.string().nullish(), endCursor: z.string().nullish() }),
    nodes: z.array(customerListNodeSchema),
  }),
});

export interface NormalizedCustomerListItem {
  /** Shopify GID, e.g. "gid://shopify/Customer/123456789". */
  id: string;
  /** Numeric Shopify customer id, same "last path segment" convention as Order.externalId. */
  externalId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  numberOfOrders: number | null;
  amountSpent: { amount: string; currencyCode: string } | null;
  address: { city: string | null; province: string | null; country: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LiveCustomersPage {
  items: NormalizedCustomerListItem[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function gidToIdLocal(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function normalizeCustomerListNode(node: z.infer<typeof customerListNodeSchema>): NormalizedCustomerListItem {
  const name = [node.firstName, node.lastName].filter(Boolean).join(" ").trim();
  return {
    id: node.id,
    externalId: gidToIdLocal(node.id),
    name: name || null,
    email: node.email ?? null,
    phone: node.phone ?? null,
    numberOfOrders: node.numberOfOrders != null ? Number(node.numberOfOrders) : null,
    amountSpent: node.amountSpent ? { amount: node.amountSpent.amount, currencyCode: node.amountSpent.currencyCode } : null,
    address: node.defaultAddress ? { city: node.defaultAddress.city ?? null, province: node.defaultAddress.province ?? null, country: node.defaultAddress.country ?? null } : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export interface LiveCustomerListParams {
  first: number;
  after?: string | null;
  /** Shopify search syntax - free text, or field-scoped like `email:foo@bar.com`. */
  search?: string | null;
}

/** One page of customers with exactly the fields a list row needs, fetched live. */
export async function listCustomersForDisplay(client: ShopifyClient, params: LiveCustomerListParams): Promise<LiveCustomersPage> {
  const data = parseOrFail(
    customerListResponse,
    await client.query<unknown>(CUSTOMER_LIST_QUERY, {
      first: params.first,
      after: params.after ?? null,
      query: params.search ?? null,
      sortKey: "CREATED_AT",
      reverse: true,
    }),
    "the customer list",
  );
  return {
    items: data.customers.nodes.map(normalizeCustomerListNode),
    hasNextPage: data.customers.pageInfo.hasNextPage,
    hasPreviousPage: data.customers.pageInfo.hasPreviousPage,
    startCursor: data.customers.pageInfo.startCursor ?? null,
    endCursor: data.customers.pageInfo.endCursor ?? null,
  };
}

// Escapes a value for Shopify's search-query mini-language (wraps in quotes, escapes embedded quotes) -
// mobile/email values can contain characters (+, spaces) that would otherwise break field-scoped search.
function quoted(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Best-effort match of a CRM lead's contact details to a Shopify customer, for the Customer 360
 *  overlay - not a sync/dedupe operation, just a live lookup. Returns the first match, if any. */
export async function findCustomerByContact(client: ShopifyClient, contact: { mobile?: string | null; email?: string | null }): Promise<NormalizedCustomerListItem | null> {
  const terms: string[] = [];
  if (contact.email) terms.push(`email:${quoted(contact.email)}`);
  if (contact.mobile) terms.push(`phone:${quoted(contact.mobile)}`);
  if (terms.length === 0) return null;

  const page = await listCustomersForDisplay(client, { first: 1, search: terms.join(" OR ") });
  return page.items[0] ?? null;
}
