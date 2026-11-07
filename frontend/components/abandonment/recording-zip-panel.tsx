"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileArchive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { abandonmentRecordingsApi, describeRequestError } from "@/lib/api-client/endpoints/abandonment.recordings.api";
import { ExportHistory, RangeControls, isActive, istDay, useExportActions, useExports } from "./export-shared";

/**
 * Admin / manager only. Downloads the call RECORDING audio files of abandoned leads as one ZIP for one day or a custom From - To range, built in the background with live progress,
 * history, expiry and retry. A section of its own, independent of the lead Excel export: separate range, separate history, separate limits.
 */
export function RecordingZipPanel() {
  const [from, setFromRaw] = useState(istDay());
  const [to, setToRaw] = useState(istDay());
  const { exports } = useExports("ZIP");
  const actions = useExportActions("ZIP");
  const rangeInvalid = !from || !to || from > to;
  // How many recordings the range holds (and how many are unavailable) - checked before anything is exported.
  const check = useQuery({ queryKey: ["abandonment-recordings-summary", from, to], queryFn: () => abandonmentRecordingsApi.summary({ from, to }), enabled: !rangeInvalid, staleTime: 15_000, retry: 2 });
  const summary = rangeInvalid ? null : (check.data ?? null);
  const running = exports.find((e) => e.from === from && e.to === to && isActive(e));

  return (
    <div className="sketch-outline flex flex-wrap items-end gap-4 bg-card/60 p-4" data-testid="recording-zip-panel">
      <div className="space-y-1">
        <p className="text-sm font-medium">Download call recordings (ZIP)</p>
        <p className="text-xs text-muted-foreground">All available call recordings of abandoned leads in the date range, as one ZIP of audio files, prepared in the background.</p>
      </div>
      <RangeControls from={from} to={to} idPrefix="recording-zip" onChange={(f, t) => { setFromRaw(f); setToRaw(t); actions.setError(null); }} />
      <Button type="button" onClick={() => actions.start.mutate({ from, to })} disabled={actions.start.isPending || rangeInvalid || Boolean(running) || check.isFetching || Boolean(summary && summary.total === 0)} data-testid="download-zip">
        {actions.start.isPending ? <Loader2 className="animate-spin" /> : <FileArchive />}
        {running ? "ZIP in progress…" : "Download ZIP"}
      </Button>

      <div className="w-full space-y-2 text-sm" aria-live="polite">
        {rangeInvalid ? <p className="text-destructive" role="alert">Choose a From date that is not after the To date.</p> : null}
        {check.isFetching ? <p className="text-muted-foreground">Checking recordings…</p> : null}
        {summary && !check.isFetching ? (
          summary.total === 0 ? (
            <p className="text-muted-foreground" data-testid="recordings-empty">No call recordings found for this date range.</p>
          ) : (
            <p className="text-muted-foreground" data-testid="recordings-summary">
              {summary.available} recording{summary.available === 1 ? "" : "s"} available
              {summary.unavailable > 0 ? <span className="text-amber-600"> · {summary.unavailable} unavailable (will be skipped)</span> : null}
              {summary.duplicates > 0 ? ` · ${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"} left out` : ""}
            </p>
          )
        ) : null}
        {check.error && !rangeInvalid ? (
          <p className="flex flex-wrap items-center gap-2 text-destructive" role="alert" data-testid="summary-error">
            {describeRequestError(check.error, "Could not check the recordings for this range.")}
            <Button type="button" size="sm" variant="outline" onClick={() => void check.refetch()} disabled={check.isFetching}>Try again</Button>
          </p>
        ) : null}
        <ExportHistory kind="ZIP" title="Recent recording exports" />
      </div>
    </div>
  );
}
