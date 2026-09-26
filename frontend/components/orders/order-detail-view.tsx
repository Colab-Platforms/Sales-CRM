"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOrder } from "@/hooks/useOrders";
import {
  ORDER_SOURCE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_MODE_LABELS,
  formatDate,
  formatDateTime,
  formatMoney,
} from "@/lib/order-status";
import { DetailField, DetailGrid } from "./detail-field";
import { OrderAuditHistory } from "./order-audit-history";
import { customerDetailHref } from "./orders-table";
import { OrderShipmentSection } from "./order-shipment-section";
import { OrderStatusBadge } from "./order-status-badge";
import { OrderStatusHistory } from "./order-status-history";
import { CancelOrderButton, OrderPaymentSummary } from "./cancel-order-button";
import { CreatePaymentLinkButton, PaymentLinkPanel, ShopifyPaymentSyncStatus } from "./payment-link-panel";
import { PaymentStatusBadge } from "./payment-status-badge";
import { ReconciliationStatusBadge } from "./reconciliation-status-badge";
import type { OrderDetail, PaymentDetail } from "@/lib/api-client/types/orders.types";

const ORDERS_HREF = "/dashboard/orders";

// The stored address is a loose set of parts; show the ones that are present, in reading order.
function formatAddress(address: Record<string, string | null>): string {
  return [address.name, address.address1, address.address2, address.city, address.province, address.zip, address.country]
    .filter(Boolean)
    .join(", ");
}

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
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PaymentStatusBadge status={payment.status} />
        <span className="text-sm font-medium tabular-nums">{formatMoney(payment.amount, payment.currency || currency)}</span>
      </div>
      <DetailGrid>
        <DetailField label="Payment method">{payment.method ? PAYMENT_METHOD_LABELS[payment.method] : "—"}</DetailField>
        <DetailField label="Provider">{payment.provider ?? "—"}</DetailField>
        <DetailField label="Transaction / reference ID">
          {reference ? <span className="font-mono text-xs break-all">{reference}</span> : "—"}
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Reconciliation</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailGrid>
          <DetailField label="Order amount">{formatMoney(order.totalAmount, order.currency)}</DetailField>
          <DetailField label="Discount">{formatMoney(order.discountAmount, order.currency)}</DetailField>
          <DetailField label="Paid">{formatMoney(order.paidAmount, order.currency)}</DetailField>
          <DetailField label="Refunded">{formatMoney(order.refundedAmount, order.currency)}</DetailField>
          <DetailField label="Outstanding">{formatMoney(order.outstandingAmount, order.currency)}</DetailField>
          <DetailField label="Payment method">{latestPayment?.method ? PAYMENT_METHOD_LABELS[latestPayment.method] : "—"}</DetailField>
          <DetailField label="Payment provider">{latestPayment?.provider ?? "—"}</DetailField>
          <DetailField label="Transaction reference">
            {latestPayment?.transactionReference ?? latestPayment?.providerPaymentId ?? "—"}
          </DetailField>
          <DetailField label="Payment status">
            <PaymentStatusBadge status={order.paymentStatus} />
          </DetailField>
          <DetailField label="Reconciliation status">
            <ReconciliationStatusBadge status={order.reconciliationStatus} />
          </DetailField>
        </DetailGrid>
      </CardContent>
    </Card>
  );
}

function OrderDetailContent({ order }: { order: OrderDetail }) {
  const salesperson = order.bookedBy ?? order.leadOwner;
  const ownerDiffers = order.leadOwner && order.bookedBy && order.leadOwner.id !== order.bookedBy.id;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Order {order.orderNumber}</h1>
          <OrderStatusBadge status={order.status} />
          <PaymentStatusBadge status={order.paymentStatus} />
          {order.paymentMode ? <Badge variant="outline">{PAYMENT_MODE_LABELS[order.paymentMode]}</Badge> : null}
          <Badge variant="outline" title="Whether this order exists in Shopify">
            Shopify: {order.externalNumber ? order.externalNumber : "not linked"}
          </Badge>
          <div className="ml-auto">
            <CancelOrderButton order={order} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Placed on {formatDateTime(order.placedAt ?? order.createdAt)}</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Customer</CardTitle>
            <Link href={customerDetailHref(order.customer.leadId)} className="text-sm font-medium text-primary hover:underline">
              View customer profile
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <DetailGrid>
            <DetailField label="Name">{order.customer.name}</DetailField>
            <DetailField label="Mobile">{order.customer.mobile ?? "—"}</DetailField>
            <DetailField label="Email">{order.customer.email ?? "—"}</DetailField>
            <DetailField label="Lead number">{order.customer.leadNumber}</DetailField>
          </DetailGrid>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailGrid>
            <DetailField label="Order number">{order.orderNumber}</DetailField>
            <DetailField label="Order date">{formatDateTime(order.createdAt)}</DetailField>
            <DetailField label="Lead source">{order.leadSource?.name ?? "—"}</DetailField>
            <DetailField label="Order source">{ORDER_SOURCE_LABELS[order.source]}</DetailField>
            <DetailField label="Salesperson">{salesperson?.name ?? "—"}</DetailField>
            {ownerDiffers ? <DetailField label="Current lead owner">{order.leadOwner?.name}</DetailField> : null}
            <DetailField label="Currency">{order.currency}</DetailField>
            {order.externalNumber ? <DetailField label="Shopify order">{order.externalNumber}</DetailField> : null}
            <DetailField label="Payment mode">{order.paymentMode ? PAYMENT_MODE_LABELS[order.paymentMode] : "—"}</DetailField>
            {order.shippingPincode ? <DetailField label="Shipping pincode">{order.shippingPincode}</DetailField> : null}
            {order.cancelReason ? <DetailField label="Cancel reason">{order.cancelReason}</DetailField> : null}
          </DetailGrid>
          {order.shippingAddress ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Ship to:</span> {formatAddress(order.shippingAddress)}
            </p>
          ) : null}

          <dl className="ml-auto w-full max-w-xs space-y-1.5 border-t pt-4 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tabular-nums">{formatMoney(order.subtotal, order.currency)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Discount</dt>
              <dd className="tabular-nums">−{formatMoney(order.discountAmount, order.currency)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Tax</dt>
              <dd className="tabular-nums">{formatMoney(order.taxAmount, order.currency)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Shipping</dt>
              <dd className="tabular-nums">{formatMoney(order.shippingAmount, order.currency)}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMoney(order.totalAmount, order.currency)}</dd>
            </div>
          </dl>
          {order.discountReason ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Discount reason:</span> {order.discountReason}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Variant</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    This order has no items.
                  </TableCell>
                </TableRow>
              ) : (
                order.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.productName}</TableCell>
                    <TableCell>{item.variantName ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{item.sku ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(item.unitPrice, order.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(item.discountAmount, order.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(item.taxAmount, order.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(item.totalPrice, order.currency)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <OrderPaymentSummary order={order} />
          <CreatePaymentLinkButton order={order} />
          <ShopifyPaymentSyncStatus order={order} />
          {order.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payment has been recorded for this order yet.</p>
          ) : (
            order.payments.map((payment) => <PaymentCard key={payment.id} payment={payment} order={order} />)
          )}
        </CardContent>
      </Card>

      <PaymentReconciliationCard order={order} />

      <OrderShipmentSection shipments={order.shipments} orderId={order.id} orderNumber={order.orderNumber} orderStatus={order.status} currency={order.currency} />

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailGrid>
            <DetailField label="Current status">
              <OrderStatusBadge status={order.status} />
            </DetailField>
            <DetailField label="Placed">{formatDate(order.placedAt)}</DetailField>
            <DetailField label="Confirmed">{formatDate(order.confirmedAt)}</DetailField>
            {order.cancelledAt ? <DetailField label="Cancelled">{formatDate(order.cancelledAt)}</DetailField> : null}
          </DetailGrid>
          <div className="border-t pt-4">
            <h3 className="mb-3 text-sm font-medium">Status history</h3>
            <OrderStatusHistory orderId={order.id} />
          </div>
        </CardContent>
      </Card>

      <OrderAuditHistory orderId={order.id} />
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
