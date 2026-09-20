import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { orderDetailHref } from "@/components/orders/orders-table";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { PaymentStatusBadge } from "@/components/orders/payment-status-badge";
import { ShipmentStatusBadge } from "@/components/orders/shipment-status-badge";
import { ORDER_SOURCE_LABELS, PAYMENT_MODE_LABELS, formatDate, formatMoney } from "@/lib/order-status";
import type { CustomerOrderSummary } from "@/lib/api-client/types/customers.types";

export function CustomerOrdersList({ orders }: { orders: CustomerOrderSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Orders</CardTitle>
      </CardHeader>
      <CardContent>
        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">This customer has no orders yet.</p>
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
