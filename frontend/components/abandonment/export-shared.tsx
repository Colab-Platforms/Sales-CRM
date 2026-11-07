"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileArchive, FileSpreadsheet, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { abandonmentRecordingsApi, describeRequestError, type RecordingExport, type RecordingExportKind } from "@/lib/api-client/endpoints/abandonment.recordings.api";

// Shared by the two export panels (lead Excel / recording ZIP). The panels are independent: each has its own date range, its own buttons, its own history (filtered by kind) and its
// own errors, and the server limits and queues them per kind - so one never blocks or interferes with the other. They share only the history query (one request for both).

/** A calendar day in IST (the server's reporting timezone), `offsetDays` from today. */
export const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** The list filters an Excel export may apply, as the API takes them. Empty values are dropped. */
export type ExportFilters = Record<string, string | number | undefined>;

export const EXPORTS_KEY = ["abandonment-recording-exports"] as const;
export const isActive = (e: RecordingExport) => e.status === "QUEUED" || e.status === "PROCESSING";
const STATUS_LABEL: Record<RecordingExport["status"], string> = { QUEUED: "Queued", PROCESSING: "Processing", COMPLETED: "Completed", FAILED: "Failed" };
const KIND_LABEL: Record<RecordingExportKind, string> = { EXCEL: "Excel", ZIP: "ZIP" };
const formatSize = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(Math.round(bytes / 1024), 1)} KB`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");

/** What an export covers, in words: the ticked leads, every lead the list matched, or the date range. */
export function exportScope(job: RecordingExport): string {
  if (job.selection === "IDS") return `Selected leads (${job.selectedCount ?? 0})`;
  if (job.selection === "MATCHING") return "All matching leads";
  const range = job.from === job.to ? job.from : `${job.from} → ${job.to}`;
  return job.filtered ? `${range} · filtered` : range;
}

/** The user's exports (one request, polled every 2 s while one is running and every 5 s while the server cannot be reached), filtered to one kind. */
export function useExports(kind: RecordingExportKind) {
  const query = useQuery({
    queryKey: EXPORTS_KEY,
    queryFn: () => abandonmentRecordingsApi.listExports(),
    refetchInterval: (q) => (q.state.error ? 5000 : q.state.data?.some(isActive) ? 2000 : false),
    staleTime: 0,
    retry: 2,
  });
  return { query, exports: (query.data ?? []).filter((e) => e.kind === kind) };
}

/** Start / retry / download for one panel, with its own error line. */
export function useExportActions(kind: RecordingExportKind) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
  const start = useMutation({
    mutationFn: (input: { from: string; to: string; filters?: Record<string, unknown> }) => abandonmentRecordingsApi.startExport({ kind, ...input }),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (e) => setError(describeRequestError(e, "Could not start the export.")),
  });
  const retry = useMutation({
    mutationFn: (id: string) => abandonmentRecordingsApi.retryExport(id),
    onSuccess: () => { setError(null); void refresh(); },
    onError: (e) => setError(describeRequestError(e, "Could not retry the export.")),
  });
  const download = useMutation({
    mutationFn: async (id: string) => {
      const url = await abandonmentRecordingsApi.exportDownloadUrl(id);
      const link = document.createElement("a");
      link.href = url;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
    onSuccess: () => setError(null),
    onError: (e) => setError(describeRequestError(e, "Could not start the download.")),
  });
  return { start, retry, download, error, setError };
}

/** One export in the history: type, scope, status, progress and counts, with Download / Retry. Everything comes from the server, so it is identical after a refresh. */
export function ExportCard({ job, onRetry, onDownload, retrying, downloading }: { job: RecordingExport; onRetry: () => void; onDownload: () => void; retrying: boolean; downloading: boolean }) {
  const done = job.processed + job.failed;
  const noun = job.kind === "EXCEL" ? "leads" : "recordings";
  const Icon = job.kind === "EXCEL" ? FileSpreadsheet : FileArchive;
  return (
    <div className="w-full space-y-2 rounded-md border bg-background/60 p-3" data-testid="export-card" data-kind={job.kind} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <span data-testid="export-kind">{KIND_LABEL[job.kind]}</span>
          <span className="text-muted-foreground" data-testid="export-scope">{exportScope(job)}</span>
          <span data-testid="export-status" className={job.status === "FAILED" ? "text-destructive" : job.status === "COMPLETED" ? "text-emerald-600" : "text-foreground"}>
            {STATUS_LABEL[job.status]}
          </span>
        </span>
        <span className="tabular-nums text-muted-foreground" data-testid="export-percent">{job.percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent} aria-label="Export progress">
        <div className={`h-full transition-all ${job.status === "FAILED" ? "bg-destructive" : "bg-primary"}`} style={{ width: `${job.status === "QUEUED" ? 2 : job.percent}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4" data-testid="export-counts">
        <div><dt className="inline">Total {noun}: </dt><dd className="inline font-medium tabular-nums text-foreground">{job.total}</dd></div>
        <div><dt className="inline">Successful: </dt><dd className="inline font-medium tabular-nums text-foreground">{job.processed}</dd></div>
        <div><dt className="inline">Failed / unavailable: </dt><dd className="inline font-medium tabular-nums text-foreground">{job.failed}</dd></div>
        <div><dt className="inline">Remaining: </dt><dd className="inline font-medium tabular-nums text-foreground">{job.remaining}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground" data-testid="export-times">
        Started {when(job.createdAt)}
        {job.finishedAt && !isActive(job) ? ` · ${job.status === "COMPLETED" ? "Completed" : "Ended"} ${when(job.finishedAt)}` : ""}
      </p>
      {job.status === "QUEUED" && !job.stalled ? <p className="text-xs text-muted-foreground">Waiting for a worker. You can leave this page - the export keeps running and will be listed here when you come back.</p> : null}
      {job.status === "PROCESSING" && !job.stalled ? <p className="text-xs text-muted-foreground">{done} of {job.total} {noun} checked. You can leave this page - the export keeps running.</p> : null}
      {job.stalled && isActive(job) ? <p className="text-xs text-amber-600" role="status">No progress for a while (the server was restarted). It is being picked up again automatically - nothing is lost.</p> : null}
      {job.errorMessage && (job.status === "FAILED" || isActive(job)) ? <p role={job.status === "FAILED" ? "alert" : "status"} className={job.status === "FAILED" ? "text-sm text-destructive" : "text-xs text-amber-600"} data-testid="export-error">{job.errorMessage}</p> : null}
      {job.status === "COMPLETED" && job.failed > 0 && job.kind === "ZIP" ? <p className="text-xs text-amber-600">{job.failed} recording{job.failed === 1 ? " was" : "s were"} unavailable and skipped; they are listed in the ZIP&apos;s summary file.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {job.canDownload ? (
          <Button type="button" size="sm" onClick={onDownload} disabled={downloading} data-testid="export-download">
            {downloading ? <Loader2 className="animate-spin" /> : <Download />}
            Download {KIND_LABEL[job.kind]} ({formatSize(job.sizeBytes)})
          </Button>
        ) : null}
        {job.canRetry ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying} data-testid="export-retry">
            {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {job.status === "FAILED" ? "Retry export" : `Retry ${job.failed} failed`}
          </Button>
        ) : null}
        {job.canDownload ? <span className="text-xs text-muted-foreground">Available until {when(job.expiresAt)}</span> : null}
      </div>
    </div>
  );
}

/** The history list of one panel, with the connection-problem line and Try again. */
export function ExportHistory({ kind, title }: { kind: RecordingExportKind; title: string }) {
  const { query, exports } = useExports(kind);
  const actions = useExportActions(kind);
  return (
    <div className="space-y-2" data-testid={`export-history-${kind.toLowerCase()}`}>
      {query.isPending ? <p className="text-xs text-muted-foreground">Loading exports…</p> : null}
      {query.error ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert" data-testid="exports-error">
          {(query.data?.length ?? 0) > 0 ? "Connection problem - progress will resume updating as soon as the server answers. " : ""}
          {describeRequestError(query.error, "Could not load your exports.")}
          <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>Try again</Button>
        </p>
      ) : null}
      {actions.error ? <p className="text-xs text-destructive" role="alert" data-testid="action-error">{actions.error}</p> : null}
      {exports.length > 0 ? (
        <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-1" aria-label={title}>
          <p className="text-xs font-medium text-muted-foreground">{title} (kept until they expire)</p>
          {exports.map((job) => (
            <ExportCard
              key={job.id}
              job={job}
              onRetry={() => actions.retry.mutate(job.id)}
              onDownload={() => actions.download.mutate(job.id)}
              retrying={actions.retry.isPending && actions.retry.variables === job.id}
              downloading={actions.download.isPending && actions.download.variables === job.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** From / To dates and the quick ranges. */
export function RangeControls({ from, to, onChange, idPrefix }: { from: string; to: string; onChange: (from: string, to: string) => void; idPrefix: string }) {
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-from`} className="text-xs text-muted-foreground">From</Label>
        <Input id={`${idPrefix}-from`} type="date" value={from} max={to || undefined} onChange={(e) => onChange(e.target.value, to)} className="w-40" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-to`} className="text-xs text-muted-foreground">To</Label>
        <Input id={`${idPrefix}-to`} type="date" value={to} min={from || undefined} onChange={(e) => onChange(from, e.target.value)} className="w-40" />
      </div>
      <div className="flex flex-wrap gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(istDay(), istDay())}>Today</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(istDay(-1), istDay(-1))}>Yesterday</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(istDay(-6), istDay())}>Last 7 days</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(istDay(-29), istDay())}>Last 30 days</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(istDay(-364), istDay())}>Last year</Button>
      </div>
    </>
  );
}
