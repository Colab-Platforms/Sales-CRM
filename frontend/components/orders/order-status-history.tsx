"use client";

import { useOrderStatusHistory } from "@/hooks/useOrders";
import { Skeleton } from "@/components/ui/skeleton";
import { TimelineEvent, TimelineList } from "./order-detail-parts";

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
        <TimelineList>
          {data.entries.map((entry) => (
            <TimelineEvent key={entry.id} source="CRM" title={entry.title} at={entry.occurredAt} detail={[entry.description, entry.actor?.name].filter(Boolean).join(" · ") || null} />
          ))}
        </TimelineList>
      )}
      <p className="text-xs text-muted-foreground">
        Shows recorded milestones only. Detailed status-by-status changes will appear once status tracking is added.
      </p>
    </div>
  );
}
