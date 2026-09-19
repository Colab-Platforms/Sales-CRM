"use client";

import { useOrderStatusHistory } from "@/hooks/useOrders";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/order-status";

export function OrderStatusHistory({ orderId }: { orderId: string }) {
  const { data, isLoading, error } = useOrderStatusHistory(orderId);

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading status history">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-sm text-destructive">{error ?? "Failed to load status history."}</p>;
  }

  return (
    <div className="space-y-3">
      {data.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No status events have been recorded for this order yet.</p>
      ) : (
        <ol className="space-y-3 border-l pl-4">
          {data.entries.map((entry) => (
            <li key={entry.id} className="relative">
              <span className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary" aria-hidden="true" />
              <p className="text-sm font-medium">{entry.title}</p>
              {entry.description ? <p className="text-sm text-muted-foreground">{entry.description}</p> : null}
              <p className="text-xs text-muted-foreground">
                {formatDateTime(entry.occurredAt)}
                {entry.actor ? ` · ${entry.actor.name}` : null}
              </p>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted-foreground">
        Shows recorded milestones only. Detailed status-by-status changes will appear once status tracking is added.
      </p>
    </div>
  );
}
