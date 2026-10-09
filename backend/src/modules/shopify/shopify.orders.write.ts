// Shopify Admin GraphQL order creation - a genuinely new write capability, entirely isolated from
// shopify.sync.ts/shopify.orders.ts (the read-only historical/webhook sync path): this file never
// imports them and neither imports this. It reuses ShopifyClient.query() as-is - that method is
// already a generic GraphQL executor (it just POSTs {query, variables}; GraphQL calls the JSON key
// "query" whether the document text is a `query` or a `mutation`), so no change to the client was
// needed to add a mutation.
//
// Requires the `write_orders` scope. Confirmed GRANTED on this project's live Shopify token via a
// read-only introspection query (currentAppInstallation.accessScopes) before any of this was
// written - never assumed from generic Shopify docs. The mutation's exact field shape
// (OrderCreateOrderInput/OrderCreateLineItemInput) is Shopify's own documented Admin API schema;
// this repo had no prior order-write code to mirror, since the sync path never writes to Shopify.
import { ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";

export class ShopifyOrderCreateError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "ShopifyOrderCreateError";
  }
}

/**
 * The one place a Shopify ProductVariant id is put into the shape orderCreate requires: a global id
 * ("gid://shopify/ProductVariant/<n>"). The CRM stores the catalog's variant ids NUMERIC (the sync strips the
 * "gid://..." prefix - see shopify.money.ts's gidToId), so a numeric id is converted here, at the integration
 * boundary; an id that is already a ProductVariant GID is returned unchanged.
 *
 * Anything else is refused BEFORE Shopify is called - in particular a GID of another type (e.g. a Product id) or a
 * non-numeric CRM id, which must never be silently turned into a variant id.
 */
export function toShopifyProductVariantGid(id: string): string {
  const value = String(id ?? "").trim();
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/ProductVariant/${value}`;
  throw new ShopifyOrderCreateError(`"${value.slice(0, 60)}" is not a valid Shopify product variant id (expected a numeric variant id or a gid://shopify/ProductVariant/<id>).`);
}

export interface ShopifyOrderCreateLineItem {
  /** A Shopify variant id of a cataloged, already Shopify-linked product/variant: the numeric id the CRM stores
   *  (ProductVariant.externalId) or an already-valid ProductVariant GID. Converted by toShopifyProductVariantGid. */
  variantId?: string;
  /** Used only when there is no variantId - a plain custom line item Shopify has never seen before.
   *  Requires priceAmount, since a custom line item has no catalog price to look up. */
  title?: string;
  quantity: number;
  priceAmount?: string;
}

export interface ShopifyOrderCreateShippingAddress {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

export interface ShopifyOrderCreateInput {
  lineItems: ShopifyOrderCreateLineItem[];
  email?: string;
  phone?: string;
  currency: string;
  /** COD (not yet collected) -> PENDING; already-collected prepaid -> PAID. Never invented beyond
   *  Shopify's own two relevant values for a freshly created order. */
  financialStatus: "PENDING" | "PAID";
  note?: string;
  shippingAddress?: ShopifyOrderCreateShippingAddress;
}

export interface ShopifyOrderCreateResult {
  /** Shopify's GID, e.g. "gid://shopify/Order/123456789" - the same shape Order.externalId already
   *  stores for a Shopify-synced order. */
  shopifyOrderId: string;
  /** e.g. "#1234" - the same shape Order.externalNumber already stores. */
  shopifyOrderName: string;
}

const ORDER_CREATE_MUTATION = `
  mutation crmOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name }
      userErrors { field message }
    }
  }
`;

interface OrderCreateResponse {
  orderCreate: {
    order: { id: string; name: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

export async function createShopifyOrder(client: ShopifyClient, input: ShopifyOrderCreateInput): Promise<ShopifyOrderCreateResult> {
  if (input.lineItems.length === 0) throw new ShopifyOrderCreateError("At least one line item is required");
  for (const item of input.lineItems) {
    if (!item.variantId && !item.title) throw new ShopifyOrderCreateError("Each line item needs either a Shopify variantId or a title");
    if (!item.variantId && item.title && !item.priceAmount) {
      throw new ShopifyOrderCreateError(`A custom line item ("${item.title}") needs a priceAmount`);
    }
  }

  // Resolved for every item up front, so an invalid id fails clearly before any request is built or sent.
  const order = {
    lineItems: input.lineItems.map((item) =>
      item.variantId
        ? { variantId: toShopifyProductVariantGid(item.variantId), quantity: item.quantity }
        : { title: item.title, quantity: item.quantity, priceSet: { shopMoney: { amount: item.priceAmount, currencyCode: input.currency } } },
    ),
    email: input.email,
    phone: input.phone,
    currency: input.currency,
    financialStatus: input.financialStatus,
    note: input.note,
    shippingAddress: input.shippingAddress,
  };

  let data: OrderCreateResponse;
  try {
    data = await client.query<OrderCreateResponse>(ORDER_CREATE_MUTATION, { order, options: { sendReceipt: false, sendFulfillmentReceipt: false } });
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyOrderCreateError(error.message, error);
    throw error;
  }

  const userErrors = data.orderCreate.userErrors;
  if (userErrors.length > 0) throw new ShopifyOrderCreateError(userErrors.map((e) => e.message).join("; "), userErrors);
  if (!data.orderCreate.order) throw new ShopifyOrderCreateError("Shopify did not return a created order");

  return { shopifyOrderId: data.orderCreate.order.id, shopifyOrderName: data.orderCreate.order.name };
}

// orderCancel - added for CRM order cancellation (Cancel/Revert). Same write scope (write_orders)
// as orderCreate above; no refund and no restock are requested here (the CRM never assumes a
// cancellation implies money moved or stock returned - see orders.service.ts's cancelOrder, which
// only ever changes Payment.refundedAt/refundedAmount when a real refund actually happened), and the
// customer is not emailed by Shopify itself since the CRM handles its own WhatsApp/customer comms.
export class ShopifyOrderCancelError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "ShopifyOrderCancelError";
  }
}

export interface ShopifyOrderCancelResult {
  shopifyOrderId: string;
  cancelledAt: string | null;
}

const ORDER_CANCEL_MUTATION = `
  mutation crmOrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean) {
    orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer) {
      job { id done }
      orderCancelUserErrors { field message }
    }
  }
`;

const ORDER_CANCEL_STATE_QUERY = `
  query crmOrderCancelState($id: ID!) {
    order(id: $id) { id cancelledAt }
  }
`;

interface OrderCancelResponse {
  orderCancel: {
    job: { id: string; done: boolean } | null;
    orderCancelUserErrors: { field: string[] | null; message: string }[];
  };
}

/** Cancels an already-created Shopify order by its GID (Order.externalId). Never refunds, never
 *  restocks, never emails the customer - the CRM makes those decisions separately, if at all. Shopify
 *  processes the cancel asynchronously (a job), so `cancelledAt` here is best-effort/not always set;
 *  the CRM's own Order.cancelledAt (set by the caller) is the authoritative timestamp either way. */
export async function cancelShopifyOrder(client: ShopifyClient, shopifyOrderId: string): Promise<ShopifyOrderCancelResult> {
  // Order.externalId is the canonical numeric id (or a legacy GID); orderCancel's $orderId: ID! needs the GID. toShopifyOrderGid is the ONE normalisation path: a numeric id
  // or an Order GID in, the GID out; anything else is refused here, before Shopify is called.
  let gid: string;
  try {
    gid = toShopifyOrderGid(shopifyOrderId);
  } catch (error) {
    throw new ShopifyOrderCancelError(error instanceof Error ? error.message : "Invalid Shopify order id");
  }

  // Idempotent retry: if Shopify already shows the order as cancelled (an earlier attempt got through, or someone cancelled it there), there is nothing left to do. A failed
  // read never blocks the cancellation itself - the mutation below reports any genuine error unchanged.
  try {
    const state = await client.query<{ order: { cancelledAt: string | null } | null }>(ORDER_CANCEL_STATE_QUERY, { id: gid });
    if (state?.order?.cancelledAt) return { shopifyOrderId, cancelledAt: state.order.cancelledAt };
  } catch {
    /* fall through to the mutation */
  }

  let data: OrderCancelResponse;
  try {
    data = await client.query<OrderCancelResponse>(ORDER_CANCEL_MUTATION, { orderId: gid, reason: "OTHER", refund: false, restock: false, notifyCustomer: false });
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyOrderCancelError(error.message, error);
    throw error;
  }

  const userErrors = data.orderCancel.orderCancelUserErrors;
  if (userErrors.length > 0) throw new ShopifyOrderCancelError(userErrors.map((e) => e.message).join("; "), userErrors);

  return { shopifyOrderId, cancelledAt: data.orderCancel.job?.done ? new Date().toISOString() : null };
}

// --- Payment reconciliation --------------------------------------------------------------------------------------
// Marks an EXISTING Shopify order's outstanding balance as paid, once the CRM's own Cashfree payment has settled.
// Never creates a second Shopify order (it takes the already-linked Order.externalId), never chooses an amount
// (orderMarkAsPaid just clears the order's own outstanding balance - the CRM never tells Shopify what was paid,
// so a partial/mismatched amount can never be forced through this call), and never issues a refund. Uses the same
// `write_orders` scope already confirmed granted for orderCreate/orderCancel above - no new scope needed.
export class ShopifyOrderMarkAsPaidError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "ShopifyOrderMarkAsPaidError";
  }
}

const ORDER_MARK_AS_PAID_MUTATION = `
  mutation crmOrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

interface OrderMarkAsPaidResponse {
  orderMarkAsPaid: {
    order: { id: string; displayFinancialStatus: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

export interface ShopifyOrderMarkAsPaidResult {
  shopifyOrderId: string;
  financialStatus: string | null;
}

/** Order.externalId is a full GID when the CRM itself created the Shopify order (createShopifyOrder returns the GID
 *  as-is), but a bare numeric id when the order instead came FROM Shopify sync (shopify.money.ts's gidToId strips the
 *  prefix on the way in). Both are valid here - only something that is neither is refused before Shopify is called. */
export function toShopifyOrderGid(id: string): string {
  const value = String(id ?? "").trim();
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Order/${value}`;
  throw new ShopifyOrderMarkAsPaidError(`"${value.slice(0, 60)}" is not a valid Shopify order id (expected a numeric order id or a gid://shopify/Order/<id>).`);
}

/** Idempotent from Shopify's own side: calling this again on an order already marked paid is a no-op (Shopify
 *  reports it already paid rather than erroring), so a retried reconciliation can never double-charge or duplicate
 *  anything. */
export async function markShopifyOrderPaid(client: ShopifyClient, shopifyOrderId: string): Promise<ShopifyOrderMarkAsPaidResult> {
  const gid = toShopifyOrderGid(shopifyOrderId);
  let data: OrderMarkAsPaidResponse;
  try {
    data = await client.query<OrderMarkAsPaidResponse>(ORDER_MARK_AS_PAID_MUTATION, { input: { id: gid } });
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyOrderMarkAsPaidError(error.message, error);
    throw error;
  }

  const userErrors = data.orderMarkAsPaid.userErrors;
  if (userErrors.length > 0) throw new ShopifyOrderMarkAsPaidError(userErrors.map((e) => e.message).join("; "), userErrors);

  return { shopifyOrderId, financialStatus: data.orderMarkAsPaid.order?.displayFinancialStatus ?? null };
}

// --- Order tags ---------------------------------------------------------------------------------------------------
// Additive tag edits on an EXISTING Shopify order (tagsAdd / tagsRemove touch only the tags named - they never replace
// the order's tag list, so VIP / COD / campaign tags are untouched). Both are idempotent on Shopify's side (adding a tag
// the order already has, or removing one it does not have, is a no-op). Same `write_orders` scope as the writes above
// (tagsAdd/tagsRemove on an Order need write_orders); reading the current tags needs read_orders, which the sync already uses.
export class ShopifyOrderTagError extends Error {
  constructor(
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "ShopifyOrderTagError";
  }
}

const ORDER_TAGS_QUERY = `
  query crmOrderTags($id: ID!) {
    order(id: $id) { id tags }
  }
`;
const TAGS_ADD_MUTATION = `
  mutation crmTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }
`;
const TAGS_REMOVE_MUTATION = `
  mutation crmTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }
`;

function orderGid(id: string): string {
  try {
    return toShopifyOrderGid(id);
  } catch (error) {
    throw new ShopifyOrderTagError(error instanceof Error ? error.message : "Invalid Shopify order id");
  }
}

async function runTagCall<T>(client: ShopifyClient, query: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await client.query<T>(query, variables);
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyOrderTagError(error.message, error);
    throw error;
  }
}

/** The order's current tags exactly as Shopify holds them. Throws if the order is not found. */
export async function getShopifyOrderTags(client: ShopifyClient, shopifyOrderId: string): Promise<string[]> {
  const data = await runTagCall<{ order: { id: string; tags: string[] } | null }>(client, ORDER_TAGS_QUERY, { id: orderGid(shopifyOrderId) });
  if (!data.order) throw new ShopifyOrderTagError("The Shopify order was not found.");
  return data.order.tags ?? [];
}

export async function addShopifyOrderTags(client: ShopifyClient, shopifyOrderId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const data = await runTagCall<{ tagsAdd: { userErrors: { message: string }[] } }>(client, TAGS_ADD_MUTATION, { id: orderGid(shopifyOrderId), tags });
  if (data.tagsAdd.userErrors.length > 0) throw new ShopifyOrderTagError(data.tagsAdd.userErrors.map((e) => e.message).join("; "), data.tagsAdd.userErrors);
}

export async function removeShopifyOrderTags(client: ShopifyClient, shopifyOrderId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const data = await runTagCall<{ tagsRemove: { userErrors: { message: string }[] } }>(client, TAGS_REMOVE_MUTATION, { id: orderGid(shopifyOrderId), tags });
  if (data.tagsRemove.userErrors.length > 0) throw new ShopifyOrderTagError(data.tagsRemove.userErrors.map((e) => e.message).join("; "), data.tagsRemove.userErrors);
}
