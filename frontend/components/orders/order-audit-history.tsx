"use client";

import { useState } from "react";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityTypeBadge } from "@/components/audit/activity-type-badge";
import { AuditSourceBadge } from "@/components/audit/audit-source-badge";
import { AccentCard, SectionTitle, TimelineList } from "./order-detail-parts";
import { OrdersPagination } from "./orders-pagination";
import { useOrderAudit } from "@/hooks/useAudit";
import { formatDateTime } from "@/lib/order-status";

const PAGE_SIZE = 10;

// A separate, entity-level record of every write to this order (and its payments/shipments) - not a
// replacement for the "Status" / "Fulfilment & Shipment" sections above, which show a curated,
// business-friendly view of the same order. This section is the raw, auditor-facing trail: every
// event, its actor (or system/integration source), and the exact old/new values recorded.
export function OrderAuditHistory({ orderId }: { orderId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, isFetching, error } = useOrderAudit(orderId, { page, pageSize: PAGE_SIZE });

  return (
    <AccentCard accent="slate">
      <SectionTitle icon={<ScrollText />}>Audit History</SectionTitle>
      <CardContent className={isFetching ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading audit history">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : error || !data ? (
          <p className="text-sm text-destructive">{error ?? "Failed to load audit history."}</p>
        ) : data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit events recorded for this order yet.</p>
        ) : (
          <TimelineList>
            {data.items.map((entry) => (
              <li key={entry.id} className="relative pl-6">
                <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-slate-400 bg-background" aria-hidden="true" />
                <div className="flex flex-wrap items-center gap-2">
                  <AuditSourceBadge source={entry.source} />
                  <ActivityTypeBadge type={entry.type} />
                </div>
                <p className="mt-1 text-sm font-medium">{entry.title}</p>
                {entry.description ? <p className="text-sm text-muted-foreground">{entry.description}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(entry.occurredAt)}
                  {entry.actor ? ` · ${entry.actor.name}` : ""}
                </p>
              </li>
            ))}
          </TimelineList>
        )}
        {data ? <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={isFetching} /> : null}
      </CardContent>
      <CardFooter>
        <Link href={`/dashboard/audit?orderId=${orderId}`} className="text-sm text-primary hover:underline">
          View in Audit Trail
        </Link>
      </CardFooter>
    </AccentCard>
  );
}
