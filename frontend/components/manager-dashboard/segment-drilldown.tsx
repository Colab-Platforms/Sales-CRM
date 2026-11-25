"use client";

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import { toast } from "sonner";
import { managerAnalyticsApi } from "@/lib/api-client/endpoints/manager.api";
import type { AnalyticsQuery } from "@/lib/api-client/types/manager-analytics.types";
import type { SegmentDetails, SegmentDrillMetric } from "@/lib/api-client/types/segment-report.types";
import { getErrorMessage } from "@/lib/api-client/client";
import { formatNumber } from "@/lib/manager-analytics";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Panel } from "./panel";

// The records behind one metric card of the segment report, shown inline below the cards. Everything (filtering, counting, paging) is the server's; this only displays one page of it.

export const DRILL_PAGE_SIZE = 25;

export const DRILL_TITLES: Record<SegmentDrillMetric, { title: string; description: string; empty: string }> = {
  totalLeads: { title: "Total leads", description: "Every lead of this segment that the Leads section lists.", empty: "No leads match the selected filters." },
  contacted: { title: "Contacted leads", description: "Every lead that is not Pending (includes Converted and Lost).", empty: "No contacted leads match the selected filters." },
  pending: { title: "Pending leads", description: "Status New or Assigned, never called or marked contacted (any date).", empty: "No pending leads match the selected filters." },
  converted: { title: "Converted leads", description: "Current status Converted. Converted customers are in the separate “Not in the Leads list” panel.", empty: "No listed lead has the status Converted." },
  lost: { title: "Lost leads", description: "Current status Not Interested or DND.", empty: "No lost leads match the selected filters." },
  calls: { title: "Calls", description: "Each call of the selected period on these leads (narrowed by the call filter).", empty: "No calls in this period." },
  followUpsCompleted: { title: "Follow-ups completed", description: "Follow-ups and callbacks completed in the selected period.", empty: "No follow-ups were completed in this period." },
  followUpsPending: { title: "Follow-ups pending", description: "Follow-ups and callbacks open now, whatever the date range; the longest overdue first.", empty: "No follow-ups are pending." },
  activities: { title: "Recorded activities", description: "Each activity recorded on these leads in the selected period.", empty: "No activity was recorded in this period." },
};

const words = (v: string) => v.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const duration = (seconds: number | null) => (seconds === null ? "—" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`);

type Column = { head: string; cell: React.ReactNode; wide?: boolean; numeric?: boolean };

function Grid({ rows }: { rows: { id: string; cells: Column[] }[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {rows[0]!.cells.map((c) => (
              <TableHead key={c.head} className={`first:pl-5 last:pr-5 ${c.numeric ? "text-right" : ""}`}>
                {c.head}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              {r.cells.map((c) => (
                <TableCell key={c.head} className={`first:pl-5 last:pr-5 ${c.numeric ? "text-right tabular-nums" : ""} ${c.wide ? "max-w-sm min-w-48 whitespace-normal break-words" : ""}`}>
                  {c.cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const leadName = (name: string, number: string) => (
  <>
    <span className="font-medium">{name || number}</span>
    <span className="block text-xs text-muted-foreground">{number}</span>
  </>
);

/** The table for whichever kind of record the card counts. */
export function DrillTable({ data }: { data: SegmentDetails }) {
  if (data.rows.length === 0) return <EmptyState>{DRILL_TITLES[data.metric].empty}</EmptyState>;
  if (data.kind === "calls") {
    return (
      <Grid
        rows={data.rows.map((c) => ({
          id: c.id,
          cells: [
            { head: "Lead", cell: leadName(c.leadName, c.leadNumber) },
            { head: "Phone", cell: c.phone ?? "—" },
            { head: "Telecaller / salesperson", cell: c.agent ?? "—" },
            { head: "Date and time", cell: dateTime(c.at) },
            { head: "Status / outcome", cell: `${words(c.direction)} · ${words(c.status)}${c.outcome ? ` · ${c.outcome}` : ""}` },
            { head: "Duration", cell: duration(c.durationSeconds), numeric: true },
            { head: "Notes", cell: c.notes || "—", wide: true },
          ],
        }))}
      />
    );
  }
  if (data.kind === "followUps") {
    return (
      <Grid
        rows={data.rows.map((t) => ({
          id: t.id,
          cells: [
            { head: "Lead", cell: leadName(t.leadName, t.leadNumber) },
            { head: "Phone", cell: t.phone ?? "—" },
            { head: "Assigned salesperson", cell: t.assignedTo ?? "—" },
            { head: "Follow-up date and time", cell: dateTime(t.scheduledAt) },
            {
              head: "Status",
              cell: (
                <>
                  {words(t.status)}
                  {t.overdue ? <span className="text-destructive"> · Overdue</span> : null}
                  {t.completedAt ? <span className="block text-xs text-muted-foreground">Completed {dateTime(t.completedAt)}</span> : null}
                </>
              ),
            },
            { head: "Notes", cell: [t.title, t.notes].filter(Boolean).join(" — ") || "—", wide: true },
          ],
        }))}
      />
    );
  }
  if (data.kind === "activities") {
    return (
      <Grid
        rows={data.rows.map((a) => ({
          id: a.id,
          cells: [
            { head: "Lead", cell: leadName(a.leadName, a.leadNumber) },
            { head: "Phone", cell: a.phone ?? "—" },
            { head: "Activity type", cell: words(a.type) },
            { head: "Description", cell: [a.title, a.description].filter(Boolean).join(" — ") || "—", wide: true },
            { head: "Performed by", cell: a.by ?? "—" },
            { head: "Date and time", cell: dateTime(a.at) },
          ],
        }))}
      />
    );
  }
  return (
    <Grid
      rows={data.rows.map((l) => ({
        id: l.id,
        cells: [
          { head: "Lead", cell: leadName(l.name, l.leadNumber) },
          { head: "Phone", cell: l.phone ?? "—" },
          { head: "Assigned salesperson", cell: l.salesperson ?? "Unassigned" },
          { head: "Current status", cell: words(l.status) },
          { head: "Source", cell: l.source ?? "—" },
          { head: "Last activity", cell: dateTime(l.lastActivityAt) },
          { head: "Last contacted", cell: dateTime(l.lastContactedAt) },
          { head: "Calls in period", cell: formatNumber(l.calls), numeric: true },
          { head: "Activities in period", cell: formatNumber(l.activities), numeric: true },
          { head: "Follow-ups done / pending", cell: `${formatNumber(l.followUpsCompleted)} / ${formatNumber(l.followUpsPending)}`, numeric: true },
        ],
      }))}
    />
  );
}

/** What the panel shows for each state of the request. Kept apart from the data fetching so every state can be tested. */
export function DrillContent({ metric, data, isPending, error, onRetry }: { metric: SegmentDrillMetric; data: SegmentDetails | undefined; isPending: boolean; error: unknown; onRetry: () => void }) {
  if (error && !data) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm text-destructive">
        {getErrorMessage(error, `Failed to load ${DRILL_TITLES[metric].title.toLowerCase()}.`)}
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (isPending || !data) {
    return (
      <div className="space-y-2 p-5" role="status" aria-label="Loading records">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
    );
  }
  return (
    <>
      {error ? (
        // a refresh failed but earlier records are on screen: say so rather than letting them pass for current
        <div role="alert" className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm text-destructive">
          Could not refresh these records, so they may be out of date. {getErrorMessage(error, "Please try again.")}
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      <DrillTable data={data} />
    </>
  );
}

/** The inline panel for the selected card. Give it `key={metric}` so each card starts at page 1; the report section is itself rebuilt when any filter changes. */
export function SegmentDrillDown({ query, metric, cardCount, onClose }: { query: AnalyticsQuery; metric: SegmentDrillMetric; cardCount: number; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { data, isPending, error, isPlaceholderData, refetch } = useQuery({
    queryKey: ["manager", "analytics", "segment-details", query, metric, page],
    queryFn: ({ signal }) => managerAnalyticsApi.segmentDetails(query, metric, page, DRILL_PAGE_SIZE, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  // records can disappear while the panel is open (a follow-up gets completed): never stay on a page that no longer exists
  if (data && !isPlaceholderData && page > data.pagination.totalPages) setPage(data.pagination.totalPages);

  const { title, description } = DRILL_TITLES[metric];
  const total = data?.pagination.total;
  const download = async () => {
    setExporting(true);
    try {
      const url = URL.createObjectURL(await managerAnalyticsApi.segmentDetailsXlsx(query, metric));
      const a = document.createElement("a");
      a.href = url;
      a.download = `segment-${metric.replace(/([A-Z])/g, "-$1").toLowerCase()}-${query.from}_${query.to}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(getErrorMessage(e, "The export could not be created. Please try again."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div id="segment-drilldown" ref={box} role="region" aria-label={`${title} details`}>
      <Panel
        title={total === undefined ? title : `${title}: ${formatNumber(total)} ${total === 1 ? "record" : "records"}`}
        description={description}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void download()} disabled={exporting || !total}>
              <Download data-icon="inline-start" /> {exporting ? "Exporting…" : "Export these records"}
            </Button>
            <Button size="sm" variant="outline" onClick={onClose} aria-label="Close details">
              <X data-icon="inline-start" /> Close
            </Button>
          </>
        }
        bodyClassName="p-0 sm:p-0"
      >
        {total !== undefined && !isPlaceholderData && total !== cardCount ? (
          <p role="status" className="px-5 pt-3 text-xs text-muted-foreground">
            The card shows {formatNumber(cardCount)}: records changed after it was loaded. Both refresh every minute.
          </p>
        ) : null}
        <div className={isPlaceholderData ? "opacity-60" : undefined} aria-busy={isPlaceholderData}>
          <DrillContent metric={metric} data={data} isPending={isPending} error={error} onRetry={() => void refetch()} />
        </div>
        {data && data.pagination.totalPages > 1 ? (
          <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-3 text-sm">
            <span className="text-muted-foreground">
              Page {data.pagination.page} of {formatNumber(data.pagination.totalPages)}
            </span>
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page of details">
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= data.pagination.totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page of details">
              Next
            </Button>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
