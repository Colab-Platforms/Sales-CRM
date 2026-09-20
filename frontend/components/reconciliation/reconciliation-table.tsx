"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { orderDetailHref, customerDetailHref } from "@/components/orders/orders-table";
import { PaymentStatusBadge } from "@/components/orders/payment-status-badge";
import { ReconciliationStatusBadge } from "@/components/orders/reconciliation-status-badge";
import { PAYMENT_MODE_LABELS, formatDate, formatMoney } from "@/lib/order-status";
import type { ReconciliationOrderRow } from "@/lib/api-client/types/reconciliation.types";

const COLUMN_COUNT = 9;

const HEADERS = ["Order", "Customer", "Order date", "Order amount", "Payment received", "Refund", "Outstanding", "Payment", "Reconciliation"];

export function ReconciliationTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading reconciliation data">
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

interface ReconciliationTableProps {
  items: ReconciliationOrderRow[];
  isFetching: boolean;
}

export function ReconciliationTable({ items, isFetching }: ReconciliationTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header} className={header === "Order amount" || header === "Payment received" || header === "Refund" || header === "Outstanding" ? "text-right" : undefined}>
              {header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Link href={orderDetailHref(row.id)} className="font-medium hover:underline">
                {row.orderNumber}
              </Link>
              {row.externalNumber ? <div className="text-xs text-muted-foreground">{row.externalNumber}</div> : null}
            </TableCell>
            <TableCell>
              <Link href={customerDetailHref(row.customer.leadId)} className="font-medium hover:underline">
                {row.customer.name}
              </Link>
              <div className="text-xs text-muted-foreground">{row.customer.leadNumber}</div>
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(row.orderAmount, row.currency)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(row.paidAmount, row.currency)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(row.refundedAmount, row.currency)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(row.outstandingAmount, row.currency)}</TableCell>
            <TableCell>
              <PaymentStatusBadge status={row.paymentStatus} />
              <div className="mt-0.5 text-xs text-muted-foreground">
                {row.paymentMode ? PAYMENT_MODE_LABELS[row.paymentMode] : "—"}
                {row.paymentProvider ? ` · ${row.paymentProvider}` : ""}
              </div>
            </TableCell>
            <TableCell>
              <ReconciliationStatusBadge status={row.reconciliationStatus} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
