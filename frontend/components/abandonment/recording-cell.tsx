"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { abandonmentRecordingsApi, saveBlob } from "@/lib/api-client/endpoints/abandonment.recordings.api";
import { formatDateTime } from "@/lib/order-status";
import type { Call } from "@/lib/api-client/types/calling.types";
import { seekPlayback, setPlaybackVolume, stopPlaybackIf, togglePlayback, usePlayback } from "./recording-playback";

/** Calls of a lead that have a playable recording (the server only sends the link to admins / managers), newest first. */
export function recordedCalls(calls: Call[]): Call[] {
  return calls.filter((call) => Boolean(call.recording?.recordingUrl)).sort((a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime());
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Listen to / download a lead's call recording(s). Rendered only for admin / manager. One recording plays at a time across the whole table (see recording-playback.ts). */
export function RecordingCell({ calls }: { calls: Call[] }) {
  const recorded = recordedCalls(calls);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = recorded[Math.min(index, Math.max(recorded.length - 1, 0))];
  const callId = call?.id ?? "";
  const playback = usePlayback(callId);

  // A row that leaves the screen (next page, filter change, navigation) or switches recording stops its own playback.
  useEffect(() => () => stopPlaybackIf(callId), [callId]);

  if (!call) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="no-recording">
        No recording
      </span>
    );
  }
  const url = call.recording!.recordingUrl!;
  const active = playback.activeId === callId;
  const duration = active && playback.duration > 0 ? playback.duration : (call.durationSeconds ?? 0);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      saveBlob(await abandonmentRecordingsApi.downloadOne(callId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  const downloadButton = (
    <Button type="button" variant="ghost" size="icon-sm" aria-label="Download recording" title="Download recording" onClick={download} disabled={busy}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
    </Button>
  );

  return (
    <div
      className={cn("flex min-w-[230px] max-w-[280px] flex-col gap-1.5 rounded-lg p-1.5 transition-colors", active && "bg-primary/10 ring-1 ring-primary/40")}
      data-testid="recording-cell"
      data-active={active ? "true" : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      {active ? (
        <div className="space-y-1.5" data-testid="recording-player-expanded">
          <div className="flex items-center gap-2">
            <Button type="button" size="icon-sm" aria-label={playback.playing ? "Pause recording" : "Play recording"} onClick={() => togglePlayback(callId, url)}>
              {playback.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <input
              type="range"
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary"
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              value={Math.min(playback.current, Math.max(duration, 1))}
              onChange={(e) => seekPlayback(Number(e.target.value))}
              aria-label="Seek recording"
            />
            {downloadButton}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
            <span data-testid="recording-time">
              {formatClock(playback.current)} / {formatClock(duration)}
            </span>
            <span className="flex items-center gap-1.5">
              {playback.volume === 0 ? <VolumeX className="size-3.5" aria-hidden /> : <Volume2 className="size-3.5" aria-hidden />}
              <input
                type="range"
                className="h-1 w-16 cursor-pointer accent-primary"
                min={0}
                max={1}
                step={0.05}
                value={playback.volume}
                onChange={(e) => setPlaybackVolume(Number(e.target.value))}
                aria-label="Volume"
              />
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2" data-testid="recording-player-collapsed">
          <Button type="button" variant="outline" size="sm" aria-label="Play recording" onClick={() => togglePlayback(callId, url)}>
            <Play className="size-3.5" />
            Play
          </Button>
          {duration > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{formatClock(duration)}</span> : null}
          <span className="ml-auto">{downloadButton}</span>
        </div>
      )}
      {recorded.length > 1 ? (
        <select className="h-7 rounded border bg-background px-1 text-xs" value={index} onChange={(e) => setIndex(Number(e.target.value))} aria-label="Choose a call recording">
          {recorded.map((c, i) => (
            <option key={c.id} value={i}>
              {c.startedAt ? formatDateTime(c.startedAt) : `Call ${recorded.length - i}`}
            </option>
          ))}
        </select>
      ) : null}
      {active && playback.error ? (
        <span role="alert" className="text-xs text-destructive">
          {playback.error}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
