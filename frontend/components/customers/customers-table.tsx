"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { customerDetailHref } from "@/components/orders/orders-table";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { PaymentStatusBadge } from "@/components/orders/payment-status-badge";
import { ShipmentStatusBadge } from "@/components/orders/shipment-status-badge";
import { CustomerSegmentBadge } from "./customer-segment-badge";
import { NbaBadge } from "./nba-badge";
import { NbaPriorityBadge } from "./nba-priority-badge";
import { formatDate, formatMoney } from "@/lib/order-status";
import type { CustomerListItem } from "@/lib/api-client/types/customers.types";

const COLUMN_COUNT = 9;
const HEADERS = ["Customer", "Mobile", "Segment", "Orders", "Total paid", "Last order", "Current status", "Next best action", "Owner"];

export function CustomersTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading customers">
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
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

interface CustomersTableProps {
  items: CustomerListItem[];
  isFetching: boolean;
}

export function CustomersTable({ items, isFetching }: CustomersTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header} className={header === "Total paid" ? "text-right" : undefined}>
              {header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((customer) => (
          <TableRow key={customer.leadId}>
            <TableCell>
              <Link href={customerDetailHref(customer.leadId)} className="font-medium hover:underline">
                {customer.name}
              </Link>
              <div className="text-xs text-muted-foreground">{customer.leadNumber}</div>
            </TableCell>
            <TableCell className="text-muted-foreground">{customer.mobile ?? "—"}</TableCell>
            <TableCell>
              <CustomerSegmentBadge segment={customer.segment} />
            </TableCell>
            <TableCell className="tabular-nums">{customer.orderCount}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(customer.totalPaid)}</TableCell>
            <TableCell className="text-muted-foreground">{customer.lastOrderAt ? formatDate(customer.lastOrderAt) : "—"}</TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                {customer.currentOrderStatus ? <OrderStatusBadge status={customer.currentOrderStatus} /> : <span className="text-muted-foreground">—</span>}
                <div className="flex flex-wrap gap-1">
                  <PaymentStatusBadge status={customer.currentPaymentStatus} />
                  {customer.currentShipmentStatus ? <ShipmentStatusBadge status={customer.currentShipmentStatus} /> : null}
                </div>
              </div>
            </TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                <NbaBadge action={customer.nbaAction} />
                <NbaPriorityBadge priority={customer.nbaPriority} />
              </div>
            </TableCell>
            <TableCell>
              {customer.owner?.name ?? <span className="text-muted-foreground">—</span>}
              <div className="mt-1">
                <Link href={customerDetailHref(customer.leadId)} className="text-xs text-primary hover:underline">
                  View
                </Link>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
