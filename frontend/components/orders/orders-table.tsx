"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ORDER_SOURCE_LABELS, PAYMENT_MODE_LABELS, formatDate, formatMoney } from "@/lib/order-status";
import { OrderStatusBadge } from "./order-status-badge";
import { PaymentStatusBadge } from "./payment-status-badge";
import type { LiveOrderListItem, OrderListItem } from "@/lib/api-client/types/orders.types";

// Accepts either the CRM-DB-backed list item or the live-Shopify one. The live one's status/customer
// fields are nullable for a Shopify order the CRM hasn't synced yet (ADMIN-only, see
// orders.live.service.ts) - rendered below as "Not synced to CRM" rather than crashing on a null link.
type TableOrderItem = OrderListItem | LiveOrderListItem;

const COLUMN_COUNT = 9;

const HEADERS = [
  "Order",
  "Customer",
  "Salesperson",
  "Lead source",
  "Order source",
  "Total",
  "Payment",
  "Status",
  "Date",
];

export function orderDetailHref(id: string) {
  return `/dashboard/orders/${id}`;
}

export function customerDetailHref(leadId: string) {
  return `/dashboard/customers/${leadId}`;
}

function OrdersTableHeader() {
  return (
    <TableHeader>
      <TableRow>
        {HEADERS.map((header) => (
          <TableHead key={header} className={header === "Total" ? "text-right" : undefined}>
            {header}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

export function OrdersTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading orders">
      <OrdersTableHeader />
      <TableBody>
        {Array.from({ length: rows }).map((_, i) => (
          <TableRow key={i}>
            {Array.from({ length: COLUMN_COUNT }).map((__, j) => (
              <TableCell key={j}>
                <div className="h-4 w-full max-w-24 animate-pulse rounded bg-muted" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface OrdersTableProps {
  items: TableOrderItem[];
  isFetching: boolean;
  onOpen: (id: string) => void;
}

export function OrdersTable({ items, isFetching, onOpen }: OrdersTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <OrdersTableHeader />
      <TableBody>
        {items.map((order) => (
          <TableRow key={order.id} className="cursor-pointer" onClick={() => onOpen(order.id)}>
            <TableCell>
              <Link
                href={orderDetailHref(order.id)}
                onClick={(e) => e.stopPropagation()}
                className="font-medium hover:underline"
              >
                {order.orderNumber}
              </Link>
              <div className="text-xs text-muted-foreground">
                {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
              </div>
            </TableCell>
            <TableCell>
              {order.customer.leadId ? (
                <>
                  <Link
                    href={customerDetailHref(order.customer.leadId)}
                    onClick={(e) => e.stopPropagation()}
                    className="font-medium hover:underline"
                  >
                    {order.customer.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">{order.customer.leadNumber}</div>
                </>
              ) : (
                <span className="font-medium">{order.customer.name}</span>
              )}
            </TableCell>
            <TableCell>{order.salesperson?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell>{order.leadSource?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell>{ORDER_SOURCE_LABELS[order.source]}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(order.totalAmount, order.currency)}</TableCell>
            <TableCell>
              <PaymentStatusBadge status={order.paymentStatus} />
              {order.paymentMode ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{PAYMENT_MODE_LABELS[order.paymentMode]}</div>
              ) : null}
            </TableCell>
            <TableCell>
              {order.status ? (
                <OrderStatusBadge status={order.status} />
              ) : (
                <span className="text-xs text-muted-foreground">Not synced to CRM</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(order.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
