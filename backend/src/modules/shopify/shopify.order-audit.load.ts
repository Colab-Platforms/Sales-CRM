import type { ShopifyClient } from "./shopify.client.js";
import { normalizeShopifyOrderId, toCents } from "./shopify.money.js";
import type { AuditCrmOrder, AuditShopifyOrder } from "./shopify.order-audit.js";
import type { AddressParts } from "./shopify.order-sync.compare.js";

// READ-ONLY loaders for the audit and the repair: the CRM side inside a READ ONLY database transaction, the Shopify side with queries only. Orders are matched by the stable Shopify order id.

interface Row {
  id: string; order_number: string; external_id: string; external_number: string | null; status: string; currency: string;
  total_amount: { toString(): string }; shipping_amount: { toString(): string }; discount_amount: { toString(): string }; tax_amount: { toString(): string };
  mode: string | null; lead_id: string; first_name: string; last_name: string | null; normalized_mobile: string | null; email: string | null;
  pays: string[]; shipments: bigint; refunds: bigint; created_at: Date; shipping_address: Record<string, unknown> | null; shipping_pincode: string | null;
}

/** The slice of a Prisma client these loaders need. */
export interface ReadDb {
  $transaction<T>(fn: (tx: { $executeRawUnsafe(sql: string): Promise<unknown>; $queryRaw<R>(strings: TemplateStringsArray, ...values: unknown[]): Promise<R> }) => Promise<T>): Promise<T>;
}

/** Every CRM telecaller order that was pushed to Shopify (or just the one with this CRM order id). */
export async function loadCrmAuditOrders(db: ReadDb, only?: { crmOrderId: string }): Promise<(AuditCrmOrder & { createdAt: string })[]> {
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const id = only?.crmOrderId ?? null;
    return tx.$queryRaw<Row[]>`
      SELECT o.id::text, o.order_number, o.external_id, o.external_number, o.status::text, o.currency, o.total_amount, o.shipping_amount, o.discount_amount, o.tax_amount, o.metadata->>'paymentMode' AS mode, o.created_at, o.shipping_address, o.shipping_pincode,
             l.id::text AS lead_id, l.first_name, l.last_name, l.normalized_mobile, l.email,
             COALESCE((SELECT array_agg(p.status::text) FROM payments p WHERE p.order_id = o.id), '{}') AS pays,
             (SELECT count(*) FROM shipments s WHERE s.order_id = o.id) AS shipments,
             (SELECT count(*) FROM refund_requests r WHERE r.order_id = o.id) AS refunds
        FROM orders o JOIN leads l ON l.id = o.lead_id
       WHERE o.source = 'SALESPERSON' AND o.external_source = 'SHOPIFY' AND o.external_id IS NOT NULL AND o.status <> 'DRAFT'
         AND (${id}::text IS NULL OR o.id::text = ${id}::text)
       ORDER BY o.created_at`;
  });
  return rows.map((r) => ({
    id: r.id, orderNumber: r.order_number, externalId: normalizeShopifyOrderId(r.external_id), externalNumber: r.external_number, status: r.status, currency: r.currency,
    totalCents: toCents(r.total_amount.toString()), shippingCents: toCents(r.shipping_amount.toString()), discountCents: toCents(r.discount_amount.toString()), taxCents: toCents(r.tax_amount.toString()),
    paymentStatuses: r.pays, paymentMode: r.mode, shipmentCount: Number(r.shipments), refundRequestCount: Number(r.refunds), createdAt: r.created_at.toISOString(),
    lead: { id: r.lead_id, firstName: r.first_name, lastName: r.last_name, normalizedMobile: r.normalized_mobile, email: r.email },
    address: crmAddress(r.shipping_address, r.shipping_pincode),
  }));
}

/** The CRM address record in the comparable shape (null when the order has none). */
export function crmAddress(raw: unknown, pincode: string | null): AddressParts | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return { name: s(a.name), line1: s(a.line1) ?? s(a.address1), line2: s(a.line2) ?? s(a.address2), city: s(a.city), state: s(a.state) ?? s(a.province), pincode: s(a.pincode) ?? s(a.zip) ?? pincode, phone: s(a.phone) };
}

type Money = { shopMoney: { amount: string } } | null | undefined;
const money = (b: Money) => toCents(b?.shopMoney.amount);
const M = (f: string) => `${f} { shopMoney { amount } }`;
const QUERY = `query crmAudit($ids: [ID!]!) { nodes(ids: $ids) { ... on Order {
  id name cancelledAt displayFinancialStatus displayFulfillmentStatus currencyCode
  ${M("totalPriceSet")} ${M("currentTotalPriceSet")} ${M("totalShippingPriceSet")} ${M("totalDiscountsSet")} ${M("totalTaxSet")} ${M("totalRefundedSet")}
  customer { id firstName lastName phone }
  shippingAddress { firstName lastName address1 address2 city provinceCode zip }
} } }`;
interface Node {
  id: string; name: string; cancelledAt: string | null; displayFinancialStatus: string | null; displayFulfillmentStatus: string | null; currencyCode: string | null;
  totalPriceSet: Money; currentTotalPriceSet: Money; totalShippingPriceSet: Money; totalDiscountsSet: Money; totalTaxSet: Money; totalRefundedSet: Money; customer: AuditShopifyOrder["customer"];
  shippingAddress: { firstName: string | null; lastName: string | null; address1: string | null; address2: string | null; city: string | null; provinceCode: string | null; zip: string | null } | null;
}

const BATCH = 40;
/** The Shopify orders with these ids, keyed by numeric id. An id Shopify no longer has is simply absent. */
export async function loadShopifyAuditOrders(client: Pick<ShopifyClient, "query">, externalIds: string[], onProgress?: (done: number) => void): Promise<Map<string, AuditShopifyOrder>> {
  const out = new Map<string, AuditShopifyOrder>();
  for (let i = 0; i < externalIds.length; i += BATCH) {
    const ids = externalIds.slice(i, i + BATCH).map((id) => `gid://shopify/Order/${id}`);
    const data = await client.query<{ nodes: (Node | null)[] }>(QUERY, { ids });
    for (const n of data.nodes) {
      if (!n) continue;
      out.set(normalizeShopifyOrderId(n.id), {
        id: normalizeShopifyOrderId(n.id), name: n.name, cancelledAt: n.cancelledAt, financialStatus: n.displayFinancialStatus, fulfillmentStatus: n.displayFulfillmentStatus, currency: n.currencyCode,
        totalCents: money(n.totalPriceSet), currentTotalCents: money(n.currentTotalPriceSet), shippingCents: money(n.totalShippingPriceSet), discountsCents: money(n.totalDiscountsSet), taxCents: money(n.totalTaxSet), refundedCents: money(n.totalRefundedSet), customer: n.customer,
        address: n.shippingAddress ? { firstName: n.shippingAddress.firstName, lastName: n.shippingAddress.lastName, line1: n.shippingAddress.address1, line2: n.shippingAddress.address2, city: n.shippingAddress.city, provinceCode: n.shippingAddress.provinceCode, pincode: n.shippingAddress.zip } : null,
      });
    }
    onProgress?.(Math.min(i + BATCH, externalIds.length));
  }
  return out;
}
