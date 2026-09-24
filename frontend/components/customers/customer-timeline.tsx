"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { orderDetailHref } from "@/components/orders/orders-table";
import { useCustomerTimeline } from "@/hooks/useCustomers";
import { formatDateTime } from "@/lib/order-status";
import { TIMELINE_EVENT_LABELS } from "@/lib/customer-status";

const PAGE_SIZE = 15;

export function CustomerTimeline({ leadId }: { leadId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, isFetching, error } = useCustomerTimeline(leadId, { page, pageSize: PAGE_SIZE });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3" aria-busy="true" aria-label="Loading timeline">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64" />
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{error ?? "Failed to load timeline."}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent className={isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity has been recorded for this customer yet.</p>
        ) : (
          <ol className="space-y-4 border-l pl-4">
            {data.entries.map((entry) => (
              <li key={entry.id} className="relative">
                <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary" aria-hidden="true" />
                <p className="text-xs font-medium text-muted-foreground">{TIMELINE_EVENT_LABELS[entry.type]}</p>
                <p className="text-sm font-medium">{entry.title}</p>
                {entry.description ? <p className="text-sm text-muted-foreground">{entry.description}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(entry.occurredAt)}
                  {entry.actor ? ` · ${entry.actor.name}` : null}
                  {entry.order ? (
                    <>
                      {" · "}
                      <Link href={orderDetailHref(entry.order.id)} className="hover:underline">
                        Order {entry.order.orderNumber}
                      </Link>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ol>
        )}
        <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={isFetching} />
      </CardContent>
    </Card>
  );
}
