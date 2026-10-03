import { z } from "zod";
import { ShopifyApiError, type ShopifyClient } from "./shopify.client.js";
import { CONNECTION_QUERY, countQuery, ORDER_BY_ID_QUERY, ORDER_LIST_QUERY, ORDER_REFS_QUERY, type CountField } from "./shopify.queries.js";

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
  billingAddress: addressSchema.nullish(),
  shippingLine: z.object({ title: z.string().nullish() }).nullish(),
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
  billingAddress: NormalizedAddress | null;
  /** e.g. "Standard Shipping" - the rate name Shopify shows, not itself a currency amount
   *  (see amounts.shipping for the charge). Null when the order has no shipping line. */
  shippingMethod: string | null;
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

function normalizeAddress(address: z.infer<typeof addressSchema> | null | undefined): NormalizedAddress | null {
  if (!address) return null;
  return {
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
  };
}

// Shared by normalizeOrder() (the full per-order fetch) and normalizeOrderListNode() below (the
// lighter list fetch, which now also requests transactions/fulfillments - see ORDER_LIST_QUERY) so
// there is exactly one place that turns Shopify's raw transaction/fulfillment shape into the
// normalized one, never two slightly-different copies of the same mapping.
function normalizeTransactions(transactions: z.infer<typeof transactionSchema>[] | null | undefined): NormalizedTransaction[] {
  return (transactions ?? []).map((t) => ({
    id: t.id,
    kind: t.kind,
    status: t.status,
    gateway: t.gateway ?? null,
    amount: amountOf(t.amountSet),
    processedAt: t.processedAt ?? null,
    errorCode: t.errorCode ?? null,
    paymentId: t.paymentId ?? null,
    parentId: t.parentTransaction?.id ?? null,
  }));
}

function normalizeFulfillments(fulfillments: z.infer<typeof fulfillmentSchema>[] | null | undefined): NormalizedFulfillment[] {
  return (fulfillments ?? []).map((f) => ({
    id: f.id,
    status: f.status,
    displayStatus: f.displayStatus ?? null,
    createdAt: f.createdAt ?? null,
    deliveredAt: f.deliveredAt ?? null,
    trackingCompany: f.trackingInfo?.[0]?.company ?? null,
    trackingNumber: f.trackingInfo?.[0]?.number ?? null,
    trackingUrl: f.trackingInfo?.[0]?.url ?? null,
  }));
}

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
    shippingAddress: normalizeAddress(address),
    billingAddress: normalizeAddress(node.billingAddress),
    shippingMethod: node.shippingLine?.title ?? null,
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
    transactions: normalizeTransactions(node.transactions),
    fulfillments: normalizeFulfillments(node.fulfillments),
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

// ---- Live listing for display (Orders page) - a lighter shape than NormalizedOrder, fetched one
// page at a time directly from Shopify. Never stored; the CRM's own Order/Lead rows (already synced
// via webhooks/shopify.persist.ts) are joined on afterwards by whoever calls this, for the
// CRM-owned fields (salesperson, notes, lead number) this intentionally does not carry. ----

const orderListNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  processedAt: z.string().nullish(),
  cancelledAt: z.string().nullish(),
  displayFinancialStatus: z.string().nullish(),
  displayFulfillmentStatus: z.string().nullish(),
  returnStatus: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  paymentGatewayNames: z.array(z.string()).nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  customer: z.object({ firstName: z.string().nullish(), lastName: z.string().nullish(), email: z.string().nullish(), phone: z.string().nullish() }).nullish(),
  shippingLine: z.object({ title: z.string().nullish() }).nullish(),
  totalPriceSet: moneyBag.nullish(),
  totalRefundedSet: moneyBag.nullish(),
  // Same per-order data mapOrderStatus/mapPayments (shopify.mapper.ts) need, kept light - no per-item
  // pricing/addresses, which the list has no use for and would make one page's query far heavier.
  transactions: z.array(transactionSchema).nullish(),
  fulfillments: z.array(fulfillmentSchema).nullish(),
  lineItems: z.object({ nodes: z.array(z.object({ id: z.string() })) }).nullish(),
});

const orderListResponse = z.object({
  orders: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), hasPreviousPage: z.boolean(), startCursor: z.string().nullish(), endCursor: z.string().nullish() }),
    nodes: z.array(orderListNodeSchema),
  }),
});

export interface NormalizedOrderListItem {
  /** Shopify GID, e.g. "gid://shopify/Order/123456789". */
  id: string;
  /** Numeric Shopify order id, matching Order.externalId as already written by shopify.persist.ts (gidToId). */
  externalId: string;
  /** e.g. "#1002". */
  name: string;
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  returnStatus: string | null;
  tags: string[];
  paymentGateways: string[];
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  currency: string | null;
  totalAmount: string | null;
  refundedAmount: string | null;
  /** e.g. "Standard" - the Shopify shipping rate name, null when the order has no shipping line. */
  shippingMethod: string | null;
  /** True when at least one of this order's fulfillments has a real tracking number. */
  hasTracking: boolean;
  /** Light per-order data (no per-item pricing/addresses) needed to derive the exact same
   *  OrderStatus/PaymentStatus/PaymentMethod a real sync would produce - see
   *  shopify.mapper.ts's mapListOrderStatusAndPayments, the single place that interprets these. */
  transactions: NormalizedTransaction[];
  fulfillments: NormalizedFulfillment[];
  /** Number of line-item rows on the order (matches how the CRM's own Order._count.items counts
   *  them - distinct line items, not summed quantity). Capped at the 50 fetched - see ORDER_LIST_QUERY. */
  itemCount: number;
}

export interface LiveOrdersPage {
  items: NormalizedOrderListItem[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function normalizeOrderListNode(node: z.infer<typeof orderListNodeSchema>): NormalizedOrderListItem {
  const customer = node.customer ?? null;
  const firstName = customer?.firstName ?? null;
  const lastName = customer?.lastName ?? null;
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  const fulfillments = normalizeFulfillments(node.fulfillments);
  return {
    id: node.id,
    externalId: gidToIdLocal(node.id),
    name: node.name,
    createdAt: node.createdAt,
    processedAt: node.processedAt ?? null,
    cancelledAt: node.cancelledAt ?? null,
    financialStatus: node.displayFinancialStatus ?? null,
    fulfillmentStatus: node.displayFulfillmentStatus ?? null,
    returnStatus: node.returnStatus ?? null,
    tags: node.tags ?? [],
    paymentGateways: node.paymentGatewayNames ?? [],
    customerName: name || null,
    customerEmail: customer?.email ?? node.email ?? null,
    customerPhone: customer?.phone ?? node.phone ?? null,
    currency: node.totalPriceSet?.shopMoney.currencyCode ?? null,
    totalAmount: amountOf(node.totalPriceSet),
    refundedAmount: amountOf(node.totalRefundedSet),
    shippingMethod: node.shippingLine?.title ?? null,
    hasTracking: fulfillments.some((f) => Boolean(f.trackingNumber)),
    transactions: normalizeTransactions(node.transactions),
    fulfillments,
    itemCount: node.lineItems?.nodes.length ?? 0,
  };
}

// Deliberately not importing shopify.money.js's gidToId here to avoid a circular-looking extra import
// for one line - same trivial "last path segment" extraction, kept local to this list-only helper.
function gidToIdLocal(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

export interface LiveListParams {
  first: number;
  /** Relay cursor from a previous page's endCursor. The caller (orders.live.service.ts) tracks a
   *  stack of visited cursors client-side to support "Previous" without needing Shopify's separate
   *  last/before backward-pagination arguments. */
  after?: string | null;
  /** Shopify search syntax, e.g. windowSearch() plus a free-text term. */
  search?: string | null;
}

/** One page of orders with exactly the fields a list row needs, fetched live - never a per-row full fetch. */
export async function listOrdersForDisplay(client: ShopifyClient, params: LiveListParams): Promise<LiveOrdersPage> {
  const data = parseOrFail(
    orderListResponse,
    await client.query<unknown>(ORDER_LIST_QUERY, {
      first: params.first,
      after: params.after ?? null,
      query: params.search ?? null,
      sortKey: "CREATED_AT",
      reverse: true, // newest first, matching the existing CRM Orders list's default ordering
    }),
    "the order list",
  );
  return {
    items: data.orders.nodes.map(normalizeOrderListNode),
    hasNextPage: data.orders.pageInfo.hasNextPage,
    hasPreviousPage: data.orders.pageInfo.hasPreviousPage,
    startCursor: data.orders.pageInfo.startCursor ?? null,
    endCursor: data.orders.pageInfo.endCursor ?? null,
  };
}
