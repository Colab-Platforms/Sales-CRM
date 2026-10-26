import type { ShopifyClient } from "./shopify.client.js";
import { ShopifyGraphQLError } from "./shopify.client.js";

// Shopify customer writes used when a CRM order is pushed to Shopify. Both go through the same client and `write_customers` scope as the rest of the integration, and both are narrow:
//  - create a customer ONLY when the lead has a phone but no e-mail and no verified Shopify customer exists (orderCreate cannot create a customer from a phone alone);
//  - fill a name ONLY on a verified customer that has none - an existing name is never overwritten, and an empty CRM name is never sent.

export class ShopifyCustomerWriteError extends Error {
  constructor(message: string, readonly raw?: unknown) {
    super(message);
    this.name = "ShopifyCustomerWriteError";
  }
}

interface CustomerMutationResponse {
  customer: { id: string; firstName: string | null; lastName: string | null } | null;
  userErrors: { field: string[] | null; message: string }[];
}

const CUSTOMER_CREATE = `
  mutation crmCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id firstName lastName }
      userErrors { field message }
    }
  }
`;
const CUSTOMER_UPDATE = `
  mutation crmCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id firstName lastName }
      userErrors { field message }
    }
  }
`;

export interface CustomerNames {
  firstName: string;
  lastName: string;
}

const clean = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ");
/** Only the name parts that really exist: an empty part is never sent (it would blank a name). */
const nameFields = (n: CustomerNames) => ({ ...(clean(n.firstName) ? { firstName: clean(n.firstName) } : {}), ...(clean(n.lastName) ? { lastName: clean(n.lastName) } : {}) });

async function run(client: Pick<ShopifyClient, "query">, document: string, root: "customerCreate" | "customerUpdate", input: Record<string, unknown>): Promise<NonNullable<CustomerMutationResponse["customer"]>> {
  let data: Record<string, CustomerMutationResponse>;
  try {
    data = await client.query<Record<string, CustomerMutationResponse>>(document, { input });
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyCustomerWriteError(error.message, error);
    throw error;
  }
  const payload = data[root];
  if (payload.userErrors.length > 0) throw new ShopifyCustomerWriteError(payload.userErrors.map((e) => e.message).join("; "), payload.userErrors);
  if (!payload.customer) throw new ShopifyCustomerWriteError("Shopify did not return the customer");
  return payload.customer;
}

/** Creates a customer from a phone number (+ name, + e-mail when there is one). Returns the new customer's GID. */
export async function createShopifyCustomer(client: Pick<ShopifyClient, "query">, input: { phone: string; email?: string | null } & CustomerNames): Promise<{ id: string }> {
  const created = await run(client, CUSTOMER_CREATE, "customerCreate", { phone: input.phone, ...(clean(input.email) ? { email: clean(input.email) } : {}), ...nameFields(input) });
  return { id: created.id };
}

/** Sets the customer's name. Callers only use it for a customer that has no name in Shopify. */
export async function fillShopifyCustomerName(client: Pick<ShopifyClient, "query">, customerId: string, names: CustomerNames): Promise<void> {
  const fields = nameFields(names);
  if (Object.keys(fields).length === 0) return; // nothing to set: never blank a name
  await run(client, CUSTOMER_UPDATE, "customerUpdate", { id: customerId, ...fields });
}

const ORDER_CUSTOMER_SET = `
  mutation crmOrderCustomerSet($orderId: ID!, $customerId: ID!) {
    orderCustomerSet(orderId: $orderId, customerId: $customerId) {
      order { id customer { id } }
      userErrors { field message }
    }
  }
`;

/** Links an existing Shopify customer to an existing order. Changes only who the order belongs to - no amount, payment, line or fulfilment. */
export async function setShopifyOrderCustomer(client: Pick<ShopifyClient, "query">, orderGid: string, customerGid: string): Promise<void> {
  let data: { orderCustomerSet: { order: { customer: { id: string } | null } | null; userErrors: { field: string[] | null; message: string }[] } };
  try {
    data = await client.query(ORDER_CUSTOMER_SET, { orderId: orderGid, customerId: customerGid });
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyCustomerWriteError(error.message, error);
    throw error;
  }
  const { userErrors, order } = data.orderCustomerSet;
  if (userErrors.length > 0) throw new ShopifyCustomerWriteError(userErrors.map((e) => e.message).join("; "), userErrors);
  if (order?.customer?.id !== customerGid) throw new ShopifyCustomerWriteError("Shopify did not link the customer to the order");
}
