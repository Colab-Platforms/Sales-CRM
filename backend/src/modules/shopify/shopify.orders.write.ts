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

export interface ShopifyOrderCreateLineItem {
  /** Shopify's own variant GID (the CRM's ProductVariant.externalId), for a cataloged, already
   *  Shopify-linked product/variant. */
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

  const order = {
    lineItems: input.lineItems.map((item) =>
      item.variantId
        ? { variantId: item.variantId, quantity: item.quantity }
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
