"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { orderDetailHref, customerDetailHref } from "@/components/orders/orders-table";
import { formatDateTime } from "@/lib/order-status";
import { ActivityTypeBadge } from "./activity-type-badge";
import { AuditSourceBadge } from "./audit-source-badge";
import type { AuditEntry } from "@/lib/api-client/types/audit.types";

const COLUMN_COUNT = 6;
const HEADERS = ["Time", "Actor", "Action", "Entity", "Order / Customer", "Source"];

export function AuditTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading audit trail">
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
                <div className="h-4 w-full max-w-28 animate-pulse rounded bg-muted" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface AuditTableProps {
  items: AuditEntry[];
  isFetching: boolean;
  onOpen: (entry: AuditEntry) => void;
}

export function AuditTable({ items, isFetching, onOpen }: AuditTableProps) {
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
        {items.map((entry) => (
          <TableRow key={entry.id} className="cursor-pointer" onClick={() => onOpen(entry)}>
            <TableCell className="text-muted-foreground">{formatDateTime(entry.occurredAt)}</TableCell>
            <TableCell>
              {entry.actor ? (
                <>
                  <div className="font-medium">{entry.actor.name}</div>
                  {entry.actorRole ? <div className="text-xs text-muted-foreground">{entry.actorRole}</div> : null}
                </>
              ) : (
                <span className="text-muted-foreground">System / integration</span>
              )}
            </TableCell>
            <TableCell>
              <ActivityTypeBadge type={entry.type} />
            </TableCell>
            <TableCell className="text-muted-foreground">{entry.entityType ?? "—"}</TableCell>
            <TableCell>
              {entry.order ? (
                <Link
                  href={orderDetailHref(entry.order.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="font-medium hover:underline"
                >
                  {entry.order.orderNumber}
                </Link>
              ) : null}
              {entry.customer ? (
                <div className={entry.order ? "text-xs text-muted-foreground" : undefined}>
                  <Link href={customerDetailHref(entry.customer.leadId)} onClick={(e) => e.stopPropagation()} className="hover:underline">
                    {entry.customer.name}
                  </Link>
                </div>
              ) : null}
              {!entry.order && !entry.customer ? <span className="text-muted-foreground">—</span> : null}
            </TableCell>
            <TableCell>
              <AuditSourceBadge source={entry.source} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
