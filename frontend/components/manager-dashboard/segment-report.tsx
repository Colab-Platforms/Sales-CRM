"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { managerAnalyticsApi } from "@/lib/api-client/endpoints/manager.api";
import type { AnalyticsQuery } from "@/lib/api-client/types/manager-analytics.types";
import type { SegmentDrillMetric, SegmentLeadHistory, SegmentLeadRow, SegmentReport } from "@/lib/api-client/types/segment-report.types";
import { ChevronDown, ChevronUp } from "lucide-react";
import { SegmentDrillDown } from "./segment-drilldown";
import { getErrorMessage } from "@/lib/api-client/client";
import { formatNumber } from "@/lib/manager-analytics";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Panel, SectionHeading } from "./panel";

const PAGE_SIZE = 25;
export const label = (v: string) => v.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export function segmentTiles(m: SegmentReport["metrics"]): { key: SegmentDrillMetric; label: string; value: number; hint: string }[] {
  const tiles: { label: string; value: number; hint: string }[] = [
    { label: "Total leads", value: m.totalLeads, hint: `${formatNumber(m.addedInPeriod)} added in this period` },
    // These four are the lead's current state, whatever the date range. Contacted + Pending = Total; Converted and Lost are inside Contacted.
    { label: "Contacted", value: m.contacted, hint: "every lead that is not Pending (includes Converted and Lost)" },
    { label: "Pending", value: m.pending, hint: "status New or Assigned, never called or marked contacted (any date)" },
    { label: "Converted", value: m.converted, hint: "current status Converted (converted customers are listed separately below)" },
    { label: "Lost", value: m.lost, hint: "current status Not Interested or DND" },
    { label: "Calls", value: m.calls, hint: `${formatNumber(m.connectedCalls)} connected, in this period` },
    { label: "Follow-ups completed", value: m.followUpsCompleted, hint: "in this period" },
    { label: "Follow-ups pending", value: m.followUpsPending, hint: `open now · ${formatNumber(m.followUpsOverdue)} overdue` },
    { label: "Recorded activities", value: m.activities, hint: `${formatNumber(m.notes)} notes · ${formatNumber(m.statusChanges)} status changes · ${formatNumber(m.assignments)} assignments` },
  ];
  // the same order as the tiles above
  const keys: SegmentDrillMetric[] = ["totalLeads", "contacted", "pending", "converted", "lost", "calls", "followUpsCompleted", "followUpsPending", "activities"];
  return tiles.map((t, i) => ({ key: keys[i]!, ...t }));
}

/** The metric cards. Each is a button: pressing one shows its records below, pressing the selected one again closes them. */
export function SegmentMetrics({ metrics, selected = null, onSelect }: { metrics: SegmentReport["metrics"]; selected?: SegmentDrillMetric | null; onSelect?: (metric: SegmentDrillMetric | null) => void }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {segmentTiles(metrics).map((t) => {
          const open = selected === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect?.(open ? null : t.key)}
              aria-pressed={open}
              aria-controls={open ? "segment-drilldown" : undefined}
              className={`group flex cursor-pointer flex-col items-start rounded-lg border p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${open ? "border-primary bg-primary/5 ring-2 ring-primary" : "border-border bg-card"}`}
            >
              <span className="text-xs text-muted-foreground">{t.label}</span>
              <span className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(t.value)}</span>
              <span className="mt-0.5 text-xs text-muted-foreground">{t.hint}</span>
              <span className={`mt-auto flex items-center gap-1 pt-2 text-xs font-medium ${open ? "text-primary" : "text-muted-foreground group-hover:text-primary"}`}>
                {open ? "Hide details" : "View details"}
                {open ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
              </span>
            </button>
          );
        })}
      </div>
      {metrics.activityByType.length > 0 ? (
        <p className="text-xs text-muted-foreground">Activity in this period: {metrics.activityByType.map((a) => `${label(a.type)} ${formatNumber(a.count)}`).join(" · ")}</p>
      ) : null}
    </div>
  );
}

export function SegmentLeadTable({ leads, onHistory }: { leads: SegmentLeadRow[]; onHistory: (id: string) => void }) {
  if (leads.length === 0) return <EmptyState>No leads in this segment match the selected filters.</EmptyState>;
  const num = "text-right tabular-nums";
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Lead</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Salesperson</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Last activity</TableHead>
            <TableHead className={num}>Calls</TableHead>
            <TableHead className={num}>Notes</TableHead>
            <TableHead className={num}>Activities</TableHead>
            <TableHead className={num}>Follow-ups done / pending</TableHead>
            <TableHead className="pr-5 text-right">History</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {leads.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="pl-5">
                <Link href={`/dashboard/leads/${l.id}`} className="font-medium hover:underline">
                  {l.name || l.leadNumber}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {l.leadNumber}
                  {l.stage === "CUSTOMER" ? " · Customer" : ""}
                </div>
              </TableCell>
              <TableCell className="tabular-nums">{l.phone ?? "—"}</TableCell>
              <TableCell>{l.salesperson ?? "Unassigned"}</TableCell>
              <TableCell>{label(l.status)}</TableCell>
              <TableCell>{l.source ?? "—"}</TableCell>
              <TableCell className="text-xs">{when(l.lastActivityAt ?? l.lastContactedAt)}</TableCell>
              <TableCell className={num}>{formatNumber(l.calls)}</TableCell>
              <TableCell className={num}>{formatNumber(l.notes)}</TableCell>
              <TableCell className={num}>{formatNumber(l.activities)}</TableCell>
              <TableCell className={num}>
                {formatNumber(l.followUpsCompleted)} / {formatNumber(l.followUpsPending)}
              </TableCell>
              <TableCell className="pr-5 text-right">
                <Button size="sm" variant="outline" onClick={() => onHistory(l.id)} aria-label={`Activity history of ${l.name || l.leadNumber}`}>
                  View
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Pager({ page, totalPages, onPage, name }: { page: number; totalPages: number; onPage: (p: number) => void; name: string }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-3 px-5 py-3 text-sm">
      <span className="text-muted-foreground">
        Page {page} of {formatNumber(totalPages)}
      </span>
      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={`Previous page of ${name}`}>
        Previous
      </Button>
      <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label={`Next page of ${name}`}>
        Next
      </Button>
    </div>
  );
}

/** Why the excluded records are not in the totals above, with their counts. */
export function ExcludedSummary({ excluded }: { excluded: SegmentReport["excluded"] }) {
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="font-medium">Converted to customer: {formatNumber(excluded.customers)}</span>
        {excluded.customersFromAbandonedCart > 0 ? ` (${formatNumber(excluded.customersFromAbandonedCart)} of them also from an abandoned cart)` : ""}
        {" · "}
        <span className="font-medium">Abandoned cart: {formatNumber(excluded.abandonedCart)}</span>
      </p>
      <p className="text-xs text-muted-foreground">By current status: {excluded.byStatus.map((s) => `${label(s.status)} ${formatNumber(s.count)}`).join(" · ")}</p>
      <p className="text-xs text-muted-foreground">
        In this period they have {formatNumber(excluded.calls)} calls and {formatNumber(excluded.activities)} recorded activities. A record here can belong to a person who also has a lead in the list above, so do not add the two totals together.
      </p>
    </div>
  );
}

/** The segment's records the Leads section leaves out, kept apart from the report: counts first, the records on request. */
function ExcludedRecords({ query, excluded, onHistory }: { query: AnalyticsQuery; excluded: SegmentReport["excluded"]; onHistory: (id: string) => void }) {
  const [show, setShow] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error } = useQuery({
    queryKey: ["manager", "analytics", "segment-excluded", query, page],
    queryFn: ({ signal }) => managerAnalyticsApi.segmentReport(query, page, PAGE_SIZE, signal, "excluded"),
    placeholderData: keepPreviousData,
    enabled: show,
  });
  if (excluded.total === 0) return null;
  return (
    <Panel
      title={`Not in the Leads list: ${formatNumber(excluded.total)} ${excluded.total === 1 ? "record" : "records"}`}
      description="Members of this segment that the Leads section does not show. Not counted in any total above."
      actions={
        <Button size="sm" variant="outline" onClick={() => setShow((s) => !s)} aria-expanded={show}>
          {show ? "Hide records" : "Show records"}
        </Button>
      }
      bodyClassName="p-0 sm:p-0"
    >
      <div className="px-5 py-3">
        <ExcludedSummary excluded={excluded} />
      </div>
      {show ? (
        error ? (
          <p role="alert" className="px-5 pb-3 text-sm text-destructive">
            {getErrorMessage(error, "Failed to load these records.")}
          </p>
        ) : data ? (
          <>
            <SegmentLeadTable leads={data.leads} onHistory={onHistory} />
            <Pager page={data.pagination.page} totalPages={data.pagination.totalPages} onPage={setPage} name="excluded records" />
          </>
        ) : (
          <Skeleton className="mx-5 mb-4 h-32" />
        )
      ) : null}
    </Panel>
  );
}

/** Calls, follow-ups and recorded activities of one lead, newest first, as one list. */
export function historyEntries(h: SegmentLeadHistory): { id: string; at: string; kind: string; title: string; detail: string; by: string | null }[] {
  return [
    ...h.calls.map((c) => ({ id: `c-${c.id}`, at: c.startedAt ?? c.createdAt, kind: "Call", title: `${label(c.direction)} call · ${label(c.status)}${c.durationSeconds ? ` · ${c.durationSeconds}s` : ""}`, detail: [c.outcome, c.notes].filter(Boolean).join(" · "), by: c.by })),
    ...h.tasks.map((t) => ({ id: `t-${t.id}`, at: t.completedAt ?? t.scheduledAt ?? t.createdAt, kind: label(t.type), title: `${t.title} · ${label(t.status)}`, detail: t.description ?? "", by: t.assignedTo })),
    ...h.activities.map((a) => ({ id: `a-${a.id}`, at: a.createdAt, kind: label(a.type), title: a.title ?? label(a.type), detail: a.description ?? "", by: a.by })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

function HistoryDialog({ leadId, query, onClose }: { leadId: string; query: AnalyticsQuery; onClose: () => void }) {
  const { data, isPending, error } = useQuery({
    queryKey: ["manager", "analytics", "segment-history", query.segmentId, leadId],
    queryFn: ({ signal }) => managerAnalyticsApi.segmentLeadHistory(leadId, query, signal),
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{data ? data.lead.name || data.lead.leadNumber : "Activity history"}</DialogTitle>
          <DialogDescription>
            {data ? `${data.lead.phone ?? "No phone"} · ${label(data.lead.status)} · ${data.lead.salesperson ?? "Unassigned"} · whole history, not limited to the report dates` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {isPending ? <Skeleton className="h-40" /> : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {getErrorMessage(error, "Failed to load the history.")}
          </p>
        ) : null}
        {data ? (
          <>
            <ul className="space-y-3">
              {historyEntries(data).map((e) => (
                <li key={e.id} className="border-b border-border/60 pb-2 text-sm">
                  <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                    <span>{e.kind}</span>
                    <span>{when(e.at)}</span>
                  </div>
                  <p className="font-medium">{e.title}</p>
                  {e.detail ? <p className="text-xs text-muted-foreground">{e.detail}</p> : null}
                  {e.by ? <p className="text-xs text-muted-foreground">By {e.by}</p> : null}
                </li>
              ))}
            </ul>
            {historyEntries(data).length === 0 ? <EmptyState>No recorded activity for this lead.</EmptyState> : null}
            <p className="text-xs text-muted-foreground">Up to {data.limit} of each type are shown.</p>
            <Link href={`/dashboard/leads/${data.lead.id}`} className="text-sm font-medium text-primary hover:underline">
              Open lead details
            </Link>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The Reports page section shown when a segment is selected. Give it a `key` built from the query so a filter change starts again at page 1. */
export function SegmentReportSection({ query }: { query: AnalyticsQuery }) {
  const [page, setPage] = useState(1);
  const [openLead, setOpenLead] = useState<string | null>(null);
  // the selected card. This section is rebuilt whenever a filter changes (and removed by Reset), so the selection never outlives its filters.
  const [selected, setSelected] = useState<SegmentDrillMetric | null>(null);
  const { data, isPending, error, isPlaceholderData } = useQuery({
    queryKey: ["manager", "analytics", "segment", query, page],
    queryFn: ({ signal }) => managerAnalyticsApi.segmentReport(query, page, PAGE_SIZE, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  return (
    <section className="space-y-4" aria-label="Segment leads">
      <SectionHeading
        title={data ? `Segment: ${data.segment.name}` : "Segment"}
        description="Lead activity for the same leads the Leads section lists for this segment (leads are not orders). Lead counts show current status; calls, activities and completed follow-ups follow the date range. Sales, team and call figures below cover all of the segment's records, including converted customers and abandoned carts; productive time is not narrowed."
      />
      {isPending ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : error || !data ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load the segment report.")}
        </div>
      ) : (
        <div className={isPlaceholderData ? "space-y-4 opacity-60" : "space-y-4"} aria-busy={isPlaceholderData}>
          <SegmentMetrics metrics={data.metrics} selected={selected} onSelect={setSelected} />
          {selected ? <SegmentDrillDown key={selected} query={query} metric={selected} cardCount={data.metrics[selected]} onClose={() => setSelected(null)} /> : null}
          <Panel title="Segment leads" description={`${formatNumber(data.pagination.total)} matching ${data.pagination.total === 1 ? "lead" : "leads"}`} bodyClassName="p-0 sm:p-0">
            <SegmentLeadTable leads={data.leads} onHistory={setOpenLead} />
            <Pager page={data.pagination.page} totalPages={data.pagination.totalPages} onPage={setPage} name="segment leads" />
          </Panel>
          {data.excluded ? <ExcludedRecords query={query} excluded={data.excluded} onHistory={setOpenLead} /> : null}
        </div>
      )}
      {openLead ? <HistoryDialog leadId={openLead} query={query} onClose={() => setOpenLead(null)} /> : null}
    </section>
  );
}
