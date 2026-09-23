"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { useCallHistoryList } from "@/hooks/useCallHistory";
import { CallHistoryFilters, type CallHistoryFilterState } from "./call-history-filters";
import { CallHistoryTable, CallHistoryTableSkeleton } from "./call-history-table";

const PAGE_SIZE = 20;

/** Backed by the real `GET /api/calls` — see lib/api-client/types/call-history.types.ts. */
export function CallHistoryView() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<CallHistoryFilterState>({});

  const params = useMemo(() => ({ page, limit: PAGE_SIZE, ...filters }), [page, filters]);
  const { data, isLoading, error, refetch } = useCallHistoryList(params);

  function handleFiltersChange(next: CallHistoryFilterState) {
    setFilters(next);
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Call History"
        description="Every call placed from a lead's details page, across your team."
      />

      <CallHistoryFilters value={filters} onChange={handleFiltersChange} />

      {error ? (
        <div role="alert" className="sketch-outline flex flex-col items-start gap-3 border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4" aria-hidden="true" />
            {error}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      ) : isLoading ? (
        <CallHistoryTableSkeleton />
      ) : (
        <CallHistoryTable calls={data?.data ?? []} pagination={data?.pagination} onPageChange={setPage} />
      )}
    </div>
  );
}
