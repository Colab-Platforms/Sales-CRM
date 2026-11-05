"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonmentRecordingsApi, type RecordingExport } from "@/lib/api-client/endpoints/abandonment.recordings.api";

/** A calendar day in IST (the server's reporting timezone), `offsetDays` from today. */
const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

const EXPORTS_KEY = ["abandonment-recording-exports"] as const;
const isActive = (e: RecordingExport) => e.status === "QUEUED" || e.status === "PROCESSING";
const STATUS_LABEL: Record<RecordingExport["status"], string> = { QUEUED: "Queued", PROCESSING: "Processing", COMPLETED: "Completed", FAILED: "Failed" };
const formatSize = (bytes: number) => (bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(Math.round(bytes / 1024), 1)} KB`);

/** Progress of one background export. Everything shown comes from the server, so it is the same after a refresh. */
function ExportProgress({ job, onRetry, onDownload, retrying, downloading }: { job: RecordingExport; onRetry: () => void; onDownload: () => void; retrying: boolean; downloading: boolean }) {
  const done = job.processed + job.failed;
  return (
    <div className="w-full space-y-2 rounded-md border bg-background/60 p-3" data-testid="export-progress" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          Export {job.from === job.to ? job.from : `${job.from} → ${job.to}`} ·{" "}
          <span data-testid="export-status" className={job.status === "FAILED" ? "text-destructive" : job.status === "COMPLETED" ? "text-emerald-600" : "text-foreground"}>
            {STATUS_LABEL[job.status]}
          </span>
        </span>
        <span className="tabular-nums text-muted-foreground" data-testid="export-percent">
          {job.percent}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent} aria-label="Export progress">
        <div className={`h-full transition-all ${job.status === "FAILED" ? "bg-destructive" : "bg-primary"}`} style={{ width: `${job.status === "QUEUED" ? 2 : job.percent}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4" data-testid="export-counts">
        <div><dt className="inline">Total: </dt><dd className="inline font-medium text-foreground tabular-nums">{job.total}</dd></div>
        <div><dt className="inline">Successful: </dt><dd className="inline font-medium text-foreground tabular-nums">{job.processed}</dd></div>
        <div><dt className="inline">Failed / unavailable: </dt><dd className="inline font-medium text-foreground tabular-nums">{job.failed}</dd></div>
        <div><dt className="inline">Remaining: </dt><dd className="inline font-medium text-foreground tabular-nums">{job.remaining}</dd></div>
      </dl>
      {job.status === "QUEUED" ? <p className="text-xs text-muted-foreground">Waiting for a worker. You can leave this page - the export keeps running and will be here when you come back.</p> : null}
      {job.status === "PROCESSING" ? <p className="text-xs text-muted-foreground">{done} of {job.total} checked. You can leave this page - the export keeps running.</p> : null}
      {job.errorMessage && job.status === "FAILED" ? <p role="alert" className="text-sm text-destructive">{job.errorMessage}</p> : null}
      {job.status === "COMPLETED" && job.failed > 0 ? <p className="text-xs text-amber-600">{job.failed} recording{job.failed === 1 ? " was" : "s were"} unavailable and skipped; they are listed in the ZIP&apos;s summary file.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {job.canDownload ? (
          <Button type="button" size="sm" onClick={onDownload} disabled={downloading} data-testid="export-download">
            {downloading ? <Loader2 className="animate-spin" /> : <Download />}
            Download ZIP ({formatSize(job.sizeBytes)})
          </Button>
        ) : null}
        {job.canRetry ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying} data-testid="export-retry">
            {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {job.status === "FAILED" ? "Retry export" : `Retry ${job.failed} failed`}
          </Button>
        ) : null}
        {job.canDownload ? <span className="text-xs text-muted-foreground">Available until {new Date(job.expiresAt).toLocaleString()}</span> : null}
      </div>
    </div>
  );
}

/** Admin / manager only: export every available call recording of abandoned leads for one day or a custom From - To range as a ZIP, built in the background. */
export function BulkRecordingsPanel() {
  const queryClient = useQueryClient();
  const [from, setFromRaw] = useState(istDay());
  const [to, setToRaw] = useState(istDay());
  const [actionError, setActionError] = useState<string | null>(null);

  const rangeInvalid = !from || !to || from > to;
  // How many recordings the range holds (and how many are unavailable) - checked before anything is exported.
  const check = useQuery({ queryKey: ["abandonment-recordings-summary", from, to], queryFn: () => abandonmentRecordingsApi.summary({ from, to }), enabled: !rangeInvalid, staleTime: 15_000, retry: false });
  const summary = rangeInvalid ? null : (check.data ?? null);
  const checkError = !rangeInvalid && check.error ? getErrorMessage(check.error, "Could not check the recordings for this range.") : null;

  // The user's exports come from the server, so a refresh or coming back later finds a running / finished export again. Polled only while one is running.
  const exportsQuery = useQuery({
    queryKey: EXPORTS_KEY,
    queryFn: () => abandonmentRecordingsApi.listExports(),
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 2000 : false),
    staleTime: 0,
  });
  const exports = exportsQuery.data ?? [];
  const current = exports.find((e) => e.from === from && e.to === to) ?? exports.find(isActive) ?? null;
  const currentActive = Boolean(current && isActive(current));
  const otherRangeActive = Boolean(current && isActive(current) && (current.from !== from || current.to !== to));

  const setRange = (nextFrom: string, nextTo: string) => {
    setFromRaw(nextFrom);
    setToRaw(nextTo);
    setActionError(null);
  };

  const refreshExports = () => queryClient.invalidateQueries({ queryKey: EXPORTS_KEY });
  const start = useMutation({
    mutationFn: () => abandonmentRecordingsApi.startExport({ from, to }),
    onSuccess: () => { setActionError(null); void refreshExports(); },
    onError: (e) => setActionError(getErrorMessage(e, "Could not start the export.")),
  });
  const retry = useMutation({
    mutationFn: (id: string) => abandonmentRecordingsApi.retryExport(id),
    onSuccess: () => { setActionError(null); void refreshExports(); },
    onError: (e) => setActionError(getErrorMessage(e, "Could not retry the export.")),
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
    onSuccess: () => setActionError(null),
    onError: (e) => setActionError(getErrorMessage(e, "Could not start the download.")),
  });

  const nothingToExport = Boolean(summary && summary.total === 0);

  return (
    <div className="sketch-outline flex flex-wrap items-end gap-4 bg-card/60 p-4" data-testid="bulk-recordings">
      <div className="space-y-1">
        <p className="text-sm font-medium">Download call recordings</p>
        <p className="text-xs text-muted-foreground">All available recordings of abandoned-lead calls in the date range, exported in the background as one ZIP.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rec-from" className="text-xs text-muted-foreground">From</Label>
        <Input id="rec-from" type="date" value={from} max={to || undefined} onChange={(e) => setRange(e.target.value, to)} className="w-40" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rec-to" className="text-xs text-muted-foreground">To</Label>
        <Input id="rec-to" type="date" value={to} min={from || undefined} onChange={(e) => setRange(from, e.target.value)} className="w-40" />
      </div>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => setRange(istDay(), istDay())}>Today</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setRange(istDay(-1), istDay(-1))}>Yesterday</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setRange(istDay(-6), istDay())}>Last 7 days</Button>
      </div>
      <Button type="button" onClick={() => start.mutate()} disabled={start.isPending || rangeInvalid || check.isFetching || nothingToExport || currentActive}>
        {start.isPending ? <Loader2 className="animate-spin" /> : <Download />}
        {start.isPending ? "Starting…" : current && !currentActive ? "Start new export" : "Download ZIP"}
      </Button>

      <div className="w-full space-y-2 text-sm" aria-live="polite">
        {rangeInvalid ? <p className="text-destructive" role="alert">Choose a From date that is not after the To date.</p> : null}
        {check.isFetching ? <p className="text-muted-foreground">Checking recordings…</p> : null}
        {summary && !check.isFetching ? (
          summary.total === 0 ? (
            <p className="text-muted-foreground" data-testid="recordings-empty">No recordings found for this date range.</p>
          ) : (
            <p className="text-muted-foreground" data-testid="recordings-summary">
              {summary.available} recording{summary.available === 1 ? "" : "s"} available
              {summary.unavailable > 0 ? <span className="text-amber-600"> · {summary.unavailable} unavailable (will be skipped)</span> : null}
              {summary.duplicates > 0 ? ` · ${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"} left out` : ""}
            </p>
          )
        ) : null}
        {otherRangeActive ? <p className="text-xs text-muted-foreground">An export for another date range is still running; its progress is shown below.</p> : null}
        {exportsQuery.isPending ? <p className="text-xs text-muted-foreground">Loading exports…</p> : null}
        {exportsQuery.error ? <p className="text-xs text-destructive" role="alert">{getErrorMessage(exportsQuery.error, "Could not load your exports.")}</p> : null}
        {current ? (
          <ExportProgress
            job={current}
            onRetry={() => retry.mutate(current.id)}
            onDownload={() => download.mutate(current.id)}
            retrying={retry.isPending}
            downloading={download.isPending}
          />
        ) : null}
        {actionError || checkError ? <p className="text-destructive" role="alert">{actionError ?? checkError}</p> : null}
      </div>
    </div>
  );
}
