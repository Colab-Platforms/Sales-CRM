"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CreditCard, ScrollText, ShoppingBag, User, Wallet, Phone, Mail, Hash, Activity, Cloud } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrder } from "@/hooks/useOrders";
import { useCustomer360 } from "@/hooks/useCustomers";
import { CustomerOrdersList } from "@/components/customers/customer-orders-list";
import { WhatsAppConversation } from "@/components/whatsapp/conversation/whatsapp-conversation";
import { SendWhatsAppDialog } from "@/components/whatsapp/send-whatsapp-dialog";
import {
  ORDER_SOURCE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_MODE_LABELS,
  formatDateTime,
  formatMoney,
} from "@/lib/order-status";
import { DetailField, DetailGrid } from "./detail-field";
import { OrderAuditHistory } from "./order-audit-history";
import { customerDetailHref } from "./orders-table";
import { OrderShipmentSection } from "./order-shipment-section";
import { ShipmentStatusBadge } from "./shipment-status-badge";
import { CrmBadge, PaymentModeBadge, ShopifyStatusBadge, SourceBadge, ToneBadge } from "./shopify-status-badge";
import { AccentCard, EmptyState, ItemsCard, LinkButton, MilestoneList, MonoId, NOT_AVAILABLE, OrderSummaryCard, SectionTitle, ShippingBillingCard, StatTile, addressFromRecord, type ItemRow, type Milestone } from "./order-detail-parts";
import { OrderStatusBadge } from "./order-status-badge";
import { OrderStatusHistory } from "./order-status-history";
import { CancelOrderButton, OrderPaymentSummary } from "./cancel-order-button";
import { CreatePaymentLinkButton, PaymentLinkPanel, ShopifyPaymentSyncStatus } from "./payment-link-panel";
import { PaymentStatusBadge } from "./payment-status-badge";
import { ReconciliationStatusBadge } from "./reconciliation-status-badge";
import type { OrderDetail, PaymentDetail } from "@/lib/api-client/types/orders.types";

const ORDERS_HREF = "/dashboard/orders";

function BackLink() {
  return (
    <Link href={ORDERS_HREF} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />
      Back to orders
    </Link>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading order">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32" />
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
    </div>
  );
}

function PaymentCard({ payment, order }: { payment: PaymentDetail; order: OrderDetail }) {
  const currency = order.currency;
  // Prefer the merchant reference; fall back to the provider's own payment id.
  const reference = payment.transactionReference ?? payment.providerPaymentId;

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <PaymentStatusBadge status={payment.status} />
        <span className="text-xl font-bold tabular-nums">{formatMoney(payment.amount, payment.currency || currency)}</span>
      </div>
      <DetailGrid>
        <DetailField label="Payment method">{payment.method ? PAYMENT_METHOD_LABELS[payment.method] : "—"}</DetailField>
        <DetailField label="Provider">{payment.provider ?? "—"}</DetailField>
        <DetailField label="Transaction / reference ID">
          {reference ? <MonoId>{reference}</MonoId> : "—"}
        </DetailField>
        <DetailField label="Created">{formatDateTime(payment.createdAt)}</DetailField>
        {payment.paidAt ? <DetailField label="Paid on">{formatDateTime(payment.paidAt)}</DetailField> : null}
        {payment.failedAt ? <DetailField label="Failed on">{formatDateTime(payment.failedAt)}</DetailField> : null}
        {payment.refundedAt ? <DetailField label="Refunded on">{formatDateTime(payment.refundedAt)}</DetailField> : null}
        {payment.refundedAmount ? <DetailField label="Refunded amount">{formatMoney(payment.refundedAmount, payment.currency || currency)}</DetailField> : null}
        {payment.failureReason ? <DetailField label="Failure reason">{payment.failureReason}</DetailField> : null}
      </DetailGrid>
      <PaymentLinkPanel payment={payment} order={order} />
    </div>
  );
}

function PaymentReconciliationCard({ order }: { order: OrderDetail }) {
  // The most recent payment attempt drives the method/provider/reference shown here, same
  // convention as the reconciliation list (payments are already ordered most-recent-first).
  const latestPayment = order.payments[0] ?? null;
  const money = (v: string) => formatMoney(v, order.currency);

  return (
    <AccentCard accent="purple">
      <SectionTitle icon={<Wallet />} accent="purple">
        Payment Reconciliation
      </SectionTitle>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Order amount" value={money(order.totalAmount)} />
          <StatTile label="Paid" value={money(order.paidAmount)} tone={Number(order.paidAmount) > 0 ? "success" : "neutral"} />
          <StatTile label="Refunded" value={money(order.refundedAmount)} tone={Number(order.refundedAmount) > 0 ? "danger" : "neutral"} />
          <StatTile label="Outstanding" value={money(order.outstandingAmount)} tone={Number(order.outstandingAmount) > 0 ? "warning" : "success"} />
        </div>
        <DetailGrid compact>
          <DetailField label="Discount">{money(order.discountAmount)}</DetailField>
          <DetailField label="Payment method">{latestPayment?.method ? PAYMENT_METHOD_LABELS[latestPayment.method] : "—"}</DetailField>
          <DetailField label="Payment provider">{latestPayment?.provider ?? "—"}</DetailField>
          <DetailField label="Transaction reference">
            <MonoId>{latestPayment?.transactionReference ?? latestPayment?.providerPaymentId ?? "—"}</MonoId>
          </DetailField>
          <DetailField label="Payment status">
            <PaymentStatusBadge status={order.paymentStatus} />
          </DetailField>
          <DetailField label="Reconciliation status">
            <ReconciliationStatusBadge status={order.reconciliationStatus} />
          </DetailField>
        </DetailGrid>
      </CardContent>
    </AccentCard>
  );
}

function OrderDetailContent({ order }: { order: OrderDetail }) {
  const salesperson = order.bookedBy ?? order.leadOwner;
  const ownerDiffers = order.leadOwner && order.bookedBy && order.leadOwner.id !== order.bookedBy.id;
  const [sendOpen, setSendOpen] = useState(false);
  const money = (v: string) => formatMoney(v, order.currency);

  // Reuses the exact same Customer 360 data/endpoint this customer's own profile page already
  // loads (Lead -> Orders, no second query or duplicated relation) - just to read their other
  // orders here. Never a new "previous orders" endpoint.
  const customer360 = useCustomer360(order.customer.leadId);
  const previousOrders = (customer360.data?.orders ?? []).filter((o) => o.id !== order.id);

  // CRM owns the ship-to; Shopify's live snapshot (when linked and reachable) is the only source of a
  // separate billing address and the shipping rate name - never guessed when it is not there.
  const shippingAddress = addressFromRecord(order.shippingAddress);
  if (shippingAddress && !shippingAddress.zip && order.shippingPincode) shippingAddress.zip = order.shippingPincode;
  const latestShipment = order.shipments[0] ?? null;
  // Only milestones the order actually carries a timestamp for; the last recorded one is "current" unless
  // the order is cancelled (then the cancellation is the failed/terminal state).
  const recorded: Milestone[] = [
    { label: "Placed", at: order.placedAt, state: "done" as const },
    { label: "Confirmed", at: order.confirmedAt, state: "done" as const },
    { label: "Shipped", at: latestShipment?.shippedAt ?? null, state: "done" as const },
    { label: "Delivered", at: latestShipment?.deliveredAt ?? null, state: "done" as const },
    { label: "Cancelled", at: order.cancelledAt, state: "failed" as const },
  ].filter((m) => m.at);
  const milestones: Milestone[] = recorded.map((m, i) => (i === recorded.length - 1 && m.state !== "failed" && m.label !== "Delivered" ? { ...m, state: "current" as const } : m));

  const itemRows: ItemRow[] = order.items.map((item) => ({
    id: item.id,
    product: item.productName,
    variant: item.variantName,
    sku: item.sku,
    quantity: item.quantity,
    unitPrice: money(item.unitPrice),
    discount: Number(item.discountAmount) > 0 ? `−${money(item.discountAmount)}` : money(item.discountAmount),
    tax: money(item.taxAmount),
    total: money(item.totalPrice),
  }));

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BackLink />
          <CancelOrderButton order={order} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{order.orderNumber}</h1>
          <SourceBadge>{ORDER_SOURCE_LABELS[order.source]}</SourceBadge>
          <OrderStatusBadge status={order.status} />
          <PaymentStatusBadge status={order.paymentStatus} />
          {order.paymentMode ? <PaymentModeBadge mode={order.paymentMode} label={PAYMENT_MODE_LABELS[order.paymentMode]} /> : null}
          {latestShipment ? <ShipmentStatusBadge status={latestShipment.status} /> : <ToneBadge tone="warning">Unfulfilled</ToneBadge>}
          <span title="Whether this order exists in Shopify">
            <ToneBadge tone={order.externalNumber ? "info" : "neutral"}>Shopify: {order.externalNumber ? order.externalNumber : "not linked"}</ToneBadge>
          </span>
          <CrmBadge>CRM Synced</CrmBadge>
        </div>
        <p className="text-sm text-muted-foreground">
          Placed {formatDateTime(order.placedAt ?? order.createdAt)}
          {order.shopifyLive ? ` · Last updated ${formatDateTime(order.shopifyLive.updatedAt)}` : ""}
          {order.cancelledAt ? ` · Cancelled ${formatDateTime(order.cancelledAt)}` : ""}
        </p>
      </div>

      {/* ---- Customer + Order information ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <AccentCard accent="purple">
          <SectionTitle icon={<User />} accent="purple" aside={<LinkButton href={customerDetailHref(order.customer.leadId)}>View customer profile</LinkButton>}>
            Customer
          </SectionTitle>
          <CardContent>
            <DetailGrid compact>
              <DetailField label="Name" icon={<User />}>
                <span className="text-base font-semibold">{order.customer.name}</span>
              </DetailField>
              <DetailField label="Mobile" icon={<Phone />}>{order.customer.mobile ?? NOT_AVAILABLE}</DetailField>
              <DetailField label="Email" icon={<Mail />}>{order.customer.email ?? NOT_AVAILABLE}</DetailField>
              <DetailField label="Lead number" icon={<Hash />}>
                <CrmBadge>{order.customer.leadNumber}</CrmBadge>
              </DetailField>
              <DetailField label="CRM sync" icon={<Cloud />}>
                <CrmBadge>Synced to CRM</CrmBadge>
              </DetailField>
            </DetailGrid>
          </CardContent>
        </AccentCard>

        <AccentCard accent="slate">
          <SectionTitle icon={<ShoppingBag />}>Order</SectionTitle>
          <CardContent>
            <DetailGrid compact>
              <DetailField label="Order number"><span className="text-base font-semibold">{order.orderNumber}</span></DetailField>
              <DetailField label="Order date">{formatDateTime(order.createdAt)}</DetailField>
              <DetailField label="Lead source">{order.leadSource?.name ? <SourceBadge>{order.leadSource.name}</SourceBadge> : NOT_AVAILABLE}</DetailField>
              <DetailField label="Order source"><SourceBadge>{ORDER_SOURCE_LABELS[order.source]}</SourceBadge></DetailField>
              <DetailField label="Salesperson">{salesperson?.name ?? NOT_AVAILABLE}</DetailField>
              {ownerDiffers ? <DetailField label="Current lead owner">{order.leadOwner?.name}</DetailField> : null}
              <DetailField label="Payment mode">{order.paymentMode ? <PaymentModeBadge mode={order.paymentMode} label={PAYMENT_MODE_LABELS[order.paymentMode]} /> : NOT_AVAILABLE}</DetailField>
              <DetailField label="Currency">{order.currency}</DetailField>
              {order.externalNumber ? <DetailField label="Shopify order">{order.externalNumber}</DetailField> : null}
              {order.shippingPincode ? <DetailField label="Shipping pincode">{order.shippingPincode}</DetailField> : null}
              {order.cancelReason ? <DetailField label="Cancel reason">{order.cancelReason}</DetailField> : null}
            </DetailGrid>
          </CardContent>
        </AccentCard>
      </div>

      {/* ---- Shipping & Billing ---- */}
      <ShippingBillingCard shipping={shippingAddress} billing={order.shopifyLive?.billingAddress ?? null} shippingMethod={order.shopifyLive?.shippingMethod} />

      {/* ---- Order Summary ---- */}
      <OrderSummaryCard
        rows={[
          { label: "Subtotal", value: money(order.subtotal) },
          { label: "Discount", value: `−${money(order.discountAmount)}` },
          { label: "Shipping", value: money(order.shippingAmount) },
          { label: "Tax", value: money(order.taxAmount) },
        ]}
        total={money(order.totalAmount)}
      />
      {order.discountReason ? (
        <p className="-mt-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Discount reason:</span> {order.discountReason}
        </p>
      ) : null}

      {order.externalNumber ? (
        <AccentCard accent="blue">
          <SectionTitle icon={<Cloud />} accent="blue">Live from Shopify</SectionTitle>
          <CardContent>
            {order.shopifyLive ? (
              <DetailGrid>
                <DetailField label="Financial status">{order.shopifyLive.financialStatus ? <ShopifyStatusBadge status={order.shopifyLive.financialStatus} /> : NOT_AVAILABLE}</DetailField>
                <DetailField label="Fulfilment status">{order.shopifyLive.fulfillmentStatus ? <ShopifyStatusBadge status={order.shopifyLive.fulfillmentStatus} /> : NOT_AVAILABLE}</DetailField>
                {order.shopifyLive.returnStatus ? (
                  <DetailField label="Return status">
                    <ShopifyStatusBadge status={order.shopifyLive.returnStatus} />
                  </DetailField>
                ) : null}
                <DetailField label="Live total">{formatMoney(order.shopifyLive.amounts.total ?? "0", order.currency)}</DetailField>
              </DetailGrid>
            ) : (
              <p className="text-sm text-muted-foreground">{order.shopifyLiveError ?? "Live Shopify details are not available for this order."}</p>
            )}
          </CardContent>
        </AccentCard>
      ) : null}

      {/* ---- Items ---- */}
      <ItemsCard rows={itemRows} emptyMessage="This order has no items." />

      {/* ---- Payment + Payment Reconciliation ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <AccentCard accent="amber">
          <SectionTitle icon={<CreditCard />} accent="amber">Payment</SectionTitle>
          <CardContent className="space-y-3">
            <OrderPaymentSummary order={order} />
            <CreatePaymentLinkButton order={order} />
            <ShopifyPaymentSyncStatus order={order} />
            {order.payments.length === 0 ? (
              <EmptyState title="No payment recorded" message="No payment has been recorded for this order yet." icon={<CreditCard className="size-6 text-muted-foreground" aria-hidden />} />
            ) : (
              order.payments.map((payment) => <PaymentCard key={payment.id} payment={payment} order={order} />)
            )}
          </CardContent>
        </AccentCard>

        <PaymentReconciliationCard order={order} />
      </div>

      {/* ---- Fulfilment & Shipment ---- */}
      <OrderShipmentSection shipments={order.shipments} orderId={order.id} orderNumber={order.orderNumber} orderStatus={order.status} currency={order.currency} />

      {/* ---- Status + Timeline ---- */}
      <div className="grid gap-6 lg:grid-cols-2">
        <AccentCard accent="blue">
          <SectionTitle icon={<Activity />} accent="blue">
            Status
          </SectionTitle>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Current status</p>
              <div className="text-base [&_*]:text-sm">
                <OrderStatusBadge status={order.status} />
              </div>
            </div>
            <MilestoneList items={milestones} />
          </CardContent>
        </AccentCard>

        <AccentCard accent="slate">
          <SectionTitle icon={<ScrollText />}>Order Timeline</SectionTitle>
          <CardContent>
            <OrderStatusHistory orderId={order.id} />
          </CardContent>
        </AccentCard>
      </div>

      {/* The customer's OTHER orders - reused Customer 360 data/component, never a duplicate order
          list or a second copy of the current order. */}
      <CustomerOrdersList orders={previousOrders} title="Previous Orders" emptyMessage="No previous orders for this customer." />

      {/* Order-scoped (orderId) - deliberately not the lead-wide conversation. */}
      <WhatsAppConversation
        leadId={order.customer.leadId}
        orderId={order.id}
        title="WhatsApp Conversation"
        emptyMessage="No WhatsApp messages for this order yet."
        onStartWhatsApp={order.customer.mobile ? () => setSendOpen(true) : undefined}
      />

      <OrderAuditHistory orderId={order.id} />

      <SendWhatsAppDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        leadId={order.customer.leadId}
        customerName={order.customer.name}
        orders={customer360.data?.orders ?? []}
      />
    </div>
  );
}

export function OrderDetailView({ id }: { id: string }) {
  const { data, isLoading, error, refetch } = useOrder(id);

  if (isLoading) return <DetailSkeleton />;

  if (error || !data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div role="alert" className="flex flex-col items-start gap-3 py-6">
          <p className="text-sm text-destructive">{error ?? "Failed to load order."}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return <OrderDetailContent order={data} />;
}
