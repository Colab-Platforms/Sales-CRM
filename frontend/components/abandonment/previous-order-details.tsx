"use client";

import { useOrder, useLiveOrderDetail } from "@/hooks/useOrders";
import { formatMoney } from "@/lib/order-status";
import { parseLiveOrderId, type LiveOrderAddress, type OrderDetail, type ShopifyLiveOrder } from "@/lib/api-client/types/orders.types";

// The expanded part of a Previous-orders card: the products actually bought and the money / delivery details, from persisted data only (the CRM order, or Shopify's own record for a
// store-only order). Optional parts that do not exist are left out - nothing is invented.

export interface DetailLine { key: string; name: string; variant: string | null; sku: string | null; quantity: number; unitPrice: string | null; total: string | null }
export interface DetailView {
  currency: string;
  lines: DetailLine[];
  linesTruncated: boolean;
  totals: { subtotal: string | null; discount: string | null; shipping: string | null; tax: string | null; total: string | null };
  address: string | null;
  fulfillment: string | null;
  shipments: { courier: string | null; number: string | null; url: string | null }[];
}

const money = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : v);
const nonZero = (v: string | null) => (v !== null && Number(v) !== 0 ? v : null);
const join = (parts: (string | null | undefined)[]) => parts.map((p) => (p ?? "").trim()).filter(Boolean).join(", ") || null;

function crmAddress(a: Record<string, string | null> | null): string | null {
  if (!a) return null;
  return join([a.name, a.line1 ?? a.address1, a.line2 ?? a.address2, a.landmark, a.city, a.state ?? a.province, a.pincode ?? a.zip]);
}
function liveAddress(a: LiveOrderAddress | null): string | null {
  return a ? join([a.name, a.address1, a.address2, a.city, a.province, a.zip, a.country]) : null;
}

export function viewFromCrm(o: OrderDetail): DetailView {
  return {
    currency: o.currency,
    lines: o.items.map((i) => ({ key: i.id, name: i.productName, variant: i.variantName, sku: i.sku, quantity: i.quantity, unitPrice: money(i.unitPrice), total: money(i.totalPrice) })),
    linesTruncated: false,
    totals: { subtotal: money(o.subtotal), discount: nonZero(money(o.discountAmount)), shipping: money(o.shippingAmount), tax: nonZero(money(o.taxAmount)), total: money(o.totalAmount) },
    address: crmAddress(o.shippingAddress),
    fulfillment: o.shipments[0]?.status ?? null,
    shipments: o.shipments.filter((s) => s.trackingNumber || s.courier).map((s) => ({ courier: s.courier, number: s.trackingNumber, url: s.trackingUrl })),
  };
}

export function viewFromLive(o: ShopifyLiveOrder): DetailView {
  return {
    currency: o.currency,
    lines: o.items.map((i) => ({ key: i.id, name: i.title, variant: i.variantTitle, sku: i.sku, quantity: i.quantity, unitPrice: money(i.unitPrice), total: i.unitPrice !== null ? (Number(i.unitPrice) * i.quantity).toFixed(2) : null })),
    linesTruncated: o.itemsTruncated,
    totals: { subtotal: money(o.amounts.subtotal), discount: nonZero(money(o.amounts.discount)), shipping: money(o.amounts.shipping), tax: nonZero(money(o.amounts.tax)), total: money(o.amounts.total) },
    address: liveAddress(o.shippingAddress),
    fulfillment: o.fulfillmentStatus,
    shipments: o.fulfillments.filter((f) => f.trackingNumber || f.trackingCompany).map((f) => ({ courier: f.trackingCompany, number: f.trackingNumber, url: f.trackingUrl })),
  };
}

export function OrderDetailsBody({ view }: { view: DetailView }) {
  const t = view.totals;
  const rows: [string, string | null][] = [["Subtotal", t.subtotal], ["Discount", t.discount], ["Shipping", t.shipping], ["Tax", t.tax]];
  return (
    <div className="mt-2 space-y-3 border-t border-border/60 pt-2 text-xs" data-testid="order-expanded">
      {view.lines.length === 0 ? (
        <p className="text-muted-foreground" data-testid="order-no-lines">No products are recorded for this order.</p>
      ) : (
        <table className="w-full text-left" data-testid="order-lines">
          <thead className="text-muted-foreground">
            <tr><th className="pb-1 font-medium">Product</th><th className="pb-1 text-right font-medium">Qty</th><th className="pb-1 text-right font-medium">Price</th><th className="pb-1 text-right font-medium">Total</th></tr>
          </thead>
          <tbody>
            {view.lines.map((l) => (
              <tr key={l.key} className="align-top" data-testid="order-line">
                <td className="py-1 pr-2">
                  <span className="font-medium">{l.name}</span>
                  {l.variant && l.variant !== "Default Title" ? <span className="block text-muted-foreground">{l.variant}</span> : null}
                  {l.sku ? <span className="block text-muted-foreground">SKU {l.sku}</span> : null}
                </td>
                <td className="py-1 text-right tabular-nums">{l.quantity}</td>
                <td className="py-1 text-right tabular-nums">{l.unitPrice ? formatMoney(l.unitPrice, view.currency) : "-"}</td>
                <td className="py-1 text-right tabular-nums">{l.total ? formatMoney(l.total, view.currency) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.linesTruncated ? <p className="text-muted-foreground">Only the first products are shown.</p> : null}
      <dl className="ml-auto grid max-w-[16rem] grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 tabular-nums">
        {rows.filter(([, v]) => v !== null).map(([label, v]) => (<div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="text-right">{formatMoney(v!, view.currency)}</dd></div>))}
        {t.total ? <div className="contents font-semibold"><dt>Total</dt><dd className="text-right">{formatMoney(t.total, view.currency)}</dd></div> : null}
      </dl>
      {view.address ? <p data-testid="order-address"><span className="text-muted-foreground">Ship to: </span>{view.address}</p> : null}
      {view.fulfillment ? <p><span className="text-muted-foreground">Fulfilment: </span>{view.fulfillment.replace(/_/g, " ").toLowerCase()}</p> : null}
      {view.shipments.map((s, i) => (
        <p key={i} data-testid="order-shipment"><span className="text-muted-foreground">Courier: </span>{s.courier ?? "-"}{s.number ? <> · Tracking: {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="underline">{s.number}</a> : s.number}</> : null}</p>
      ))}
    </div>
  );
}

function CrmBody({ id }: { id: string }) {
  const { data, isLoading, error } = useOrder(id);
  if (isLoading) return <p className="mt-2 text-xs text-muted-foreground" data-testid="order-loading">Loading order…</p>;
  if (error || !data) return <p role="alert" className="mt-2 text-xs text-destructive" data-testid="order-error">{error ?? "Could not load this order."}</p>;
  return <OrderDetailsBody view={viewFromCrm(data)} />;
}

function LiveBody({ externalId }: { externalId: string }) {
  const { data, isLoading, error } = useLiveOrderDetail(externalId);
  if (isLoading) return <p className="mt-2 text-xs text-muted-foreground" data-testid="order-loading">Loading order…</p>;
  const order = data?.order ?? null;
  if (error || !order) return <p role="alert" className="mt-2 text-xs text-destructive" data-testid="order-error">{error ?? data?.error ?? "Could not load this order from the store."}</p>;
  return <OrderDetailsBody view={viewFromLive(order)} />;
}

/** Mounted only when a card is expanded, so nothing is fetched for collapsed orders. Same endpoints (and access rules) as the order's own page. */
export function PreviousOrderDetails({ id }: { id: string }) {
  const live = parseLiveOrderId(id);
  return live ? <LiveBody externalId={live} /> : <CrmBody id={id} />;
}
