import { ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";
import { toCents } from "./shopify.money.js";
import { toShopifyOrderGid } from "./shopify.orders.write.js";
import type { AddressParts } from "./shopify.order-sync.compare.js";

// The live Shopify order, read-only, in the shape the order page's "Sync from CRM" compares: customer, shipping / billing address, tags, note, totals, shipping lines, discounts, tax, refunds, line items, and the state
// that decides what may be edited (cancelled, fulfilment, financial status). One query; nothing is written.

export interface SyncShopifyOrder {
  id: string;
  name: string;
  updatedAt: string;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string | null;
  tags: string[];
  note: string | null;
  totalCents: number;
  currentTotalCents: number;
  shippingCents: number;
  discountsCents: number;
  taxCents: number;
  refundedCents: number;
  outstandingCents: number;
  customer: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null } | null;
  shippingAddress: AddressParts | null;
  billingAddress: AddressParts | null;
  shippingLineCount: number;
  /** Payment transactions recorded on the order (any kind). A new shipping line must never add one. */
  transactionCount: number;
  lines: { variantId: string | null; quantity: number; unitPriceCents: number }[];
}

type Money = { shopMoney: { amount: string } } | null | undefined;
type Addr = { firstName: string | null; lastName: string | null; address1: string | null; address2: string | null; city: string | null; provinceCode: string | null; zip: string | null; phone?: string | null } | null;
const M = (f: string) => `${f} { shopMoney { amount } }`;
const QUERY = `query crmOrderForSync($id: ID!) { order(id: $id) {
  id name updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus currencyCode tags note
  ${M("totalPriceSet")} ${M("currentTotalPriceSet")} ${M("totalShippingPriceSet")} ${M("totalDiscountsSet")} ${M("totalTaxSet")} ${M("totalRefundedSet")} ${M("totalOutstandingSet")}
  customer { id firstName lastName phone email }
  shippingAddress { firstName lastName address1 address2 city provinceCode zip phone }
  billingAddress { firstName lastName address1 address2 city provinceCode zip phone }
  shippingLines(first: 5) { nodes { title } }
  transactions(first: 20) { kind }
  lineItems(first: 100) { nodes { quantity variant { id } ${M("originalUnitPriceSet")} } }
} }`;
interface Raw {
  order: {
    id: string; name: string; updatedAt: string; cancelledAt: string | null; displayFinancialStatus: string | null; displayFulfillmentStatus: string | null; currencyCode: string | null; tags: string[]; note: string | null;
    totalPriceSet: Money; currentTotalPriceSet: Money; totalShippingPriceSet: Money; totalDiscountsSet: Money; totalTaxSet: Money; totalRefundedSet: Money; totalOutstandingSet: Money;
    customer: SyncShopifyOrder["customer"]; shippingAddress: Addr; billingAddress: Addr; shippingLines: { nodes: unknown[] }; transactions?: unknown[] | null;
    lineItems: { nodes: { quantity: number; variant: { id: string } | null; originalUnitPriceSet: Money }[] };
  } | null;
}
const cents = (b: Money) => toCents(b?.shopMoney.amount);
const addr = (a: Addr): AddressParts | null => (a ? { firstName: a.firstName, lastName: a.lastName, line1: a.address1, line2: a.address2, city: a.city, provinceCode: a.provinceCode, pincode: a.zip, phone: a.phone ?? null } : null);

export class ShopifySyncReadError extends Error {}

export async function readSyncOrder(client: Pick<ShopifyClient, "query">, shopifyOrderId: string): Promise<SyncShopifyOrder> {
  let data: Raw;
  try {
    data = await client.query<Raw>(QUERY, { id: toShopifyOrderGid(shopifyOrderId) });
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifySyncReadError(error.message);
    throw error;
  }
  const o = data.order;
  if (!o) throw new ShopifySyncReadError("Shopify no longer has this order.");
  return {
    id: o.id, name: o.name, updatedAt: o.updatedAt, cancelledAt: o.cancelledAt, financialStatus: o.displayFinancialStatus, fulfillmentStatus: o.displayFulfillmentStatus, currency: o.currencyCode, tags: o.tags ?? [], note: o.note,
    totalCents: cents(o.totalPriceSet), currentTotalCents: cents(o.currentTotalPriceSet), shippingCents: cents(o.totalShippingPriceSet), discountsCents: cents(o.totalDiscountsSet), taxCents: cents(o.totalTaxSet), refundedCents: cents(o.totalRefundedSet), outstandingCents: cents(o.totalOutstandingSet),
    customer: o.customer, shippingAddress: addr(o.shippingAddress), billingAddress: addr(o.billingAddress), shippingLineCount: o.shippingLines.nodes.length, transactionCount: (o.transactions ?? []).length,
    lines: o.lineItems.nodes.map((l) => ({ variantId: l.variant?.id ?? null, quantity: l.quantity, unitPriceCents: cents(l.originalUnitPriceSet) })),
  };
}
