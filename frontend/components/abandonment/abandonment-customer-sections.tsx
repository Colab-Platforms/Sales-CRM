"use client";

import { useState } from "react";
import Link from "next/link";
import { PreviousOrderDetails } from "./previous-order-details";
import { Badge } from "@/components/ui/badge";
import { ORDER_STATUS_LABELS, PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS, SHIPMENT_STATUS_LABELS, formatDate, formatMoney } from "@/lib/order-status";
import type { AbandonmentAddress, AbandonmentDetail, CustomerOrderSummary } from "@/lib/api-client/types/abandonment.types";

const NOT_AVAILABLE = "Not available";

/** Where an order opens. The orders list and this panel use the same detail route. */
export const previousOrderHref = (id: string) => `/dashboard/orders/${id}`;

function AddressBlock({ title, address }: { title: string; address: AbandonmentAddress }) {
  // Every available part, one per line, in reading order - nothing is shortened to "City, State".
  const rows: [string, string | null][] = [
    ["Name", address.name],
    ["Phone", address.phone],
    ["Address line 1", address.line1],
    ["Address line 2", address.line2],
    ["Landmark / locality", address.landmark],
    ["City", address.city],
    ["State", address.state],
    ["Postal code", address.pincode],
    ["Country", address.country],
  ];
  return (
    <div className="space-y-1.5" data-testid={`address-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <p className="break-words text-sm font-medium leading-snug" data-testid="address-full">{address.formatted}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows
          .filter(([, v]) => v)
          .map(([label, v]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

/** The delivery address: the saved checkout's (full), else the customer's latest order's, else only the short location text - and it says which. */
export function DeliveryAddressSection({ addresses }: { addresses: AbandonmentDetail["addresses"] }) {
  const { shipping, billing, source, leadLocation } = addresses;
  return (
    <section className="space-y-3 border-t border-border/60 pt-3" data-testid="delivery-address">
      <h4 className="text-sm font-semibold">Delivery address</h4>
      {shipping ? (
        <>
          <AddressBlock title="Shipping address" address={shipping} />
          {source === "LAST_ORDER" ? <p className="text-xs text-muted-foreground">The customer did not enter an address at checkout; this is from their latest order.</p> : null}
        </>
      ) : leadLocation ? (
        <p className="text-sm" data-testid="address-location-only">
          {leadLocation}
          <span className="block text-xs text-muted-foreground">Only the city and state were captured; no full address is available.</span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{NOT_AVAILABLE}</p>
      )}
      {billing && billing.formatted !== shipping?.formatted ? <AddressBlock title="Billing address" address={billing} /> : null}
    </section>
  );
}

function PreviousOrderCard({ o }: { o: CustomerOrderSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-border/80 bg-card p-3 text-sm" data-testid="previous-order">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={previousOrderHref(o.id)} className="font-semibold hover:underline">
                  {o.externalNumber ?? o.orderNumber}
                </Link>
                <span className="font-semibold tabular-nums">{formatMoney(o.totalAmount, o.currency)}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{formatDate(o.createdAt)}</span>
                {o.externalNumber ? <span>{o.orderNumber}</span> : null}
                <span>{o.paymentMode ? PAYMENT_MODE_LABELS[o.paymentMode] : "No payment"}{o.paymentStatus ? ` · ${PAYMENT_STATUS_LABELS[o.paymentStatus]}` : ""}</span>
                <span>{ORDER_STATUS_LABELS[o.status]}</span>
                {o.fulfillmentStatus ? <span>{SHIPMENT_STATUS_LABELS[o.fulfillmentStatus]}</span> : o.fulfillmentLabel ? <span>{o.fulfillmentLabel}</span> : null}
                {o.tracking?.number ? (
                  <span data-testid="order-tracking">
                    Tracking: {o.tracking.company ? `${o.tracking.company} ` : ""}
                    {o.tracking.url ? (
                      <a href={o.tracking.url} target="_blank" rel="noreferrer" className="underline">{o.tracking.number}</a>
                    ) : (
                      o.tracking.number
                    )}
                  </span>
                ) : null}
                {o.origin === "SHOPIFY" ? (
                  <Badge variant="outline" className="text-[10px]">
                    Shopify
                  </Badge>
                ) : null}
              </div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="mt-2 text-xs font-medium text-primary hover:underline" data-testid="order-toggle">
        {open ? "Hide details" : "Show products & details"}
      </button>
      {open ? <PreviousOrderDetails id={o.id} /> : null}
    </li>
  );
}

type PreviousOrders = AbandonmentDetail["previousOrders"];

/** What to tell the person about the store (Shopify) lookup. A lookup that did not complete is never presented as "no orders". */
export function shopifyNotice(p: PreviousOrders): { kind: "problem" | "info"; text: string } | null {
  switch (p.shopify) {
    case "UNAVAILABLE":
      return { kind: "problem", text: "The store's order history could not be checked right now, so orders placed on the store may be missing. Try again shortly." };
    case "NOT_CONFIGURED":
      return { kind: "problem", text: "Shopify is not configured on this server, so the store's order history cannot be checked. Only CRM orders are shown." };
    case "AMBIGUOUS":
      return { kind: "problem", text: `${p.shopifyMatchCount ?? "Several"} different store customers match this lead's phone or e-mail, so no store history is shown - it could belong to someone else. Ask an admin to review the customer records.` };
    default:
      return null;
  }
}

function emptyMessage(p: PreviousOrders): string {
  if (p.shopify === "OK" && p.shopifyCustomerFound) return "A matching store customer was found, but they have no orders.";
  if (p.shopify === "OK") return "This customer has no previous orders in the CRM or the store (searched by phone and e-mail).";
  return "No CRM orders found for this customer.";
}

/** Every earlier order of this customer (CRM-created, Shopify-synced and live from the store), each linking to its own detail page. */
export function PreviousOrdersSection({ previousOrders }: { previousOrders: PreviousOrders }) {
  const { total, items } = previousOrders;
  const notice = shopifyNotice(previousOrders);
  return (
    <section className="space-y-3 border-t border-border/60 pt-3" data-testid="previous-orders">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Previous orders</h4>
        {total > 0 ? <span className="text-xs text-muted-foreground">{total} {total === 1 ? "order" : "orders"}</span> : null}
      </div>
      {notice ? (
        <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-900 dark:text-amber-200" data-testid="previous-orders-notice" data-state={previousOrders.shopify}>
          {notice.text}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="previous-orders-empty">{emptyMessage(previousOrders)}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((o) => (
            <PreviousOrderCard key={o.id} o={o} />
          ))}
        </ul>
      )}
      {previousOrders.shopifyTruncated ? <p className="text-xs text-muted-foreground" data-testid="previous-orders-truncated">Only the most recent store orders are shown; older ones were not loaded.</p> : null}
      {total > items.length ? <p className="text-xs text-muted-foreground">Showing the latest {items.length} of {total}.</p> : null}
    </section>
  );
}

/** The Lead Details card: always visible (not behind a tab), only for a lead that has an abandoned checkout to read the customer context from. */
export function LeadPreviousOrdersCard({ abandonment }: { abandonment: Pick<AbandonmentDetail, "previousOrders"> | null | undefined }) {
  if (!abandonment?.previousOrders) return null;
  return (
    <div className="sketch-panel bg-card p-4.5" data-testid="lead-previous-orders">
      <PreviousOrdersSection previousOrders={abandonment.previousOrders} />
    </div>
  );
}
