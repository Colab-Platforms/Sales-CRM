"use client";

import { useQuery } from "@tanstack/react-query";
import { bucketSummaryQueryOptions } from "@/lib/api-client/queries/lead.queries";
import type { BucketKind } from "@/lib/api-client/types/lead.types";
import { Button } from "@/components/ui/button";

export function BucketSummary({ onShowRinging, kind = "LEAD" }: { onShowRinging: () => void; kind?: BucketKind }) {
  const { data, isPending } = useQuery(bucketSummaryQueryOptions(kind));

  if (isPending || !data || data.length === 0) return null;

  const emptyCount = data.filter((row) => row.isEmpty).length;

  return (
    <div className="sketch-outline space-y-3 bg-card/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">Today&apos;s buckets</h2>
          <p className="text-xs text-muted-foreground">
            {emptyCount > 0
              ? `${emptyCount} salesperson(s) have an empty bucket. Select RINGING leads and assign them.`
              : "Leads each salesperson still has to work today."}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onShowRinging}>
          Show RINGING leads
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {data.map((row) => (
          <div
            key={row.salespersonId}
            className={`rounded-md border p-3 text-sm ${row.isEmpty ? "border-destructive/40 bg-destructive/10" : "bg-background"}`}
          >
            <div className="truncate font-medium">{row.name}</div>
            <div className="text-xs text-muted-foreground">
              {row.isEmpty ? "Bucket empty" : `${row.remaining} remaining`} · {row.done}/{row.total} worked
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
