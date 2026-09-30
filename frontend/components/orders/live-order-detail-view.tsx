"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveOrderDetail } from "@/hooks/useOrders";
import { DetailField, DetailGrid } from "./detail-field";
import { customerDetailHref } from "./orders-table";
import { LiveOrderHistoryTable } from "./live-order-history-table";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import type { LiveOrderAddress } from "@/lib/api-client/types/orders.types";

const ORDERS_HREF = "/dashboard/orders";
const NOT_AVAILABLE = "Not available";

function BackLink() {
  return (
    <Link href={ORDERS_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />
      Back to orders
    </Link>
  );
}

// Rough, presentation-only classification of Shopify's own free-text status strings - not the CRM's
// OrderStatus/PaymentStatus enums (those don't apply here; there is no CRM order). Good-enough visual
// grouping only, never used for any logic.
function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (!status) return "outline";
  const s = status.toUpperCase();
  if (["PAID", "FULFILLED", "DELIVERED", "SUCCESS"].some((k) => s.includes(k))) return "default";
  if (["PENDING", "PARTIALLY", "UNFULFILLED", "AUTHORIZED"].some((k) => s.includes(k))) return "secondary";
  if (["REFUNDED", "CANCELLED", "VOIDED", "FAILED", "EXPIRED"].some((k) => s.includes(k))) return "destructive";
  return "outline";
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline">Unknown</Badge>;
  return <Badge variant={statusVariant(status)}>{titleCase(status)}</Badge>;
}

function gidToId(gid: string | null): string | null {
  if (!gid) return null;
  return gid.split("/").pop() ?? gid;
}

function AddressBlock({ address }: { address: LiveOrderAddress | null }) {
  if (!address) return <p className="text-sm text-muted-foreground">{NOT_AVAILABLE}</p>;
  const lines = [address.name, address.address1, address.address2, [address.city, address.province, address.zip].filter(Boolean).join(", "), address.country].filter(Boolean);
  if (lines.length === 0) return <p className="text-sm text-muted-foreground">{NOT_AVAILABLE}</p>;
  return (
    <div className="text-sm">
      {lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {address.phone ? <p className="mt-1 text-muted-foreground">{address.phone}</p> : null}
    </div>
  );
}

function sameAddress(a: LiveOrderAddress | null, b: LiveOrderAddress | null): boolean {
  if (!a || !b) return false;
  return a.address1 === b.address1 && a.city === b.city && a.zip === b.zip && a.phone === b.phone;
}

// Order Detail for a Shopify order the Orders list showed as "Not synced to CRM" - there is no CRM
// order/lead record for it, so this is built entirely from live Shopify data (+ live Shiprocket
// tracking by AWB, + a best-effort CRM-lead link if the customer's phone matches one). Reuses the same
// Card/DetailField/DetailGrid/formatMoney/formatDate building blocks OrderDetailView and Customer 360
// already use, rather than a second visual language - this is deliberately a separate component from
// OrderDetailView (order-detail-view.tsx, unchanged) since the underlying data shapes are genuinely
// different (no CRM owner/notes/activities/segment exist for an order that was never synced).
export function LiveOrderDetailView({ externalId }: { externalId: string }) {
  const { data, isLoading, error, refetch } = useLiveOrderDetail(externalId);

  if (isLoading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading order">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (error || !data || !data.order) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div role="alert" className="flex flex-col items-start gap-3 py-6">
          <p className="text-sm text-destructive">{error ?? data?.error ?? "This order is not available."}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const { order, crmLink } = data;
  const customerName = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ") || "Unknown";
  const shopifyCustomerId = gidToId(order.customer.id);
  const totalQuantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const billingDiffersFromShipping = order.billingAddress && !sameAddress(order.shippingAddress, order.billingAddress);
  // Shopify's own successful transactions, for a payment-method summary - never a CRM Payment record
  // (there isn't one), just a read of what Shopify's own gateway/transaction log already reports.
  const successfulTx = order.transactions.filter((t) => t.status.toUpperCase() === "SUCCESS");
  const refundedTx = order.transactions.filter((t) => t.kind.toUpperCase() === "REFUND" && t.status.toUpperCase() === "SUCCESS");
  const paidAmount = successfulTx.filter((t) => t.kind.toUpperCase() !== "REFUND").reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const refundedAmount = refundedTx.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* ---- Section 1: header ---- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BackLink />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{order.name}</h1>
          <Badge variant="outline">Shopify</Badge>
          {crmLink ? (
            <Badge variant="default">Synced to CRM</Badge>
          ) : (
            <Badge variant="secondary">Not synced to CRM</Badge>
          )}
          <StatusBadge status={order.financialStatus} />
          <StatusBadge status={order.fulfillmentStatus} />
          {order.returnStatus && order.returnStatus !== "NO_RETURN" ? <StatusBadge status={order.returnStatus} /> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Placed {formatDateTime(order.createdAt)} · Last updated {formatDateTime(order.updatedAt)}
          {order.cancelledAt ? ` · Cancelled ${formatDateTime(order.cancelledAt)}${order.cancelReason ? ` (${titleCase(order.cancelReason)})` : ""}` : ""}
        </p>
      </div>

      {/* ---- Section 15: CRM link / Section 3: CRM status ---- */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          {crmLink ? (
            <>
              <div className="text-sm">
                <p>
                  <span className="font-medium">Lead {crmLink.leadNumber}</span>
                  {crmLink.owner ? <span className="text-muted-foreground"> · Owned by {crmLink.owner.name}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">CRM actions (notes, follow-ups, activities, WhatsApp) are available on the customer&rsquo;s own page.</p>
              </div>
              <Link href={customerDetailHref(crmLink.leadId)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                View Customer 360
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Customer not synced to CRM - CRM actions (owner, notes, follow-ups, activities) are unavailable until this order/customer is synced.</p>
          )}
        </CardContent>
      </Card>

      {/* ---- Section 2: customer information ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailGrid>
            <DetailField label="Name">{customerName}</DetailField>
            <DetailField label="Email">{order.customer.email ?? NOT_AVAILABLE}</DetailField>
            <DetailField label="Phone">{order.customer.phone ?? NOT_AVAILABLE}</DetailField>
            <DetailField label="Shopify customer ID">{shopifyCustomerId ?? NOT_AVAILABLE}</DetailField>
          </DetailGrid>
        </CardContent>
      </Card>

      {/* ---- Section 7: shipping / billing addresses ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Shipping & Billing</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Shipping address</p>
              <AddressBlock address={order.shippingAddress} />
              {order.shippingMethod ? <p className="text-xs text-muted-foreground">Method: {order.shippingMethod}</p> : null}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Billing address</p>
              {billingDiffersFromShipping ? (
                <AddressBlock address={order.billingAddress} />
              ) : order.billingAddress ? (
                <p className="text-sm text-muted-foreground">Same as shipping address.</p>
              ) : (
                <p className="text-sm text-muted-foreground">{NOT_AVAILABLE}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- Section 4/5: order + payment summary ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Order Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="ml-auto w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular-nums">{order.amounts.subtotal ? formatMoney(order.amounts.subtotal, order.currency) : NOT_AVAILABLE}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Discount</dt>
              <dd className="tabular-nums">{order.amounts.discount ? `−${formatMoney(order.amounts.discount, order.currency)}` : NOT_AVAILABLE}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Shipping</dt>
              <dd className="tabular-nums">{order.amounts.shipping ? formatMoney(order.amounts.shipping, order.currency) : NOT_AVAILABLE}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Tax</dt>
              <dd className="tabular-nums">{order.amounts.tax ? formatMoney(order.amounts.tax, order.currency) : NOT_AVAILABLE}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{order.amounts.total ? formatMoney(order.amounts.total, order.currency) : NOT_AVAILABLE}</dd>
            </div>
          </dl>

          <div className="border-t pt-4">
            <p className="mb-3 text-xs font-medium text-muted-foreground">Payment summary (from Shopify&rsquo;s own transaction log)</p>
            <DetailGrid>
              <DetailField label="Financial status">{order.financialStatus ? titleCase(order.financialStatus) : NOT_AVAILABLE}</DetailField>
              <DetailField label="Paid">{successfulTx.length > 0 ? formatMoney(String(paidAmount), order.currency) : NOT_AVAILABLE}</DetailField>
              <DetailField label="Refunded">{order.amounts.refunded && Number(order.amounts.refunded) > 0 ? formatMoney(order.amounts.refunded, order.currency) : refundedAmount > 0 ? formatMoney(String(refundedAmount), order.currency) : NOT_AVAILABLE}</DetailField>
              <DetailField label="Payment method / gateway">{order.paymentGateways.length > 0 ? order.paymentGateways.map(titleCase).join(", ") : NOT_AVAILABLE}</DetailField>
              {order.discountCodes.length > 0 ? <DetailField label="Discount codes">{order.discountCodes.join(", ")}</DetailField> : null}
            </DetailGrid>
            <p className="mt-3 text-xs text-muted-foreground">
              Pending/failed/outstanding amounts are not shown here - Shopify&rsquo;s transaction log does not reliably distinguish them the way a CRM payment record does; only what Shopify itself confirms (paid/refunded) is shown, rather than guessing.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ---- Section 6: line items ---- */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Items</CardTitle>
          <p className="text-xs text-muted-foreground">
            {order.items.length} line item{order.items.length === 1 ? "" : "s"} · {totalQuantity} total quantity
          </p>
        </CardHeader>
        <CardContent>
          {order.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items reported for this order.</p>
          ) : (
            <div className="space-y-2">
              {order.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                  <div>
                    <p className="font-medium">{item.title}</p>
                    {item.variantTitle ? <p className="text-xs text-muted-foreground">{item.variantTitle}</p> : null}
                    {item.sku ? <p className="text-xs text-muted-foreground">SKU: {item.sku}</p> : null}
                    {item.discounts.length > 0 ? <p className="text-xs text-muted-foreground">Discount applied</p> : null}
                  </div>
                  <div className="text-right">
                    <p className="tabular-nums">Qty {item.quantity}</p>
                    {item.unitPrice ? (
                      <>
                        <p className="text-xs text-muted-foreground tabular-nums">{formatMoney(item.unitPrice, order.currency)} each</p>
                        <p className="text-xs font-medium tabular-nums">{formatMoney(String(Number(item.unitPrice) * item.quantity), order.currency)} total</p>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
              {order.itemsTruncated ? <p className="text-xs text-muted-foreground">More line items exist than shown here.</p> : null}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Section 8/9: fulfilment + Shiprocket tracking ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Fulfilment & Shipment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {order.fulfillments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Shipment not available - this order is Unfulfilled.</p>
          ) : (
            order.fulfillments.map((fulfillment, i) => {
              const live = fulfillment.trackingNumber ? data.liveTracking[fulfillment.trackingNumber] : undefined;
              return (
                <div key={i} className="space-y-2 rounded-lg border p-4">
                  <DetailGrid>
                    <DetailField label="Fulfilment status">{fulfillment.displayStatus ?? titleCase(fulfillment.status)}</DetailField>
                    <DetailField label="Fulfilment date">{fulfillment.createdAt ? formatDateTime(fulfillment.createdAt) : NOT_AVAILABLE}</DetailField>
                    <DetailField label="Courier">{fulfillment.trackingCompany ?? NOT_AVAILABLE}</DetailField>
                    <DetailField label="Tracking / AWB number">
                      {fulfillment.trackingNumber ? <span className="font-mono text-xs">{fulfillment.trackingNumber}</span> : NOT_AVAILABLE}
                    </DetailField>
                    <DetailField label="Tracking link">
                      {fulfillment.trackingUrl ? (
                        <a href={fulfillment.trackingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                          Track shipment
                        </a>
                      ) : (
                        NOT_AVAILABLE
                      )}
                    </DetailField>
                  </DetailGrid>
                  {fulfillment.trackingNumber ? (
                    live ? (
                      live.tracking ? (
                        <div className="rounded-md bg-muted px-3 py-2 text-xs">
                          <p>
                            <span className="font-medium">Live from Shiprocket:</span> {live.tracking.currentStatus ?? "Status not available"}
                            {live.tracking.courierName ? ` · ${live.tracking.courierName}` : ""}
                            {live.tracking.etd ? ` · ETD ${live.tracking.etd}` : ""}
                          </p>
                          {live.tracking.activities.length > 0 ? (
                            <ul className="mt-2 space-y-1 border-t border-border/60 pt-2">
                              {live.tracking.activities.slice(0, 5).map((a, ai) => (
                                <li key={ai} className="text-muted-foreground">
                                  {a.date ?? "—"} · {a.status ?? "—"} {a.location ? `(${a.location})` : ""}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : (
                        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Shipment tracking temporarily unavailable: {live.error ?? "unknown reason"}</p>
                      )
                    ) : (
                      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Shipment tracking temporarily unavailable</p>
                    )
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* ---- Section 10: order timeline (Shopify + Shiprocket events only - no CRM events exist) ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Order Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            <li className="flex items-start gap-3">
              <Badge variant="outline" className="mt-0.5 shrink-0">Shopify</Badge>
              <span>Order created · {formatDateTime(order.createdAt)}</span>
            </li>
            {order.updatedAt !== order.createdAt ? (
              <li className="flex items-start gap-3">
                <Badge variant="outline" className="mt-0.5 shrink-0">Shopify</Badge>
                <span>Order last updated · {formatDateTime(order.updatedAt)}</span>
              </li>
            ) : null}
            {order.fulfillments.map((f, i) =>
              f.createdAt ? (
                <li key={`f-${i}`} className="flex items-start gap-3">
                  <Badge variant="outline" className="mt-0.5 shrink-0">Shopify</Badge>
                  <span>Fulfilment {f.displayStatus ?? titleCase(f.status)} · {formatDateTime(f.createdAt)}</span>
                </li>
              ) : null,
            )}
            {order.cancelledAt ? (
              <li className="flex items-start gap-3">
                <Badge variant="destructive" className="mt-0.5 shrink-0">Shopify</Badge>
                <span>Order cancelled{order.cancelReason ? ` (${titleCase(order.cancelReason)})` : ""} · {formatDateTime(order.cancelledAt)}</span>
              </li>
            ) : null}
            {Object.values(data.liveTracking).flatMap((t, ti) =>
              (t.tracking?.activities ?? []).slice(0, 3).map((a, ai) => (
                <li key={`t-${ti}-${ai}`} className="flex items-start gap-3">
                  <Badge variant="secondary" className="mt-0.5 shrink-0">Shiprocket</Badge>
                  <span>
                    {a.status ?? "Tracking update"} {a.location ? `(${a.location})` : ""} · {a.date ?? "—"}
                  </span>
                </li>
              )),
            )}
          </ul>
        </CardContent>
      </Card>

      {/* ---- Section 11: previous orders ---- */}
      {shopifyCustomerId ? <LiveOrderHistoryTable shopifyCustomerId={shopifyCustomerId} excludeExternalId={externalId} /> : null}
    </div>
  );
}
