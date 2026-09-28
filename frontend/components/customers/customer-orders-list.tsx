import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { orderDetailHref } from "@/components/orders/orders-table";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { PaymentStatusBadge } from "@/components/orders/payment-status-badge";
import { ShipmentStatusBadge } from "@/components/orders/shipment-status-badge";
import { ORDER_SOURCE_LABELS, PAYMENT_MODE_LABELS, formatDate, formatMoney } from "@/lib/order-status";
import type { CustomerOrderSummary } from "@/lib/api-client/types/customers.types";

// The WhatsApp Inbox's right panel (~340px wide) cannot fit the 7-column table below without
// horizontal scroll or clipped text - `compact` renders the same fields as stacked per-order cards
// instead. Never a second data source: same CustomerOrderSummary[], just a narrower layout.
function CompactOrderRow({ order }: { order: CustomerOrderSummary }) {
  return (
    <div className="rounded-lg border p-2.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Link href={orderDetailHref(order.id)} className="font-medium hover:underline">
          {order.orderNumber}
        </Link>
        <span className="tabular-nums">{formatMoney(order.totalAmount, order.currency)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <OrderStatusBadge status={order.status} />
        <PaymentStatusBadge status={order.paymentStatus} />
        {order.latestShipment ? <ShipmentStatusBadge status={order.latestShipment.status} /> : null}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {ORDER_SOURCE_LABELS[order.source]} · {formatDate(order.createdAt)}
      </p>
    </div>
  );
}

export function CustomerOrdersList({ orders, compact }: { orders: CustomerOrderSummary[]; compact?: boolean }) {
  return (
    <Card size={compact ? "sm" : "default"}>
      <CardHeader>
        <CardTitle className={compact ? "flex items-center gap-2 text-sm" : "flex items-center gap-2"}>
          {compact ? <ShoppingBag className="size-3.5" /> : null}
          Orders{orders.length > 0 ? ` (${orders.length})` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">This customer has no orders yet.</p>
        ) : compact ? (
          <div className="space-y-2">
            {orders.map((order) => (
              <CompactOrderRow key={order.id} order={order} />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Fulfilment</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link href={orderDetailHref(order.id)} className="font-medium hover:underline">
                      {order.orderNumber}
                    </Link>
                    {order.externalNumber ? (
                      <div className="text-xs text-muted-foreground">{order.externalNumber}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>{ORDER_SOURCE_LABELS[order.source]}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(order.totalAmount, order.currency)}</TableCell>
                  <TableCell>
                    <PaymentStatusBadge status={order.paymentStatus} />
                    {order.paymentMode ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">{PAYMENT_MODE_LABELS[order.paymentMode]}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell>
                    {order.latestShipment ? (
                      <>
                        <ShipmentStatusBadge status={order.latestShipment.status} />
                        {order.latestShipment.courier ? (
                          <div className="mt-0.5 text-xs text-muted-foreground">{order.latestShipment.courier}</div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(order.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
