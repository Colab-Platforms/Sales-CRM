"use client";

import { useState } from "react";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CancelOrderDialog, RevertCancellationButton } from "./cancel-order-button";
import type { LiveOrderListItem, OrderListItem } from "@/lib/api-client/types/orders.types";

type RowOrder = OrderListItem | LiveOrderListItem;

// Cancel / Revert straight from an Orders list row. Both are the SAME dialogs, mutations and endpoints Order Detail
// uses (CancelOrderDialog / RevertCancellationButton) - nothing here calls the API itself. The dialogs are rendered
// inside this row's own cell and are given this row's id/orderNumber, so a confirmation can only ever act on (and
// name) the order whose button was clicked.
//
// Only CRM-backed orders get an action: a Shopify order the CRM has not synced has no CRM status to cancel/restore,
// and Shopify cannot un-cancel an order, so those keep Order Detail's own (admin-only, permanent) cancel.
export function OrderRowActions({ order }: { order: RowOrder }) {
  const [open, setOpen] = useState(false);

  if ("linkedInCrm" in order && !order.linkedInCrm) return <span className="text-xs text-muted-foreground">—</span>;
  if (!order.status) return <span className="text-xs text-muted-foreground">—</span>;

  const target = { id: order.id, orderNumber: order.orderNumber, externalNumber: order.externalNumber };

  if (order.status === "CANCELLED") return <RevertCancellationButton order={target} />;

  const hasPaid = order.paymentStatus === "SUCCESS" || order.paymentStatus === "PARTIALLY_REFUNDED";
  const mayHaveOpenLink = order.paymentMode === "PREPAID" && !hasPaid;

  return (
    <>
      <Button type="button" variant="destructive" size="sm" aria-label={`Cancel order ${order.orderNumber}`} onClick={() => setOpen(true)}>
        <Ban data-icon="inline-start" />
        Cancel Order
      </Button>
      <CancelOrderDialog open={open} onOpenChange={setOpen} order={target} hasPaid={hasPaid} hasOpenLink={mayHaveOpenLink} />
    </>
  );
}
