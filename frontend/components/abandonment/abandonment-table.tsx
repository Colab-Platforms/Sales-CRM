"use client";

import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { AbandonmentStatusBadge, RECOVERY_ACTION_TYPE_LABELS } from "./abandonment-status-badge";
import type { AbandonmentListItem } from "@/lib/api-client/types/abandonment.types";

const COLUMN_COUNT = 7;
const HEADERS = ["Lead", "Contact", "Items", "Value", "Detected", "Status", "Last action"];

// A short, plain list of what was in the cart - never the flattened "value · items · stage · link"
// text some rows still carry from before cartSnapshot existed (see `summary`'s fallback usage below).
function CartItems({ item }: { item: AbandonmentListItem }) {
  const names = item.cartSnapshot?.itemNames ?? [];
  if (names.length === 0) return <span className="text-sm text-muted-foreground">{item.summary ?? "—"}</span>;
  const extra = (item.cartSnapshot?.itemCount ?? names.length) - names.length;
  return (
    <span className="line-clamp-2 text-sm">
      {names.join(", ")}
      {extra > 0 ? <span className="text-muted-foreground"> +{extra} more</span> : null}
    </span>
  );
}

export function AbandonmentTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table aria-busy="true" aria-label="Loading abandoned leads">
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

// How long ago detection happened, in the coarse "act now" granularity a telecaller cares about -
// abandoned-cart recovery rates drop sharply within the first hour, so minutes matter here in a way
// they don't for e.g. an order placed date.
function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface AbandonmentTableProps {
  items: AbandonmentListItem[];
  isFetching: boolean;
  onOpenDetail: (id: string) => void;
}

export function AbandonmentTable({ items, isFetching, onOpenDetail }: AbandonmentTableProps) {
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {HEADERS.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
          <TableHead className="sr-only">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id} className="cursor-pointer" onClick={() => onOpenDetail(item.id)}>
            <TableCell>
              <div className="font-medium">{item.lead.name}</div>
              <div className="text-xs text-muted-foreground">{item.lead.leadNumber}</div>
            </TableCell>
            <TableCell>
              {item.lead.mobile ?? <span className="text-muted-foreground">—</span>}
              {item.lead.email ? <div className="text-xs text-muted-foreground">{item.lead.email}</div> : null}
            </TableCell>
            <TableCell className="max-w-64">
              <CartItems item={item} />
            </TableCell>
            <TableCell className="tabular-nums">
              {item.cartSnapshot?.cartValue ? formatMoney(item.cartSnapshot.cartValue, item.cartSnapshot.currency ?? "INR") : "—"}
            </TableCell>
            <TableCell>
              <span title={formatDateTime(item.detectedAt)}>{timeSince(item.detectedAt)}</span>
            </TableCell>
            <TableCell>
              <AbandonmentStatusBadge status={item.status} />
            </TableCell>
            <TableCell>
              {item.latestRecoveryAction ? (
                <span className="text-sm">{RECOVERY_ACTION_TYPE_LABELS[item.latestRecoveryAction.type]}</span>
              ) : (
                <span className="text-muted-foreground">No action yet</span>
              )}
            </TableCell>
            <TableCell>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="View abandonment"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDetail(item.id);
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
