"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ORDER_SOURCE_LABELS, PAYMENT_MODE_LABELS, formatDate, formatMoney } from "@/lib/order-status";
import { OrderStatusBadge } from "./order-status-badge";
import { PaymentStatusBadge } from "./payment-status-badge";
import { OrderRowActions } from "./order-row-actions";
import { OrderTagChips } from "./order-tag-chips";
import type { LiveOrderListItem, OrderListItem } from "@/lib/api-client/types/orders.types";

// Accepts either the CRM-DB-backed list item or the live-Shopify one. The live one's customer link is
// nullable for a Shopify order the CRM hasn't synced yet (ADMIN-only, see orders.live.service.ts) -
// "Not synced to CRM" is shown as an ADDITIONAL caption below the real status/payment badges (which
// now always reflect Shopify's own data, synced or not), never as a stand-in for missing status.
type TableOrderItem = OrderListItem | LiveOrderListItem;

function hasShopifyDisplayFields(order: TableOrderItem): order is LiveOrderListItem {
  return "fulfillmentStatus" in order;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const COLUMN_COUNT = 9;

const HEADERS = [
  "Order",
  "Customer",
  "Order source",
  "Total",
  "Payment",
  "Status",
  "Tags",
  "Date",
  "Actions",
];

export function orderDetailHref(id: string) {
  return `/dashboard/orders/${id}`;
}

export function customerDetailHref(leadId: string) {
  return `/dashboard/customers/${leadId}`;
}

/** Row checkboxes, shown only when the list offers "Download selected orders". */
export interface OrdersSelection {
  selected: ReadonlySet<string>;
  onToggle: (ids: string[], checked: boolean) => void;
  /** While rows are being replaced, so a row about to disappear cannot be ticked. */
  disabled?: boolean;
}

function SelectBox({ label, checked, partly = false, disabled, onChange }: { label: string; checked: boolean; partly?: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="size-3.5 cursor-pointer align-middle accent-primary disabled:cursor-default"
      checked={checked}
      disabled={disabled}
      ref={(el) => {
        if (el) el.indeterminate = partly;
      }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

// `filters` maps a header title to its column-filter funnel (see orders-header-filters.tsx); headers without one stay plain.
function OrdersTableHeader({ filters, selectAll }: { filters?: Record<string, ReactNode>; selectAll?: ReactNode }) {
  return (
    <TableHeader>
      <TableRow>
        {selectAll ? <TableHead className="w-8">{selectAll}</TableHead> : null}
        {HEADERS.map((header) => (
          <TableHead key={header} className={header === "Total" || header === "Actions" ? "text-right" : undefined}>
            <span className="inline-flex items-center whitespace-nowrap">
              {header}
              {filters?.[header] ?? null}
            </span>
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
  /** Column-filter funnels by header title. */
  headerFilters?: Record<string, ReactNode>;
  selection?: OrdersSelection;
}

export function OrdersTable({ items, isFetching, onOpen, headerFilters, selection }: OrdersTableProps) {
  const pageSelected = selection ? items.filter((o) => selection.selected.has(o.id)).length : 0;
  return (
    <Table className={cn("transition-opacity", isFetching && "opacity-60")}>
      <OrdersTableHeader
        filters={headerFilters}
        selectAll={
          selection ? (
            <SelectBox
              label="Select all orders on this page"
              checked={items.length > 0 && pageSelected === items.length}
              partly={pageSelected > 0 && pageSelected < items.length}
              disabled={selection.disabled || items.length === 0}
              onChange={(checked) => selection.onToggle(items.map((o) => o.id), checked)}
            />
          ) : undefined
        }
      />
      <TableBody>
        {items.map((order) => (
          <TableRow key={order.id} className="cursor-pointer" onClick={() => onOpen(order.id)}>
            {selection ? (
              <TableCell onClick={(e) => e.stopPropagation()}>
                <SelectBox label={`Select order ${order.orderNumber}`} checked={selection.selected.has(order.id)} disabled={selection.disabled} onChange={(checked) => selection.onToggle([order.id], checked)} />
              </TableCell>
            ) : null}
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
            <TableCell>{ORDER_SOURCE_LABELS[order.source]}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(order.totalAmount, order.currency)}</TableCell>
            <TableCell>
              <PaymentStatusBadge status={order.paymentStatus} />
              {order.paymentMode ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {/* e.g. "Standard (Prepaid)" - Shopify's own shipping method plus the payment mode
                      derived from Shopify's own gateway/COD data (see shopify.mapper.ts's isCodOrder),
                      shown together compactly rather than as separate columns. */}
                  {hasShopifyDisplayFields(order) && order.shippingMethod
                    ? `${order.shippingMethod} (${PAYMENT_MODE_LABELS[order.paymentMode]})`
                    : PAYMENT_MODE_LABELS[order.paymentMode]}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              {order.status ? <OrderStatusBadge status={order.status} /> : <span className="text-xs text-muted-foreground">Unknown</span>}
              {hasShopifyDisplayFields(order) && order.fulfillmentStatus ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {titleCase(order.fulfillmentStatus)}
                  {order.fulfillmentStatus.includes("FULFILLED") && order.fulfillmentStatus !== "UNFULFILLED" ? (order.hasTracking ? " · Tracking added" : " · No tracking") : ""}
                </div>
              ) : null}
              {hasShopifyDisplayFields(order) && !order.linkedInCrm ? (
                <div className="mt-0.5 text-xs text-muted-foreground">Not synced to CRM</div>
              ) : null}
            </TableCell>
            <TableCell>
              <OrderTagChips tags={order.tags} />
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(order.createdAt)}</TableCell>
            {/* stopPropagation: the row itself navigates on click, and React bubbles events from the dialogs
                (portalled, but still inside this cell's React tree) up through here too. */}
            <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
              <OrderRowActions order={order} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
