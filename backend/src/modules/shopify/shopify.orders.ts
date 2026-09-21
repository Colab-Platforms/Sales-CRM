import { z } from "zod";
import { ShopifyApiError, type ShopifyClient } from "./shopify.client.js";
import { CONNECTION_QUERY, countQuery, ORDER_BY_ID_QUERY, ORDER_REFS_QUERY, type CountField } from "./shopify.queries.js";

// ---- Shopify response shapes (only what we read) ----

const moneyBag = z.object({ shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }) });

const lineItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  variantTitle: z.string().nullish(),
  sku: z.string().nullish(),
  quantity: z.number(),
  originalUnitPriceSet: moneyBag.nullish(),
  discountAllocations: z.array(z.object({ allocatedAmountSet: moneyBag })).nullish(),
  taxLines: z.array(z.object({ priceSet: moneyBag.nullish() })).nullish(),
  product: z.object({ id: z.string() }).nullish(),
  variant: z.object({ id: z.string() }).nullish(),
});

const transactionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  gateway: z.string().nullish(),
  processedAt: z.string().nullish(),
  errorCode: z.string().nullish(),
  paymentId: z.string().nullish(),
  amountSet: moneyBag.nullish(),
  parentTransaction: z.object({ id: z.string() }).nullish(),
});

const fulfillmentSchema = z.object({
  id: z.string(),
  status: z.string(),
  displayStatus: z.string().nullish(),
  createdAt: z.string().nullish(),
  deliveredAt: z.string().nullish(),
  trackingInfo: z.array(z.object({ company: z.string().nullish(), number: z.string().nullish(), url: z.string().nullish() })).nullish(),
});

const addressSchema = z.object({
  name: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  address1: z.string().nullish(),
  address2: z.string().nullish(),
  city: z.string().nullish(),
  province: z.string().nullish(),
  provinceCode: z.string().nullish(),
  zip: z.string().nullish(),
  country: z.string().nullish(),
  countryCodeV2: z.string().nullish(),
  phone: z.string().nullish(),
});

export const orderNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  processedAt: z.string().nullish(),
  cancelledAt: z.string().nullish(),
  cancelReason: z.string().nullish(),
  currencyCode: z.string(),
  displayFinancialStatus: z.string().nullish(),
  displayFulfillmentStatus: z.string().nullish(),
  returnStatus: z.string().nullish(),
  taxesIncluded: z.boolean().nullish(),
  tags: z.array(z.string()).nullish(),
  paymentGatewayNames: z.array(z.string()).nullish(),
  discountCodes: z.array(z.string()).nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  customer: z
    .object({
      id: z.string(),
      firstName: z.string().nullish(),
      lastName: z.string().nullish(),
      email: z.string().nullish(),
      phone: z.string().nullish(),
    })
    .nullish(),
  shippingAddress: addressSchema.nullish(),
  subtotalPriceSet: moneyBag.nullish(),
  totalDiscountsSet: moneyBag.nullish(),
  totalTaxSet: moneyBag.nullish(),
  totalShippingPriceSet: moneyBag.nullish(),
  totalPriceSet: moneyBag.nullish(),
  totalRefundedSet: moneyBag.nullish(),
  lineItems: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(lineItemSchema) }),
  transactions: z.array(transactionSchema).nullish(),
  fulfillments: z.array(fulfillmentSchema).nullish(),
});

const orderByIdResponse = z.object({ order: orderNodeSchema.nullable() });

const refsResponse = (field: string) =>
  z.object({
    [field]: z.object({
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
      nodes: z.array(z.object({ id: z.string(), updatedAt: z.string() })),
    }),
  });

const connectionResponseSchema = z.object({
  shop: z.object({ name: z.string(), myshopifyDomain: z.string(), currencyCode: z.string(), ianaTimezone: z.string().nullish() }),
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});

// ---- Normalized shapes (what the mapper consumes) ----

export interface NormalizedItem {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /** Decimal string in the store currency, as sent by Shopify. */
  unitPrice: string | null;
  discounts: string[];
  taxes: string[];
  productId: string | null;
  variantId: string | null;
}

export interface NormalizedTransaction {
  id: string;
  kind: string;
  status: string;
  gateway: string | null;
  amount: string | null;
  processedAt: string | null;
  errorCode: string | null;
  paymentId: string | null;
  parentId: string | null;
}

export interface NormalizedFulfillment {
  id: string;
  status: string;
  displayStatus: string | null;
  /** When Shopify created the fulfilment record, i.e. when the parcel was shipped. */
  createdAt: string | null;
  deliveredAt: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

export interface NormalizedAddress {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  zip: string | null;
  country: string | null;
  countryCode: string | null;
  phone: string | null;
}

export interface NormalizedCustomer {
  /** Shopify customer id; null for guest checkouts. */
  id: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  /** Where the contact details came from. */
  source: "customer" | "order" | "none";
}

export interface NormalizedOrder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  currency: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  returnStatus: string | null;
  taxesIncluded: boolean | null;
  tags: string[];
  paymentGateways: string[];
  discountCodes: string[];
  customer: NormalizedCustomer;
  shippingAddress: NormalizedAddress | null;
  /** Decimal strings in the store currency. */
  amounts: {
    subtotal: string | null;
    discount: string | null;
    tax: string | null;
    shipping: string | null;
    total: string | null;
    refunded: string | null;
  };
  items: NormalizedItem[];
  transactions: NormalizedTransaction[];
  fulfillments: NormalizedFulfillment[];
  /** True when the order has more line items than were fetched. */
  itemsTruncated: boolean;
}

export interface ConnectionInfo {
  shopName: string;
  storeDomain: string;
  currency: string;
  /** The store's IANA time zone (e.g. "Asia/Kolkata"); calendar days in a sync window are read in it. */
  timeZone: string | null;
  scopes: string[];
}

export interface RecordCount {
  count: number;
  /** false when Shopify only knows a lower bound. */
  exact: boolean;
}

export interface RecordRef {
  id: string;
  updatedAt: string;
}

export interface RefsPage {
  refs: RecordRef[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const amountOf = (bag: z.infer<typeof moneyBag> | null | undefined) => bag?.shopMoney.amount ?? null;

export function normalizeOrder(node: z.infer<typeof orderNodeSchema>): NormalizedOrder {
  const customer = node.customer ?? null;
  const email = customer?.email ?? node.email ?? null;
  const phone = customer?.phone ?? node.phone ?? node.shippingAddress?.phone ?? null;
  const address = node.shippingAddress ?? null;

  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    processedAt: node.processedAt ?? null,
    cancelledAt: node.cancelledAt ?? null,
    cancelReason: node.cancelReason ?? null,
    currency: node.currencyCode,
    financialStatus: node.displayFinancialStatus ?? null,
    fulfillmentStatus: node.displayFulfillmentStatus ?? null,
    returnStatus: node.returnStatus ?? null,
    taxesIncluded: node.taxesIncluded ?? null,
    tags: node.tags ?? [],
    paymentGateways: node.paymentGatewayNames ?? [],
    discountCodes: node.discountCodes ?? [],
    customer: {
      id: customer?.id ?? null,
      firstName: customer?.firstName ?? address?.firstName ?? null,
      lastName: customer?.lastName ?? address?.lastName ?? null,
      email,
      phone,
      source: customer ? "customer" : email || phone ? "order" : "none",
    },
    shippingAddress: address && {
      name: address.name ?? null,
      firstName: address.firstName ?? null,
      lastName: address.lastName ?? null,
      address1: address.address1 ?? null,
      address2: address.address2 ?? null,
      city: address.city ?? null,
      province: address.province ?? null,
      provinceCode: address.provinceCode ?? null,
      zip: address.zip ?? null,
      country: address.country ?? null,
      countryCode: address.countryCodeV2 ?? null,
      phone: address.phone ?? null,
    },
    amounts: {
      subtotal: amountOf(node.subtotalPriceSet),
      discount: amountOf(node.totalDiscountsSet),
      tax: amountOf(node.totalTaxSet),
      shipping: amountOf(node.totalShippingPriceSet),
      total: amountOf(node.totalPriceSet),
      refunded: amountOf(node.totalRefundedSet),
    },
    items: node.lineItems.nodes.map((item) => ({
      id: item.id,
      title: item.title,
      variantTitle: item.variantTitle ?? null,
      sku: item.sku ?? null,
      quantity: item.quantity,
      unitPrice: amountOf(item.originalUnitPriceSet),
      discounts: (item.discountAllocations ?? []).map((d) => d.allocatedAmountSet.shopMoney.amount),
      taxes: (item.taxLines ?? []).map((t) => amountOf(t.priceSet) ?? "0"),
      productId: item.product?.id ?? null,
      variantId: item.variant?.id ?? null,
    })),
    transactions: (node.transactions ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      gateway: t.gateway ?? null,
      amount: amountOf(t.amountSet),
      processedAt: t.processedAt ?? null,
      errorCode: t.errorCode ?? null,
      paymentId: t.paymentId ?? null,
      parentId: t.parentTransaction?.id ?? null,
    })),
    fulfillments: (node.fulfillments ?? []).map((f) => ({
      id: f.id,
      status: f.status,
      displayStatus: f.displayStatus ?? null,
      createdAt: f.createdAt ?? null,
      deliveredAt: f.deliveredAt ?? null,
      trackingCompany: f.trackingInfo?.[0]?.company ?? null,
      trackingNumber: f.trackingInfo?.[0]?.number ?? null,
      trackingUrl: f.trackingInfo?.[0]?.url ?? null,
    })),
    itemsTruncated: node.lineItems.pageInfo.hasNextPage,
  };
}

// A malformed response is reported by field path and rule only; values are never echoed.
export function parseOrFail<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new ShopifyApiError(`Shopify returned ${what} in an unexpected shape:\n  - ${problems.join("\n  - ")}`);
}

// ---- Fetching (read-only) ----

export async function checkConnection(client: ShopifyClient): Promise<ConnectionInfo> {
  const data = parseOrFail(connectionResponseSchema, await client.query<unknown>(CONNECTION_QUERY), "the shop details");
  return {
    shopName: data.shop.name,
    storeDomain: data.shop.myshopifyDomain,
    currency: data.shop.currencyCode,
    timeZone: data.shop.ianaTimezone ?? null,
    scopes: data.currentAppInstallation.accessScopes.map((s) => s.handle).sort(),
  };
}

export interface ListParams {
  first: number;
  after?: string | null;
  /** Shopify search syntax, e.g. from windowSearch(). */
  search?: string | null;
  /** Default CREATED_AT. The walk is always oldest-first. */
  sortKey?: "CREATED_AT" | "UPDATED_AT";
}

/** One page of light order references, oldest first. */
export async function listOrderRefs(client: ShopifyClient, params: ListParams): Promise<RefsPage> {
  return listRefs(client, ORDER_REFS_QUERY, "orders", params);
}

export async function listRefs(
  client: ShopifyClient,
  document: string,
  field: CountField,
  params: ListParams,
): Promise<RefsPage> {
  const data = parseOrFail(
    refsResponse(field),
    await client.query<unknown>(document, {
      first: params.first,
      after: params.after ?? null,
      query: params.search ?? null,
      sortKey: params.sortKey ?? "CREATED_AT",
      reverse: false,
    }),
    `the ${field} list`,
  ) as Record<string, { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: RecordRef[] }>;

  const page = data[field];
  return { refs: page.nodes, hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor ?? null };
}

const countResponse = z.object({ result: z.object({ count: z.number(), precision: z.string() }) });

/** How many records match a search. One cheap request; nothing is downloaded. */
export async function countRecords(client: ShopifyClient, field: CountField, search: string | null): Promise<RecordCount> {
  const data = parseOrFail(countResponse, await client.query<unknown>(countQuery(field), { query: search }), `the ${field} count`);
  return { count: data.result.count, exact: data.result.precision === "EXACT" };
}

/** The full order, or null if Shopify no longer has it. */
export async function fetchOrder(client: ShopifyClient, gid: string): Promise<NormalizedOrder | null> {
  const data = parseOrFail(orderByIdResponse, await client.query<unknown>(ORDER_BY_ID_QUERY, { id: gid }), "the order");
  return data.order ? normalizeOrder(data.order) : null;
}
