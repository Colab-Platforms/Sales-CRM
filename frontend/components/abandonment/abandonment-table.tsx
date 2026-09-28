"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDateTime, formatMoney } from "@/lib/order-status";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { leadDetailHref } from "@/components/leads/lead-table";
import { RECOVERY_ACTION_TYPE_LABELS } from "./abandonment-status-badge";
import { parseAbandonmentCart } from "./abandonment-cart-utils";
import type { AbandonmentListItem } from "@/lib/api-client/types/abandonment.types";

const COLUMN_COUNT = 9;
const HEADERS = [
  { label: "Lead", className: "w-[180px] min-w-[150px]" },
  { label: "Contact", className: "w-[180px] min-w-[160px]" },
  { label: "Items", className: "min-w-[220px] max-w-[320px]" },
  { label: "Value", className: "w-[120px] text-right" },
  { label: "Detected", className: "w-[110px]" },
  { label: "Lead Status", className: "w-[120px]" },
  { label: "Last action", className: "w-[140px]" },
  { label: "Assigned to", className: "w-[160px]" },
];

function CartItems({ item }: { item: AbandonmentListItem }) {
  const cart = parseAbandonmentCart(item);
  const names = cart.itemNames;

  if (names.length === 0) {
    if (cart.itemCount) {
      return <span className="text-sm font-medium text-foreground">{cart.itemCount} items in cart</span>;
    }
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const extra = (cart.itemCount ?? names.length) - names.length;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground" title={names.join(", ")}>
        {names.join(", ")}
      </span>
      {extra > 0 ? (
        <span className="text-xs text-muted-foreground">
          +{extra} more item{extra > 1 ? "s" : ""}
        </span>
      ) : null}
    </div>
  );
}

export function AbandonmentTableSkeleton({ rows = 6, withSelection = false }: { rows?: number; withSelection?: boolean }) {
  return (
    <Table aria-busy="true" aria-label="Loading abandoned leads">
      <TableHeader>
        <TableRow>
          {withSelection ? <TableHead className="w-12">&nbsp;</TableHead> : null}
          {HEADERS.map((header) => (
            <TableHead key={header.label} className={header.className}>
              {header.label}
            </TableHead>
          ))}
          <TableHead className="w-[50px] sr-only">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, i) => (
          <TableRow key={i}>
            {Array.from({ length: COLUMN_COUNT + (withSelection ? 1 : 0) }).map((__, j) => (
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
  selectedIds?: Set<string>;
  onToggleOne?: (id: string, checked: boolean) => void;
  onToggleAll?: (checked: boolean) => void;
}

export function AbandonmentTable({ items, isFetching, selectedIds, onToggleOne, onToggleAll }: AbandonmentTableProps) {
  const router = useRouter();
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  }, [items]);
  const withSelection = Boolean(selectedIds && onToggleOne && onToggleAll);
  const allSelected = withSelection && sortedItems.length > 0 && sortedItems.every((item) => selectedIds!.has(item.id));

  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <TableHeader>
        <TableRow>
          {withSelection ? (
            <TableHead className="w-12">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) => onToggleAll!(e.target.checked)}
                aria-label="Select all abandoned leads"
              />
            </TableHead>
          ) : null}
          {HEADERS.map((header) => (
            <TableHead key={header.label} className={header.className}>
              {header.label}
            </TableHead>
          ))}
          <TableHead className="w-[50px] sr-only">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedItems.map((item) => {
          const cart = parseAbandonmentCart(item);
          const assignee = item.lead.owner?.name ?? item.lead.assignedManager?.name ?? null;

          return (
            <TableRow
              key={item.id}
              className="cursor-pointer"
              data-state={withSelection && selectedIds!.has(item.id) ? "selected" : undefined}
              onClick={() => router.push(leadDetailHref(item.lead.id))}
            >
              {withSelection ? (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds!.has(item.id)}
                    onChange={(e) => onToggleOne!(item.id, e.target.checked)}
                    aria-label={`Select ${item.lead.name}`}
                  />
                </TableCell>
              ) : null}
              <TableCell className="w-[180px] min-w-[150px]">
                <div className="font-semibold text-foreground">{item.lead.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{item.lead.leadNumber}</div>
              </TableCell>

              <TableCell className="w-[180px] min-w-[160px]">
                {item.lead.mobile ? (
                  <div className="font-medium text-foreground">{item.lead.mobile}</div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {item.lead.email ? (
                  <div className="truncate max-w-[160px] text-xs text-muted-foreground" title={item.lead.email}>
                    {item.lead.email}
                  </div>
                ) : null}
              </TableCell>

              <TableCell className="min-w-[220px] max-w-[320px] whitespace-normal">
                <CartItems item={item} />
              </TableCell>

              <TableCell className="w-[120px] text-right font-semibold tabular-nums text-foreground">
                {cart.cartValue ? formatMoney(cart.cartValue, cart.currency) : "—"}
              </TableCell>

              <TableCell className="w-[110px] whitespace-nowrap text-sm text-muted-foreground">
                <span title={formatDateTime(item.detectedAt)}>{timeSince(item.detectedAt)}</span>
              </TableCell>

              <TableCell className="w-[120px] whitespace-nowrap">
                <StatusBadge status={item.lead.workingStatus} />
              </TableCell>

              <TableCell className="w-[140px] whitespace-nowrap text-sm">
                {item.latestRecoveryAction ? (
                  <span className="font-medium text-foreground">
                    {RECOVERY_ACTION_TYPE_LABELS[item.latestRecoveryAction.type]}
                  </span>
                ) : (
                  <span className="text-muted-foreground">No action yet</span>
                )}
              </TableCell>

              <TableCell className="w-[160px] whitespace-nowrap text-sm">
                {assignee ? <span className="text-foreground">{assignee}</span> : <span className="text-muted-foreground">Unassigned</span>}
              </TableCell>

              <TableCell className="w-[50px] text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="View lead"
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(leadDetailHref(item.lead.id));
                  }}
                >
                  <Eye className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
