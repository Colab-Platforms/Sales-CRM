"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { customerDetailHref } from "@/components/orders/orders-table";
import { formatMoney } from "@/lib/order-status";
import type { LiveCustomerListItem } from "@/lib/api-client/types/customers.types";

const COLUMN_COUNT = 6;
const HEADERS = ["Customer", "Phone / Email", "Shopify orders", "Amount spent", "Owner", "CRM status"];

export function CustomersLiveTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading live Shopify customers">
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

interface CustomersLiveTableProps {
  items: LiveCustomerListItem[];
  isFetching: boolean;
}

export function CustomersLiveTable({ items, isFetching }: CustomersLiveTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((customer) => (
          <TableRow key={customer.id}>
            <TableCell>
              {customer.leadId ? (
                <Link href={customerDetailHref(customer.leadId)} className="font-medium hover:underline">
                  {customer.name}
                </Link>
              ) : (
                <span className="font-medium">{customer.name}</span>
              )}
              <div className="text-xs text-muted-foreground">{customer.leadNumber ?? `Shopify #${customer.externalId}`}</div>
            </TableCell>
            <TableCell className="text-muted-foreground">
              <div>{customer.phone ?? "—"}</div>
              <div className="text-xs">{customer.email ?? "—"}</div>
            </TableCell>
            <TableCell className="tabular-nums">{customer.numberOfOrders ?? "—"}</TableCell>
            <TableCell className="tabular-nums">{customer.amountSpent ? formatMoney(customer.amountSpent.amount, customer.amountSpent.currencyCode) : "—"}</TableCell>
            <TableCell>{customer.owner?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell>
              {customer.linkedInCrm ? (
                <span className="text-xs text-muted-foreground">Linked</span>
              ) : (
                <span className="text-xs font-medium text-amber-600">Not synced to CRM</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
