"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FileArchive, FileSpreadsheet, Headphones, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { OrdersPagination } from "@/components/orders/orders-pagination";
import { leadDetailHref } from "@/components/leads/lead-table";
import { ExportHistory, EXPORTS_KEY } from "@/components/abandonment/export-shared";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonmentRecordingsApi, describeRequestError, saveBlob } from "@/lib/api-client/endpoints/abandonment.recordings.api";
import { callRecordingsApi, type CallRecordingFilterState, type CallRecordingItem } from "@/lib/api-client/endpoints/call-recordings.api";
import { abandonmentItemOptionsQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { stopPlayback } from "@/components/abandonment/recording-playback";
import { CallRecordingsFilters, activeFilterCount, defaultFilters } from "./call-recordings-filters";
import { RecordingPlayer } from "./recording-player";

const PAGE_SIZES = [20, 50, 100] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

/** Date and time of a call in IST, the calendar the reports and every filter on this page use. */
export const formatCallTime = (iso: string) => `${IST_DATE_TIME.format(new Date(iso))} IST`;

/** "1h 05m", "4m 07s", "35s". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return "—";
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** The page's initial filters: the defaults, plus what "View Recordings" on the Abandoned Leads table puts in the URL (re-validated here and again by the server). */
function initialFilters(params: URLSearchParams): CallRecordingFilterState {
  const base = defaultFilters();
  const leadId = params.get("leadId");
  const from = params.get("from");
  const to = params.get("to");
  return { ...base, ...(leadId && UUID.test(leadId) ? { leadId } : {}), ...(from && to && DAY.test(from) && DAY.test(to) && from <= to ? { from, to } : {}) };
}

function SummaryCard({ title, value, hint, testId }: { title: string; value: string; hint?: string; testId: string }) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={testId}>
          {value}
        </p>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export function CallRecordingsView() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const allowed = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [draft, setDraft] = useState<CallRecordingFilterState>(() => initialFilters(searchParams));
  const [applied, setApplied] = useState<CallRecordingFilterState>(draft);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  // Ticked recordings (across pages), or "every recording the filters match".
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // A non-admin who opens the URL is sent away (the server refuses them anyway).
  useEffect(() => {
    if (user && !allowed) router.replace("/dashboard");
  }, [user, allowed, router]);
  // Leaving the page stops whatever is playing.
  useEffect(() => () => stopPlayback(), []);

  const list = useQuery({ queryKey: ["call-recordings", "list", applied, page, pageSize], queryFn: () => callRecordingsApi.list(applied, page, pageSize), enabled: allowed, staleTime: 15_000, placeholderData: (previous, previousQuery) => (previousQuery && JSON.stringify(previousQuery.queryKey[2]) === JSON.stringify(applied) ? previous : undefined) });
  const summary = useQuery({ queryKey: ["call-recordings", "summary", applied], queryFn: () => callRecordingsApi.summary(applied), enabled: allowed, staleTime: 15_000 });
  const options = useQuery({ queryKey: ["call-recordings", "options"], queryFn: () => callRecordingsApi.options(), enabled: allowed, staleTime: 60_000 });
  const products = useQuery({ ...abandonmentItemOptionsQueryOptions(), enabled: allowed });

  const exportMutation = useMutation({
    mutationFn: (input: { kind: "ZIP" | "EXCEL"; callIds?: string[] }) => callRecordingsApi.startExport(input.kind, applied, input.callIds),
    onSuccess: (job, input) => {
      void queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
      toast.success(`${input.kind === "ZIP" ? "ZIP of recordings" : "Excel"} is being prepared${job.reused ? " (already running)" : ""}. Follow it under "Recent exports" below - you can leave this page.`);
    },
    onError: (e) => toast.error(describeRequestError(e, "Could not start the export.")),
  });

  const total = list.data?.pagination.totalItems;
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const leadLabel = useMemo(() => {
    const row = rows.find((r) => r.leadId === applied.leadId);
    return row ? `${row.customerName} (${row.leadNumber})` : undefined;
  }, [rows, applied.leadId]);

  if (!user || !allowed) return null;

  function clearSelection() {
    setSelected(new Set());
    setAllMatching(false);
  }
  function apply(next: CallRecordingFilterState) {
    stopPlayback();
    setApplied(next);
    setDraft(next);
    setPage(1);
    clearSelection();
  }
  function goToPage(next: number) {
    stopPlayback();
    setPage(next);
  }

  const pageIds = rows.map((r) => r.callId);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => allMatching || selected.has(id));
  function toggleAllOnPage(checked: boolean) {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(allMatching ? [] : prev);
      for (const id of pageIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  function toggleOne(id: string, checked: boolean) {
    // Unticking one row of an "all matching" selection cannot be expressed as a list: it falls back to this page's rows.
    const base = allMatching ? new Set(pageIds) : new Set(selected);
    setAllMatching(false);
    if (checked) base.add(id);
    else base.delete(id);
    setSelected(base);
  }

  const selectedCount = allMatching ? (total ?? 0) : selected.size;
  const selectedIds = allMatching ? undefined : [...selected];
  const busy = exportMutation.isPending;

  async function downloadOne(item: CallRecordingItem) {
    setDownloadingId(item.callId);
    try {
      saveBlob(await abandonmentRecordingsApi.downloadOne(item.callId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not download this recording.");
    } finally {
      setDownloadingId(null);
    }
  }

  const s = summary.data;
  return (
    <div className="space-y-6">
      <PageHeader title="Call Recordings" description="Every recorded call to an abandoned lead, with the telecaller who actually made the call. Listen here, filter, and download recordings for monitoring and quality checks." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-live="polite" data-testid="recording-summary">
        {summary.isPending ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
        ) : summary.error ? (
          <p role="alert" className="col-span-full text-sm text-destructive">{getErrorMessage(summary.error, "Could not load the summary.")}</p>
        ) : s ? (
          <>
            <SummaryCard title="Total recordings" value={s.totalRecordings.toLocaleString("en-IN")} hint="Matching the filters" testId="card-total" />
            <SummaryCard title="Total call duration" value={formatDuration(s.totalDurationSeconds)} testId="card-duration" />
            <SummaryCard title="Average call duration" value={formatDuration(s.averageDurationSeconds)} testId="card-average" />
            <SummaryCard title="Telecallers with recordings" value={s.telecallers.toLocaleString("en-IN")} testId="card-telecallers" />
            <SummaryCard title="Today's recordings" value={s.todayRecordings.toLocaleString("en-IN")} hint="Today (IST), same filters" testId="card-today" />
          </>
        ) : null}
      </div>

      <CallRecordingsFilters
        value={draft}
        onChange={setDraft}
        onApply={() => apply(draft)}
        onReset={() => apply(defaultFilters())}
        options={options.data}
        optionsLoading={options.isPending}
        products={products.data?.items ?? []}
        productsLoading={products.isPending}
        dirty={dirty}
        matching={list.error ? undefined : total}
        fetching={list.isFetching}
        leadLabel={leadLabel}
        onClearLead={() => apply({ ...applied, leadId: undefined })}
      />

      <div className="flex flex-wrap items-center gap-2" data-testid="recording-actions">
        <Button type="button" variant="outline" disabled={busy || selectedCount === 0} onClick={() => exportMutation.mutate({ kind: "ZIP", callIds: selectedIds })} data-testid="download-selected-zip">
          {busy && exportMutation.variables?.kind === "ZIP" ? <Loader2 className="animate-spin" /> : <FileArchive />}
          Download selected (ZIP){selectedCount > 0 ? ` · ${selectedCount.toLocaleString("en-IN")}` : ""}
        </Button>
        <Button type="button" variant="outline" disabled={busy || !total} onClick={() => exportMutation.mutate({ kind: "ZIP" })} data-testid="download-all-zip">
          <FileArchive />
          Download all filtered (ZIP){total ? ` · ${total.toLocaleString("en-IN")}` : ""}
        </Button>
        <Button type="button" variant="outline" disabled={busy || !total} onClick={() => exportMutation.mutate({ kind: "EXCEL", callIds: selectedCount > 0 ? selectedIds : undefined })} data-testid="export-excel">
          {busy && exportMutation.variables?.kind === "EXCEL" ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
          Export to Excel ({selectedCount > 0 ? `${selectedCount.toLocaleString("en-IN")} selected` : "all filtered"})
        </Button>
        {selectedCount > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={clearSelection}>
            Clear selection
          </Button>
        ) : null}
      </div>

      {total !== undefined && total > rows.length && !allMatching ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{total.toLocaleString("en-IN")} recordings match.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => { setSelected(new Set()); setAllMatching(true); }} data-testid="select-all-matching">
            Select all {total.toLocaleString("en-IN")}
          </Button>
        </div>
      ) : null}
      {allMatching ? (
        <p role="status" className="text-sm text-muted-foreground" data-testid="all-matching-selected">
          All {total?.toLocaleString("en-IN")} matching recordings are selected. Ticking or unticking a row selects just the rows you tick.
        </p>
      ) : null}

      <ExportHistory kind="ZIP" title="Recent recording ZIPs" scope="recordings" />
      <ExportHistory kind="EXCEL" title="Recent recording Excel exports" scope="recordings" />

      {list.error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          {getErrorMessage(list.error, "Could not load call recordings.")}
          <Button type="button" size="sm" variant="outline" className="ml-3" onClick={() => void list.refetch()}>Try again</Button>
        </div>
      ) : (
        <Card>
          <CardContent>
            {list.isPending ? (
              <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center" data-testid="recordings-empty">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Headphones className="size-5" />
                </div>
                <p className="text-sm font-medium">No call recordings match these filters.</p>
                <p className="text-sm text-muted-foreground">Try a wider date range or remove a filter. New recordings appear here automatically as calls finish.</p>
                {activeFilterCount(applied) > 0 ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => apply({ ...defaultFilters(), from: applied.from, to: applied.to })}>
                    Clear filters
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]">
                        <input type="checkbox" className="size-4 accent-primary" checked={allOnPage} onChange={(e) => toggleAllOnPage(e.target.checked)} aria-label="Select all recordings on this page" />
                      </TableHead>
                      <TableHead className="min-w-[150px]">Call date &amp; time</TableHead>
                      <TableHead className="min-w-[150px]">Customer</TableHead>
                      <TableHead className="min-w-[120px]">Mobile</TableHead>
                      <TableHead className="min-w-[130px]">Telecaller</TableHead>
                      <TableHead className="min-w-[260px]">Recording</TableHead>
                      <TableHead className="min-w-[180px]">Product</TableHead>
                      <TableHead className="min-w-[120px]">Lead status</TableHead>
                      <TableHead className="min-w-[130px]">Call outcome</TableHead>
                      <TableHead className="min-w-[90px]">Duration</TableHead>
                      <TableHead className="w-[90px] text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className={list.isFetching ? "opacity-70" : undefined}>
                    {rows.map((r) => (
                      <TableRow key={r.callId} data-testid="recording-row">
                        <TableCell>
                          <input type="checkbox" className="size-4 accent-primary" checked={allMatching || selected.has(r.callId)} onChange={(e) => toggleOne(r.callId, e.target.checked)} aria-label={`Select recording of ${r.customerName}`} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{formatCallTime(r.callAt)}</TableCell>
                        <TableCell className="text-sm font-medium">
                          {r.customerName || "—"}
                          <span className="block text-xs font-normal text-muted-foreground">{r.leadNumber}</span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{r.mobile ?? "—"}</TableCell>
                        <TableCell className="text-sm" data-testid="row-telecaller">{r.telecaller.name}</TableCell>
                        <TableCell>
                          <RecordingPlayer callId={r.callId} url={r.playUrl} durationSeconds={r.durationSeconds} unavailableReason={r.unavailableReason} />
                        </TableCell>
                        <TableCell className="max-w-[260px] text-sm">
                          {r.products.length > 0 ? <span className="line-clamp-2" title={r.products.join(", ")}>{r.products.join(", ")}</span> : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={r.leadStatus} />
                        </TableCell>
                        <TableCell className="text-sm">{r.outcome}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm tabular-nums">{formatDuration(r.durationSeconds)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button type="button" variant="ghost" size="icon-sm" aria-label="Download recording" title="Download recording" disabled={!r.playUrl || downloadingId === r.callId} onClick={() => void downloadOne(r)}>
                            {downloadingId === r.callId ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                          </Button>
                          <Button type="button" variant="ghost" size="icon-sm" aria-label="View lead" title="View lead" onClick={() => router.push(leadDetailHref(r.leadId, { from: "abandoned-leads", ...(r.abandonmentId ? { abandonmentId: r.abandonmentId } : {}) }))}>
                            <Eye className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {list.data ? (
                  <>
                    <div className="flex items-center justify-end gap-2 pt-4 text-sm text-muted-foreground">
                      <label htmlFor="call-recordings-page-size">Rows per page</label>
                      <select
                        id="call-recordings-page-size"
                        value={pageSize}
                        onChange={(e) => {
                          stopPlayback();
                          setPageSize(Number(e.target.value));
                          setPage(1);
                        }}
                        disabled={list.isFetching}
                        className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                      >
                        {PAGE_SIZES.map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </div>
                    <OrdersPagination pagination={list.data.pagination} onPageChange={goToPage} disabled={list.isFetching} />
                  </>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
