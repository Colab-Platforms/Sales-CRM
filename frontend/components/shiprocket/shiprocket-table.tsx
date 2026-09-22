"use client";

import Link from "next/link";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PAYMENT_MODE_LABELS, formatDateTime, formatMoney } from "@/lib/order-status";
import { customerDetailHref, orderDetailHref } from "@/components/orders/orders-table";
import { ShipmentStatusBadge } from "@/components/orders/shipment-status-badge";
import type { ShipmentListItem } from "@/lib/api-client/types/shiprocket.types";

const COLUMN_COUNT = 9;

const HEADERS = ["Order", "Customer", "AWB", "Courier", "Status", "Payment", "Amount", "Destination", "Last updated"];

export function ShiprocketTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading Shiprocket shipments">
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
          <TableHead className="sr-only">Actions</TableHead>
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

function Destination({ shipment }: { shipment: ShipmentListItem }) {
  const parts = [shipment.destinationCity, shipment.destinationState].filter(Boolean);
  if (parts.length === 0 && !shipment.destinationPincode) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {parts.join(", ") || <span className="text-muted-foreground">—</span>}
      {shipment.destinationPincode ? <div className="text-xs text-muted-foreground">{shipment.destinationPincode}</div> : null}
    </>
  );
}

interface ShiprocketTableProps {
  items: ShipmentListItem[];
  isFetching: boolean;
  onOpenDetail: (id: string) => void;
}

export function ShiprocketTable({ items, isFetching, onOpenDetail }: ShiprocketTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header} className={header === "Amount" ? "text-right" : undefined}>
              {header}
            </TableHead>
          ))}
          <TableHead className="sr-only">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((shipment) => (
          <TableRow key={shipment.id} className="cursor-pointer" onClick={() => onOpenDetail(shipment.id)}>
            <TableCell>
              <Link href={orderDetailHref(shipment.order.id)} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                {shipment.order.orderNumber}
              </Link>
              {shipment.order.externalNumber ? <div className="text-xs text-muted-foreground">{shipment.order.externalNumber}</div> : null}
            </TableCell>
            <TableCell>
              <Link href={customerDetailHref(shipment.customer.leadId)} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                {shipment.customer.name}
              </Link>
              <div className="text-xs text-muted-foreground">{shipment.customer.mobile ?? shipment.customer.leadNumber}</div>
            </TableCell>
            <TableCell>{shipment.awb ? <span className="font-mono text-xs">{shipment.awb}</span> : <span className="text-muted-foreground">Not assigned</span>}</TableCell>
            <TableCell>{shipment.courier ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell>
              <ShipmentStatusBadge status={shipment.status} />
              {shipment.providerStatus ? <div className="mt-0.5 text-xs text-muted-foreground">{shipment.providerStatus}</div> : null}
            </TableCell>
            <TableCell>{shipment.paymentMode ? PAYMENT_MODE_LABELS[shipment.paymentMode] : <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(shipment.amount, shipment.currency)}</TableCell>
            <TableCell>
              <Destination shipment={shipment} />
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDateTime(shipment.updatedAt)}</TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="View shipment"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDetail(shipment.id);
                }}
              >
                <Eye className="size-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
