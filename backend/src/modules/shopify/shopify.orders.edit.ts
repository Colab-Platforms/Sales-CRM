import { ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";
import { toCents } from "./shopify.money.js";
import { toShopifyOrderGid, type ShopifyOrderCreateAddress } from "./shopify.orders.write.js";

// Editing an EXISTING Shopify order from the CRM: swapping a line's flavour (variant) and changing the shipping address. Both use Shopify's documented, supported mutations:
//   flavour  - the order EDIT workflow: orderEditBegin -> orderEditSetQuantity (old line to 0) -> orderEditAddVariant (new variant, same quantity) -> orderEditCommit (needs write_order_edits)
//   address  - orderUpdate with a MailingAddressInput (needs write_orders); the billing address is not part of this input and stays as it is.
// Nothing here charges, refunds or changes a payment: the flavour swap is committed only when the staged order total is EXACTLY the current total (the caller has already refused any price difference), the
// customer is never notified, and every change is read back from Shopify so a 200 that did not stick is reported. No second order is created.

export class ShopifyOrderEditError extends Error {
  constructor(message: string, readonly step: string, readonly raw?: unknown) {
    super(message);
    this.name = "ShopifyOrderEditError";
  }
}

type UserErrors = { field: string[] | null; message: string }[];
async function run<T>(client: Pick<ShopifyClient, "query">, step: string, query: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await client.query<T>(query, variables);
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyOrderEditError(error.message, step, error);
    throw error;
  }
}
const failIfErrors = (step: string, errors: UserErrors | undefined | null) => {
  if (errors && errors.length > 0) throw new ShopifyOrderEditError(errors.map((e) => e.message).join("; "), step, errors);
};

export interface EditableLine {
  /** The order line item's GID. */
  id: string;
  quantity: number;
  variantId: string | null;
  productId: string | null;
  unitPriceCents: number;
}
export interface EditableOrder {
  id: string;
  cancelledAt: string | null;
  /** Shopify's displayFulfillmentStatus, e.g. UNFULFILLED, PARTIALLY_FULFILLED, FULFILLED. */
  fulfillmentStatus: string | null;
  totalCents: number;
  lines: EditableLine[];
  shippingAddress: { firstName: string | null; lastName: string | null; address1: string | null; address2: string | null; city: string | null; provinceCode: string | null; zip: string | null; countryCodeV2: string | null; phone: string | null } | null;
}

const ORDER_QUERY = `
  query crmOrderForEdit($id: ID!) {
    order(id: $id) {
      id
      cancelledAt
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount } }
      lineItems(first: 100) { nodes { id quantity variant { id product { id } } originalUnitPriceSet { shopMoney { amount } } } }
      shippingAddress { firstName lastName address1 address2 city provinceCode zip countryCodeV2 phone }
    }
  }
`;
interface OrderQueryResponse {
  order: {
    id: string;
    cancelledAt: string | null;
    displayFulfillmentStatus: string | null;
    currentTotalPriceSet: { shopMoney: { amount: string } };
    lineItems: { nodes: { id: string; quantity: number; variant: { id: string; product: { id: string } | null } | null; originalUnitPriceSet: { shopMoney: { amount: string } } }[] };
    shippingAddress: EditableOrder["shippingAddress"];
  } | null;
}

export async function readEditableOrder(client: Pick<ShopifyClient, "query">, shopifyOrderId: string): Promise<EditableOrder> {
  const data = await run<OrderQueryResponse>(client, "read_order", ORDER_QUERY, { id: toShopifyOrderGid(shopifyOrderId) });
  if (!data.order) throw new ShopifyOrderEditError("Shopify no longer has this order.", "read_order");
  const o = data.order;
  return {
    id: o.id,
    cancelledAt: o.cancelledAt,
    fulfillmentStatus: o.displayFulfillmentStatus,
    totalCents: toCents(o.currentTotalPriceSet.shopMoney.amount),
    lines: o.lineItems.nodes.map((l) => ({ id: l.id, quantity: l.quantity, variantId: l.variant?.id ?? null, productId: l.variant?.product?.id ?? null, unitPriceCents: toCents(l.originalUnitPriceSet.shopMoney.amount) })),
    shippingAddress: o.shippingAddress,
  };
}

const VARIANT_QUERY = `
  query crmVariantForEdit($id: ID!) { productVariant(id: $id) { id price product { id } } }
`;
export interface ShopifyVariantInfo { id: string; priceCents: number; productId: string | null }
export async function readVariant(client: Pick<ShopifyClient, "query">, variantGid: string): Promise<ShopifyVariantInfo | null> {
  const data = await run<{ productVariant: { id: string; price: string; product: { id: string } | null } | null }>(client, "read_variant", VARIANT_QUERY, { id: variantGid });
  return data.productVariant ? { id: data.productVariant.id, priceCents: toCents(data.productVariant.price), productId: data.productVariant.product?.id ?? null } : null;
}

const EDIT_BEGIN = `
  mutation crmFlavourEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id lineItems(first: 100) { nodes { id quantity variant { id } } } }
      userErrors { field message }
    }
  }
`;
const EDIT_SET_QUANTITY = `
  mutation crmFlavourEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: true) {
      calculatedOrder { id totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }
`;
const EDIT_ADD_VARIANT = `
  mutation crmFlavourEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
      calculatedOrder { id totalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }
`;
const EDIT_COMMIT = `
  mutation crmFlavourEditCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
      order { id }
      userErrors { field message }
    }
  }
`;

export interface SwapVariantInput {
  /** The Shopify line item (GID) to replace and the variant it currently holds. */
  lineItemId: string;
  oldVariantId: string;
  newVariantId: string;
  quantity: number;
  /** The order total that must be unchanged by the swap (cents). */
  expectedTotalCents: number;
  staffNote: string;
}

/** Replaces one line's variant with another, keeping its quantity, and commits only if the order total is unchanged. Re-reads the order afterwards to confirm. */
export async function swapOrderLineVariant(client: Pick<ShopifyClient, "query">, shopifyOrderId: string, input: SwapVariantInput): Promise<EditableOrder> {
  const gid = toShopifyOrderGid(shopifyOrderId);
  const begun = await run<{ orderEditBegin: { calculatedOrder: { id: string; lineItems: { nodes: { id: string; quantity: number; variant: { id: string } | null }[] } } | null; userErrors: UserErrors } }>(client, "edit_begin", EDIT_BEGIN, { id: gid });
  failIfErrors("edit_begin", begun.orderEditBegin.userErrors);
  const calculated = begun.orderEditBegin.calculatedOrder;
  if (!calculated) throw new ShopifyOrderEditError("Shopify did not open an order edit.", "edit_begin");
  const line = calculated.lineItems.nodes.find((l) => l.variant?.id === input.oldVariantId && l.quantity === input.quantity);
  if (!line) throw new ShopifyOrderEditError("The line to change was not found on the Shopify order (it may already have been edited).", "edit_begin");

  const removed = await run<{ orderEditSetQuantity: { userErrors: UserErrors } }>(client, "edit_set_quantity", EDIT_SET_QUANTITY, { id: calculated.id, lineItemId: line.id, quantity: 0 });
  failIfErrors("edit_set_quantity", removed.orderEditSetQuantity.userErrors);
  const added = await run<{ orderEditAddVariant: { calculatedOrder: { totalPriceSet: { shopMoney: { amount: string } } } | null; userErrors: UserErrors } }>(client, "edit_add_variant", EDIT_ADD_VARIANT, { id: calculated.id, variantId: input.newVariantId, quantity: input.quantity });
  failIfErrors("edit_add_variant", added.orderEditAddVariant.userErrors);
  const staged = added.orderEditAddVariant.calculatedOrder ? toCents(added.orderEditAddVariant.calculatedOrder.totalPriceSet.shopMoney.amount) : null;
  // Nothing is committed unless the swap leaves the order total exactly as it was: no silent extra charge, no silent credit. An uncommitted edit is simply discarded by Shopify.
  if (staged === null || staged !== input.expectedTotalCents) {
    throw new ShopifyOrderEditError(`The change would alter the order total (Shopify would show ${staged === null ? "an unknown total" : (staged / 100).toFixed(2)} instead of ${(input.expectedTotalCents / 100).toFixed(2)}), so it was not applied.`, "edit_check");
  }
  const committed = await run<{ orderEditCommit: { userErrors: UserErrors } }>(client, "edit_commit", EDIT_COMMIT, { id: calculated.id, staffNote: input.staffNote.slice(0, 255) });
  failIfErrors("edit_commit", committed.orderEditCommit.userErrors);

  const after = await readEditableOrder(client, shopifyOrderId);
  const stillOld = after.lines.some((l) => l.variantId === input.oldVariantId && l.quantity === input.quantity);
  const hasNew = after.lines.some((l) => l.variantId === input.newVariantId && l.quantity === input.quantity);
  if (!hasNew || (stillOld && input.oldVariantId !== input.newVariantId)) throw new ShopifyOrderEditError("Shopify accepted the edit but the order does not show the new flavour.", "verify");
  if (after.totalCents !== input.expectedTotalCents) throw new ShopifyOrderEditError("Shopify accepted the edit but the order total changed.", "verify");
  return after;
}

const ORDER_UPDATE = `
  mutation crmOrderShippingAddressUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

/** Sets the order's shipping address (the billing address is untouched) and reads it back. */
export async function updateOrderShippingAddress(client: Pick<ShopifyClient, "query">, shopifyOrderId: string, address: ShopifyOrderCreateAddress): Promise<EditableOrder> {
  const gid = toShopifyOrderGid(shopifyOrderId);
  const res = await run<{ orderUpdate: { userErrors: UserErrors } }>(client, "address_update", ORDER_UPDATE, { input: { id: gid, shippingAddress: address } });
  failIfErrors("address_update", res.orderUpdate.userErrors);
  const after = await readEditableOrder(client, shopifyOrderId);
  const a = after.shippingAddress;
  const same = (sent: string | undefined, got: string | null | undefined) => (sent ?? "").trim().toLowerCase() === (got ?? "").trim().toLowerCase();
  if (!a || !same(address.address1, a.address1) || !same(address.city, a.city) || !same(address.zip, a.zip) || (address.provinceCode !== undefined && !same(address.provinceCode, a.provinceCode)) || (address.lastName !== undefined && !same(address.lastName, a.lastName))) {
    throw new ShopifyOrderEditError("Shopify accepted the update but the order does not show the new address.", "verify");
  }
  return after;
}

const EDIT_ADD_SHIPPING = `
  mutation crmAmountEditAddShipping($id: ID!, $shippingLine: OrderEditAddShippingLineInput!) {
    orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) {
      calculatedOrder { id totalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }
`;

export interface AddShippingLineInput {
  title: string;
  amountCents: number;
  currency: string;
  /** The order total the edit must produce (current total + the shipping line). Nothing is committed unless the staged total is exactly this. */
  expectedTotalCents: number;
  staffNote: string;
}

/**
 * Adds ONE shipping line to an existing order with Shopify's supported order-edit workflow (orderEditBegin -> orderEditAddShippingLine -> orderEditCommit, customer not notified). It changes the amount owed by exactly
 * the shipping charge; it records no payment and marks nothing paid. The caller has already verified the order is open, unpaid and unfulfilled and that the courier amount agrees. The edit is committed only if the
 * staged total is exactly the expected one, and the order is not re-read here (the caller verifies the result).
 */
export async function addShippingLineToOrder(client: Pick<ShopifyClient, "query">, shopifyOrderId: string, input: AddShippingLineInput): Promise<void> {
  const gid = toShopifyOrderGid(shopifyOrderId);
  const begun = await run<{ orderEditBegin: { calculatedOrder: { id: string } | null; userErrors: UserErrors } }>(client, "edit_begin", EDIT_BEGIN, { id: gid });
  failIfErrors("edit_begin", begun.orderEditBegin.userErrors);
  const calculated = begun.orderEditBegin.calculatedOrder;
  if (!calculated) throw new ShopifyOrderEditError("Shopify did not open an order edit.", "edit_begin");
  const added = await run<{ orderEditAddShippingLine: { calculatedOrder: { totalPriceSet: { shopMoney: { amount: string } } } | null; userErrors: UserErrors } }>(client, "edit_add_shipping", EDIT_ADD_SHIPPING, {
    id: calculated.id,
    shippingLine: { title: input.title, price: { amount: (input.amountCents / 100).toFixed(2), currencyCode: input.currency } },
  });
  failIfErrors("edit_add_shipping", added.orderEditAddShippingLine.userErrors);
  const staged = added.orderEditAddShippingLine.calculatedOrder ? toCents(added.orderEditAddShippingLine.calculatedOrder.totalPriceSet.shopMoney.amount) : null;
  if (staged === null || staged !== input.expectedTotalCents) {
    throw new ShopifyOrderEditError(`The edit would make the order total ${staged === null ? "unknown" : (staged / 100).toFixed(2)} instead of ${(input.expectedTotalCents / 100).toFixed(2)}, so it was not committed.`, "edit_check");
  }
  const committed = await run<{ orderEditCommit: { userErrors: UserErrors } }>(client, "edit_commit", EDIT_COMMIT, { id: calculated.id, staffNote: input.staffNote.slice(0, 255) });
  failIfErrors("edit_commit", committed.orderEditCommit.userErrors);
}
