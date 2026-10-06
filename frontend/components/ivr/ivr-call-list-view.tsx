"use client";

import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { useCallHistoryList, useCallHistorySummary } from "@/hooks/useCallHistory";
import { IvrFilters, type IvrFilterState } from "./ivr-filters";
import { IvrCallTable, IvrCallTableSkeleton } from "./ivr-call-table";
import { IvrInboundSummaryCards, IvrOutboundSummaryCards } from "./ivr-summary-cards";

const PAGE_SIZE = 20;

/**
 * List view for Leads -> Inbound IVR (the only page that renders this today - outbound calls are
 * reached through each Lead's own Calls & Feedback history instead, with no separate sidebar item
 * or page, so this component's `direction` prop is only ever "INBOUND" in practice; it stays
 * generic because the OUTBOUND code path costs nothing to keep and this exact component was Leads
 * -> IVR -> Outbound's view before that page was removed). Rows are the exact same `Call` rows
 * (`GET /api/calls`, same as the plain Call History page) filtered by `direction` - CallerDesk's
 * own "IVR" = inbound (see backend/src/modules/webhooks/callerdesk/callerdesk.payload.ts's
 * `mapDirection`), which is exactly what already populates `Call.direction`. There is no second
 * data source and no duplicate calling implementation. Every inbound call here is already linked
 * to a Lead (an existing one it matched, or one created for it with source "IVR Inquiry" - see
 * callerdesk.service.ts's correlate()). This is not a separate IVR lead database - rows link to
 * the normal Lead Details / Call Details pages, never a separate IVR detail view.
 */
export function IvrCallListView({ direction }: { direction: "INBOUND" | "OUTBOUND" }) {
  const isInbound = direction === "INBOUND";
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<IvrFilterState>({});

  const listParams = useMemo(() => ({ page, limit: PAGE_SIZE, direction, ...filters }), [page, direction, filters]);
  const summaryParams = useMemo(() => ({ direction, ...filters }), [direction, filters]);

  const { data, isLoading, error, refetch } = useCallHistoryList(listParams);
  const { data: summary, isLoading: summaryLoading } = useCallHistorySummary(summaryParams);

  function handleFiltersChange(next: IvrFilterState) {
    setFilters(next);
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={isInbound ? "Leads · IVR Inbound" : "Leads · IVR Outbound"}
        description={
          isInbound
            ? "Leads created or matched from inbound CallerDesk IVR calls. Open a row to see the full Lead, its call and recording."
            : "Outbound calls placed from the CRM via CallerDesk, shown here for reporting - each row is already part of its Lead's own call history."
        }
      />

      {isInbound ? <IvrInboundSummaryCards summary={summary} isLoading={summaryLoading} /> : <IvrOutboundSummaryCards summary={summary} isLoading={summaryLoading} />}

      <IvrFilters value={filters} onChange={handleFiltersChange} />

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
        <IvrCallTableSkeleton />
      ) : (
        <IvrCallTable direction={direction} calls={data?.data ?? []} pagination={data?.pagination} onPageChange={setPage} />
      )}
    </div>
  );
}
