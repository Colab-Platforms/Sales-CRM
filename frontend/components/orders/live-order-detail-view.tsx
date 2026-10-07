"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ArrowLeft, Ban, CreditCard, Hash, Mail, Phone, RefreshCw, ScrollText, ShoppingBag, Truck, User, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { WhatsAppConversation } from "@/components/whatsapp/conversation/whatsapp-conversation";
import { useLiveOrderDetail } from "@/hooks/useOrders";
import { useCancelLiveOrderMutation, useSyncLiveOrderMutation } from "@/lib/api-client/mutations/orders.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { DetailField, DetailGrid } from "./detail-field";
import { customerDetailHref } from "./orders-table";
import { AccentCard, EmptyState, ItemsCard, LinkButton, MilestoneList, MonoId, NOT_AVAILABLE, OrderSummaryCard, SectionTitle, ShippingBillingCard, StatTile, TimelineEvent, TimelineList, type ItemRow, type Milestone } from "./order-detail-parts";
import { PrepaidUpgradeAction } from "./prepaid-upgrade-action";
import { PrepaidUpgradeCard } from "./prepaid-upgrade-card";
import { LiveOrderHistoryTable } from "./live-order-history-table";
import { CrmBadge, ShopifyStatusBadge, SourceBadge, ToneBadge, titleCaseStatus as titleCase } from "./shopify-status-badge";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import type { LiveOrderCrmLink, ShopifyLiveOrder } from "@/lib/api-client/types/orders.types";

const ORDERS_HREF = "/dashboard/orders";

type LiveItem = ShopifyLiveOrder["items"][number];

function BackLink() {
  return (
    <Link href={ORDERS_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />
      Back to orders
    </Link>
  );
}

// Shopify has no "delete order" operation at all - cancellation (the orderCancel mutation, the same
// one the CRM-linked order's own Cancel button already uses) is the only destructive action that
// exists, so that's the one offered here. Never a fabricated "delete" or a local-only cancellation.
function CancelLiveOrderButton({ externalId, orderName, alreadyCancelled }: { externalId: string; orderName: string; alreadyCancelled: boolean }) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelLiveOrderMutation();

  if (alreadyCancelled) return null;

  return (
    <>
      <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Ban data-icon="inline-start" />
        Cancel order
      </Button>
      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel this order?"
        description={`Are you sure you want to cancel order ${orderName}?`}
        confirmLabel="Confirm cancellation"
        dismissLabel="Cancel"
        pendingLabel="Cancelling…"
        pending={cancel.isPending}
        destructive
        onConfirm={() =>
          cancel.mutate(externalId, {
            onSuccess: (result) => {
              if (result.cancelled) {
                setOpen(false);
                toast.success("Order cancelled in Shopify.");
              } else {
                // Shopify declined: surface its own reason and leave the dialog open to retry/dismiss.
                toast.error(result.reason ?? "Shopify did not cancel the order.");
              }
            },
            onError: (error) => toast.error(getErrorMessage(error, "Could not cancel the order.")),
          })
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>This cancels the live Shopify order. Shopify does not support deleting an order.</li>
          <li>Cancelling is permanent in Shopify - it cannot be reverted from here.</li>
          <li>Any payment already collected is not automatically refunded.</li>
        </ul>
      </ConfirmActionDialog>
    </>
  );
}

/**
 * The live page exists only for a Shopify order that has NO CRM Order row. `crmLink` is just the customer matched to a CRM lead by phone - it says nothing
 * about the order, so the two are shown separately and the customer link is never presented as the order being synced.
 */
export function LiveCrmStatus({ crmLink }: { crmLink: LiveOrderCrmLink | null | undefined }) {
  return (
    <>
      <ToneBadge tone="warning">Order not in CRM</ToneBadge>
      {crmLink ? <CrmBadge>Customer linked to CRM</CrmBadge> : <ToneBadge tone="neutral">Customer not linked to CRM</ToneBadge>}
    </>
  );
}

/** Brings this Shopify order into the CRM through the normal Shopify sync, then opens the CRM order page (payment, refunds and the rest live there). */
function SyncOrderToCrmButton({ externalId }: { externalId: string }) {
  const router = useRouter();
  const sync = useSyncLiveOrderMutation();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={sync.isPending}
      title="Create/update this order in the CRM from Shopify. Refunds, payments and the full order page need it."
      onClick={() =>
        sync.mutate(externalId, {
          onSuccess: (r) => {
            if (r.synced && r.orderId) {
              toast.success(r.action === "created" ? "Order added to the CRM." : "Order is up to date in the CRM.");
              router.push(`/dashboard/orders/${r.orderId}`);
            } else toast.error(r.reason ?? "Could not sync the order.");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not sync the order.")),
        })
      }
    >
      <RefreshCw data-icon="inline-start" />
      {sync.isPending ? "Syncing…" : "Sync order to CRM"}
    </Button>
  );
}

function gidToId(gid: string | null): string | null {
  if (!gid) return null;
  return gid.split("/").pop() ?? gid;
}

function sumAmounts(values: string[] | undefined): number | null {
  if (!values) return null;
  return values.reduce((sum, v) => sum + Number(v || 0), 0);
}

// Per-line figures, derived only from what Shopify reported for the line: unit price x quantity, the
// discount allocations and tax lines on it. Tax is added to the line total only when Shopify says
// prices exclude tax (taxesIncluded === false); otherwise it is already inside the unit price.
function lineFigures(item: LiveItem, taxesIncluded: boolean | null) {
  const gross = item.unitPrice ? Number(item.unitPrice) * item.quantity : null;
  const discount = sumAmounts(item.discounts) ?? 0;
  const tax = sumAmounts(item.taxes);
  const total = gross === null ? null : gross - discount + (taxesIncluded === false && tax ? tax : 0);
  return { gross, discount, tax, total };
}

// Order Detail for a Shopify order the Orders list showed as "Not synced to CRM" - there is no CRM
// order/lead record for it, so this is built entirely from live Shopify data (+ live Shiprocket
// tracking by AWB, + a best-effort CRM-lead link if the customer's phone matches one). It mirrors the
// visual language of OrderDetailView (cards, colored badges, items table, two-column groups) but stays a
// separate component because the underlying data shapes are genuinely different (no CRM owner/notes/
// payments/audit exist for an order that was never synced). Every value is Shopify's own or "Not available".
export function LiveOrderDetailView({ externalId }: { externalId: string }) {
  const { data, isLoading, error, refetch } = useLiveOrderDetail(externalId);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const upgradeTarget = { kind: "live", externalId } as const;

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
  const currency = order.currency;
  const money = (v: string | null) => (v ? formatMoney(v, currency) : NOT_AVAILABLE);
  const customerName = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ") || "Unknown";
  const shopifyCustomerId = gidToId(order.customer.id);
  const isCancelled = Boolean(order.cancelledAt);

  // Shopify's own transaction log, for the payment summary - never a CRM Payment record (there isn't one).
  const isRefundTx = (t: { kind: string }) => t.kind.toUpperCase() === "REFUND";
  const isSuccessTx = (t: { status: string }) => t.status.toUpperCase() === "SUCCESS";
  const successfulTx = order.transactions.filter(isSuccessTx);
  const paidAmount = successfulTx.filter((t) => !isRefundTx(t) && t.kind.toUpperCase() !== "VOID").reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const refundedFromTx = successfulTx.filter(isRefundTx).reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
  const paidDisplay = successfulTx.length > 0 ? formatMoney(String(paidAmount), currency) : NOT_AVAILABLE;
  const refundedDisplay =
    order.amounts.refunded && Number(order.amounts.refunded) > 0 ? formatMoney(order.amounts.refunded, currency) : refundedFromTx > 0 ? formatMoney(String(refundedFromTx), currency) : NOT_AVAILABLE;
  // Outstanding is only stated when Shopify itself says the order is fully paid; otherwise it is not
  // reliably derivable from the transaction log (authorizations, partial captures, COD...).
  const outstandingDisplay = order.financialStatus?.toUpperCase() === "PAID" ? formatMoney("0", currency) : NOT_AVAILABLE;
  const gateway = order.paymentGateways.length > 0 ? order.paymentGateways.map(titleCase).join(", ") : NOT_AVAILABLE;
  const primaryTx = successfulTx.find((t) => !isRefundTx(t)) ?? order.transactions[0] ?? null;
  const reference = primaryTx ? gidToId(primaryTx.id) : null;
  const provider = primaryTx?.gateway ? titleCase(primaryTx.gateway) : gateway;

  const itemRows: ItemRow[] = order.items.map((item) => {
    const f = lineFigures(item, order.taxesIncluded);
    return {
      id: item.id,
      product: item.title,
      variant: item.variantTitle,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: money(item.unitPrice),
      discount: f.discount > 0 ? `−${formatMoney(String(f.discount), currency)}` : formatMoney("0", currency),
      tax: f.tax === null ? NOT_AVAILABLE : formatMoney(String(f.tax), currency),
      total: f.total === null ? NOT_AVAILABLE : formatMoney(String(f.total), currency),
    };
  });

  const recordedMilestones: Milestone[] = [
    { label: "Placed", at: order.createdAt, state: "done" as const },
    { label: "Shipped", at: order.fulfillments[order.fulfillments.length - 1]?.createdAt ?? null, state: "done" as const },
    { label: "Delivered", at: order.fulfillments.find((f) => f.deliveredAt)?.deliveredAt ?? null, state: "done" as const },
    { label: "Cancelled", at: order.cancelledAt, state: "failed" as const },
  ].filter((m) => m.at);
  const milestones: Milestone[] = recordedMilestones.map((m, i) => (i === recordedMilestones.length - 1 && m.state !== "failed" && m.label !== "Delivered" ? { ...m, state: "current" as const } : m));

  const latestFulfillment = order.fulfillments[order.fulfillments.length - 1] ?? null;

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BackLink />
          <div className="flex flex-wrap items-start justify-end gap-2">
            <SyncOrderToCrmButton externalId={externalId} />
            <PrepaidUpgradeAction target={upgradeTarget} onOpen={() => setUpgradeOpen(true)} />
            <CancelLiveOrderButton externalId={externalId} orderName={order.name} alreadyCancelled={isCancelled} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{order.name}</h1>
          <SourceBadge>Shopify</SourceBadge>
          <ShopifyStatusBadge status={order.financialStatus} />
          <ShopifyStatusBadge status={order.fulfillmentStatus} />
          {isCancelled ? <ShopifyStatusBadge status="CANCELLED" /> : null}
          {order.returnStatus && order.returnStatus !== "NO_RETURN" ? <ShopifyStatusBadge status={order.returnStatus} /> : null}
          <LiveCrmStatus crmLink={crmLink} />
        </div>
        <p className="text-sm text-muted-foreground">
          Placed {formatDateTime(order.createdAt)} · Last updated {formatDateTime(order.updatedAt)}
          {isCancelled ? ` · Cancelled ${formatDateTime(order.cancelledAt)}${order.cancelReason ? ` (${titleCase(order.cancelReason)})` : ""}` : ""}
        </p>
      </div>

      {/* ---- Customer + Order information ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <AccentCard accent="purple">
          <SectionTitle icon={<User />} accent="purple" aside={crmLink ? <LinkButton href={customerDetailHref(crmLink.leadId)}>View customer profile</LinkButton> : null}>
            Customer
          </SectionTitle>
          <CardContent className="space-y-4">
            <DetailGrid compact>
              <DetailField label="Name" icon={<User />}>
                <span className="text-base font-semibold">{customerName}</span>
              </DetailField>
              <DetailField label="Mobile" icon={<Phone />}>{order.customer.phone ?? NOT_AVAILABLE}</DetailField>
              <DetailField label="Email" icon={<Mail />}>{order.customer.email ?? NOT_AVAILABLE}</DetailField>
              {crmLink ? (
                <DetailField label="Lead number" icon={<Hash />}>
                  <CrmBadge>{crmLink.leadNumber}</CrmBadge>
                </DetailField>
              ) : null}
              {crmLink?.owner ? <DetailField label="Lead owner">{crmLink.owner.name}</DetailField> : null}
              <DetailField label="Shopify customer ID">{shopifyCustomerId ? <MonoId>{shopifyCustomerId}</MonoId> : NOT_AVAILABLE}</DetailField>
            </DetailGrid>
            {!crmLink ? <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">Customer not synced to CRM - CRM actions (owner, notes, follow-ups, activities) are unavailable until this order/customer is synced.</p> : null}
          </CardContent>
        </AccentCard>

        <AccentCard accent="slate">
          <SectionTitle icon={<ShoppingBag />}>Order</SectionTitle>
          <CardContent>
            <DetailGrid compact>
              <DetailField label="Order number"><span className="text-base font-semibold">{order.name}</span></DetailField>
              <DetailField label="Order date">{formatDateTime(order.createdAt)}</DetailField>
              <DetailField label="Order source"><SourceBadge>Shopify</SourceBadge></DetailField>
              <DetailField label="CRM sync"><span className="inline-flex flex-wrap gap-1"><LiveCrmStatus crmLink={crmLink} /></span></DetailField>
              <DetailField label="Currency">{currency}</DetailField>
              {order.discountCodes.length > 0 ? <DetailField label="Discount codes">{order.discountCodes.join(", ")}</DetailField> : null}
              {order.tags.length > 0 ? <DetailField label="Tags">{order.tags.join(", ")}</DetailField> : null}
              {isCancelled && order.cancelReason ? <DetailField label="Cancel reason">{titleCase(order.cancelReason)}</DetailField> : null}
            </DetailGrid>
          </CardContent>
        </AccentCard>
      </div>

      {/* ---- Shipping & Billing ---- */}
      <ShippingBillingCard shipping={order.shippingAddress} billing={order.billingAddress} shippingMethod={order.shippingMethod} />

      {/* ---- Order Summary ---- */}
      {/* Shopify's own subtotal is AFTER discounts, and its tax may already sit inside the prices - both are
          labelled so Subtotal / Discount / Shipping / Tax / Total are not read as a simple sum. */}
      <OrderSummaryCard
        rows={[
          { label: "Subtotal", note: "(after discounts)", value: money(order.amounts.subtotal) },
          { label: "Discount", value: order.amounts.discount ? `−${formatMoney(order.amounts.discount, currency)}` : NOT_AVAILABLE },
          { label: "Shipping", value: money(order.amounts.shipping) },
          { label: "Tax", note: order.taxesIncluded ? "(included in prices)" : undefined, value: money(order.amounts.tax) },
        ]}
        total={money(order.amounts.total)}
      />

      {/* ---- Items ---- */}
      <ItemsCard
        rows={itemRows}
        taxHeader={order.taxesIncluded ? "Tax (incl.)" : "Tax"}
        emptyMessage="No line items reported for this order."
        footnote={order.itemsTruncated ? "More line items exist than shown here." : undefined}
      />

      {/* ---- Payment + Payment summary ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <AccentCard accent="amber">
          <SectionTitle icon={<CreditCard />} accent="amber">Payment</SectionTitle>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <ShopifyStatusBadge status={order.financialStatus} />
              <span className="text-xl font-bold tabular-nums">{paidDisplay}</span>
            </div>
            <DetailGrid compact>
              <DetailField label="Payment method / gateway">{gateway}</DetailField>
              <DetailField label="Provider">{provider}</DetailField>
              <DetailField label="Transaction / reference ID">{reference ? <MonoId>{reference}</MonoId> : NOT_AVAILABLE}</DetailField>
              <DetailField label="Paid amount">{paidDisplay}</DetailField>
              <DetailField label="Outstanding">{outstandingDisplay}</DetailField>
              <DetailField label="Refunded amount">{refundedDisplay}</DetailField>
              <DetailField label="Created">{primaryTx?.processedAt ? formatDateTime(primaryTx.processedAt) : NOT_AVAILABLE}</DetailField>
            </DetailGrid>
            {order.transactions.length > 0 ? (
              <ul className="divide-y rounded-lg border text-sm">
                {order.transactions.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <ShopifyStatusBadge status={t.status} />
                      <span>{titleCase(t.kind)}</span>
                      {t.gateway ? <span className="text-xs text-muted-foreground">{titleCase(t.gateway)}</span> : null}
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <span className="tabular-nums text-foreground">{money(t.amount)}</span>
                      {t.processedAt ? ` · ${formatDateTime(t.processedAt)}` : ""}
                      {t.errorCode ? ` · ${t.errorCode}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </AccentCard>

        <AccentCard accent="purple">
          <SectionTitle icon={<Wallet />} accent="purple">Payment Reconciliation</SectionTitle>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {crmLink ? "Shopify payment summary (this order is not a CRM order, so no CRM reconciliation exists for it)." : "Shopify payment summary - reconciliation unavailable until CRM sync."}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Order amount" value={money(order.amounts.total)} />
              <StatTile label="Paid" value={paidDisplay} tone={paidAmount > 0 ? "success" : "neutral"} />
              <StatTile label="Refunded" value={refundedDisplay} tone={refundedDisplay !== NOT_AVAILABLE ? "danger" : "neutral"} />
              <StatTile label="Outstanding" value={outstandingDisplay} tone={outstandingDisplay === NOT_AVAILABLE ? "neutral" : "success"} />
            </div>
            <DetailGrid compact>
              <DetailField label="Discount">{order.amounts.discount ? `−${formatMoney(order.amounts.discount, currency)}` : NOT_AVAILABLE}</DetailField>
              <DetailField label="Payment method">{gateway}</DetailField>
              <DetailField label="Payment provider">{provider}</DetailField>
              <DetailField label="Transaction reference">{reference ? <MonoId>{reference}</MonoId> : NOT_AVAILABLE}</DetailField>
              <DetailField label="Payment status">
                <ShopifyStatusBadge status={order.financialStatus} />
              </DetailField>
              <DetailField label="Reconciliation status">
                <ToneBadge tone="neutral">Unavailable until CRM sync</ToneBadge>
              </DetailField>
            </DetailGrid>
          </CardContent>
        </AccentCard>
      </div>

      {/* ---- Prepaid Upgrade: an order-level payment operation, available whether or not the CRM has synced this order ---- */}
      <PrepaidUpgradeCard target={upgradeTarget} open={upgradeOpen} onOpenChange={setUpgradeOpen} />

      {/* ---- Fulfilment & Shipment ---- */}
      <AccentCard accent="blue">
        <SectionTitle icon={<Truck />} accent="blue" aside={order.fulfillmentStatus ? <ShopifyStatusBadge status={order.fulfillmentStatus} /> : null}>Fulfilment &amp; Shipment</SectionTitle>
        <CardContent className="space-y-3">
          {order.fulfillments.length === 0 ? (
            <EmptyState title="No shipment recorded yet" message={`This order is currently ${order.fulfillmentStatus ? titleCase(order.fulfillmentStatus).toLowerCase() : "unfulfilled"}. Shipment details will appear automatically when tracking information becomes available.`} />
          ) : (
            order.fulfillments.map((fulfillment, i) => {
              const live = fulfillment.trackingNumber ? data.liveTracking[fulfillment.trackingNumber] : undefined;
              return (
                <div key={i} className="space-y-3 rounded-lg border bg-muted/20 p-4">
                  <DetailGrid>
                    <DetailField label="Fulfilment status">
                      <ShopifyStatusBadge status={fulfillment.displayStatus ?? fulfillment.status} />
                    </DetailField>
                    <DetailField label="Courier">{fulfillment.trackingCompany ?? NOT_AVAILABLE}</DetailField>
                    <DetailField label="Tracking / AWB number">{fulfillment.trackingNumber ? <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{fulfillment.trackingNumber}</span> : NOT_AVAILABLE}</DetailField>
                    <DetailField label="Tracking link">
                      {fulfillment.trackingUrl ? (
                        <LinkButton href={fulfillment.trackingUrl} external>
                          Track shipment →
                        </LinkButton>
                      ) : (
                        NOT_AVAILABLE
                      )}
                    </DetailField>
                    <DetailField label="Shipped">{fulfillment.createdAt ? formatDateTime(fulfillment.createdAt) : NOT_AVAILABLE}</DetailField>
                    <DetailField label="Delivered">{fulfillment.deliveredAt ? formatDateTime(fulfillment.deliveredAt) : NOT_AVAILABLE}</DetailField>
                    <DetailField label="Shipment status">{live?.tracking?.currentStatus ?? NOT_AVAILABLE}</DetailField>
                    <DetailField label="Expected delivery">{live?.tracking?.etd ?? NOT_AVAILABLE}</DetailField>
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
      </AccentCard>

      {/* ---- Status + Timeline ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <AccentCard accent="blue">
          <SectionTitle icon={<Activity />} accent="blue">Status</SectionTitle>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Current status</p>
              <div className="[&_*]:text-sm">
                <ShopifyStatusBadge status={isCancelled ? "CANCELLED" : (latestFulfillment?.displayStatus ?? order.fulfillmentStatus ?? order.financialStatus)} />
              </div>
            </div>
            <MilestoneList items={milestones} />
            {order.returnStatus && order.returnStatus !== "NO_RETURN" ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Return status</p>
                <ShopifyStatusBadge status={order.returnStatus} />
              </div>
            ) : null}
            <p className="border-t pt-3 text-xs text-muted-foreground">Only milestones Shopify has recorded are listed - there is no CRM status history for an order that was never synced.</p>
          </CardContent>
        </AccentCard>

        <AccentCard accent="slate">
          <SectionTitle icon={<ScrollText />}>Order Timeline</SectionTitle>
          <CardContent>
            <TimelineList>
              <TimelineEvent source="Shopify" title="Order created" at={order.createdAt} dot="blue" />
              {order.updatedAt !== order.createdAt ? <TimelineEvent source="Shopify" title="Order last updated" at={order.updatedAt} dot="slate" /> : null}
              {order.transactions
                .filter((t) => t.processedAt)
                .map((t) => (
                  <TimelineEvent key={`tx-${t.id}`} source="Shopify" title={`Payment ${titleCase(t.kind)} · ${titleCase(t.status)}`} at={t.processedAt} dot={t.status.toUpperCase() === "SUCCESS" ? "green" : /FAIL|ERROR|VOID/.test(t.status.toUpperCase()) ? "red" : "amber"} detail={[t.amount ? formatMoney(t.amount, currency) : null, t.gateway ? titleCase(t.gateway) : null].filter(Boolean).join(" · ") || null} />
                ))}
              {order.fulfillments.map((f, i) =>
                f.createdAt ? <TimelineEvent key={`f-${i}`} source="Shopify" title={`Fulfilment ${f.displayStatus ?? titleCase(f.status)}`} at={f.createdAt} dot="blue" detail={[f.trackingCompany, f.trackingNumber].filter(Boolean).join(" · ") || null} /> : null,
              )}
              {order.fulfillments.map((f, i) => (f.deliveredAt ? <TimelineEvent key={`d-${i}`} source="Shopify" title="Delivered" at={f.deliveredAt} dot="green" /> : null))}
              {isCancelled ? <TimelineEvent source="Shopify" tone="destructive" title={`Order cancelled${order.cancelReason ? ` (${titleCase(order.cancelReason)})` : ""}`} at={order.cancelledAt} /> : null}
              {Object.values(data.liveTracking).flatMap((t, ti) =>
                (t.tracking?.activities ?? []).slice(0, 3).map((a, ai) => (
                  <TimelineEvent key={`t-${ti}-${ai}`} source="Shiprocket" tone="secondary" dot="blue" title={`${a.status ?? "Tracking update"}${a.location ? ` (${a.location})` : ""}`} at={a.date ?? null} />
                )),
              )}
            </TimelineList>
          </CardContent>
        </AccentCard>
      </div>

      {/* ---- WhatsApp (only when the customer matches a real CRM lead) ---- */}
      {crmLink ? <WhatsAppConversation leadId={crmLink.leadId} title="WhatsApp Conversation" emptyMessage="No WhatsApp messages for this customer yet." /> : null}

      {/* ---- Previous Orders ---- */}
      {shopifyCustomerId ? <LiveOrderHistoryTable shopifyCustomerId={shopifyCustomerId} excludeExternalId={externalId} /> : null}

      {/* ---- Audit History: CRM-only, never fabricated for a live order ---- */}
      <AccentCard accent="slate">
        <SectionTitle icon={<ScrollText />}>Audit History</SectionTitle>
        <CardContent>
          <p className="text-sm text-muted-foreground">No CRM audit records - this order is not a CRM order. Shopify&rsquo;s own events are in the Order Timeline above; CRM audit history appears here once the order is synced.</p>
        </CardContent>
      </AccentCard>
    </div>
  );
}
