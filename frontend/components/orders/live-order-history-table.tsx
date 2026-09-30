"use client";

import { useState } from "react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrdersCursorPagination } from "./orders-cursor-pagination";
import { orderDetailHref } from "./orders-table";
import { useLiveOrderHistory } from "@/hooks/useOrders";
import { formatDate, formatMoney } from "@/lib/order-status";

const PAGE_SIZE = 10;

// "Previous Orders" (Section 11) on the live Order Detail page - the Shopify customer's other orders,
// cursor-paginated (never the whole history). Self-contained state (own cursor stack), same pattern as
// live-customers-panel.tsx. Each row links to the existing CRM Order Detail when already synced, or the
// live Shopify Order Detail otherwise - orderDetailHref handles both id shapes already.
export function LiveOrderHistoryTable({ shopifyCustomerId, excludeExternalId }: { shopifyCustomerId: string; excludeExternalId: string }) {
  const [afterStack, setAfterStack] = useState<string[]>([]);
  const currentAfter = afterStack.length > 0 ? afterStack[afterStack.length - 1] : undefined;

  const { data, isLoading, isFetching, error } = useLiveOrderHistory(shopifyCustomerId, {
    first: PAGE_SIZE,
    after: currentAfter,
    excludeExternalId,
  });

  const handleNext = () => {
    if (data?.pageInfo.endCursor) setAfterStack((stack) => [...stack, data.pageInfo.endCursor!]);
  };
  const handlePrevious = () => setAfterStack((stack) => stack.slice(0, -1));

  let content;
  if (isLoading) {
    content = <p className="py-6 text-center text-sm text-muted-foreground">Loading previous orders…</p>;
  } else if (error || data?.error) {
    content = <p className="py-6 text-center text-sm text-destructive">{error ?? data?.error}</p>;
  } else if (!data || data.items.length === 0) {
    content = <p className="py-6 text-center text-sm text-muted-foreground">No previous orders for this customer.</p>;
  } else {
    content = (
      <>
        <Table className={isFetching ? "opacity-60 transition-opacity" : undefined}>
          <TableHeader>
            <TableRow>
              <TableHead>Previous Order</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead>Fulfilment</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <Link href={orderDetailHref(item.id)} className="font-medium hover:underline">
                    {item.orderNumber}
                  </Link>
                  {!item.linkedInCrm ? <div className="text-xs text-muted-foreground">Not synced to CRM</div> : null}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">Shopify</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(item.totalAmount, item.currency)}</TableCell>
                <TableCell>{item.financialStatus ?? "—"}</TableCell>
                <TableCell>{item.fulfillmentStatus ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(item.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <OrdersCursorPagination
          hasNextPage={data.pageInfo.hasNextPage}
          hasPreviousPage={afterStack.length > 0}
          onNext={handleNext}
          onPrevious={handlePrevious}
          disabled={isFetching}
        />
      </>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Previous Orders</CardTitle>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
