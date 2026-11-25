"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { abandonmentRecordingsApi, saveBlob } from "@/lib/api-client/endpoints/abandonment.recordings.api";
import { cn } from "@/lib/utils";
import { formatClock } from "@/components/abandonment/recording-cell";
import { seekPlayback, setPlaybackRate, setPlaybackVolume, stopPlaybackIf, togglePlayback, usePlayback } from "@/components/abandonment/recording-playback";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** The download icon that sits beside Play: saves this one recording (the same endpoint and permission rules as every other download). */
function DownloadButton({ callId }: { callId: string }) {
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      saveBlob(await abandonmentRecordingsApi.downloadOne(callId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not download this recording.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Download Recording" data-testid="download-recording" disabled={busy} onClick={() => void download()} />}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      </TooltipTrigger>
      <TooltipContent>Download Recording</TooltipContent>
    </Tooltip>
  );
}

/**
 * Plays one recording right in the table, with its download button beside Play. Every row is a view onto ONE shared audio element, so only one recording ever plays at a time; the row that plays
 * expands into progress bar, time, speed and volume. A row that leaves the screen (page / filter change) stops its own playback.
 */
export function RecordingPlayer({ callId, url, durationSeconds, unavailableReason }: { callId: string; url: string | null; durationSeconds: number | null; unavailableReason: string | null }) {
  const playback = usePlayback(callId);
  useEffect(() => () => stopPlaybackIf(callId), [callId]);

  if (!url) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="recording-unavailable">
        {unavailableReason ?? "Not available"}
      </span>
    );
  }
  const active = playback.activeId === callId;
  const duration = active && playback.duration > 0 ? playback.duration : (durationSeconds ?? 0);

  if (!active) {
    return (
      <div className="flex items-center gap-2" data-testid="recording-player-collapsed">
        <Button type="button" variant="outline" size="sm" aria-label="Play recording" onClick={() => togglePlayback(callId, url)}>
          <Play className="size-3.5" />
          Play
        </Button>
        {duration > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{formatClock(duration)}</span> : null}
        <DownloadButton callId={callId} />
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-[260px] flex-col gap-1.5 rounded-lg bg-primary/10 p-1.5 ring-1 ring-primary/40")} data-testid="recording-player-expanded" data-active="true">
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
        <DownloadButton callId={callId} />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
        <span data-testid="recording-time">
          {formatClock(playback.current)} / {formatClock(duration)}
        </span>
        <select value={playback.rate} onChange={(e) => setPlaybackRate(Number(e.target.value))} aria-label="Playback speed" className="h-6 rounded border bg-background px-1 text-xs text-foreground">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <span className="flex items-center gap-1.5">
          {playback.volume === 0 ? <VolumeX className="size-3.5" aria-hidden /> : <Volume2 className="size-3.5" aria-hidden />}
          <input type="range" className="h-1 w-14 cursor-pointer accent-primary" min={0} max={1} step={0.05} value={playback.volume} onChange={(e) => setPlaybackVolume(Number(e.target.value))} aria-label="Volume" />
        </span>
      </div>
      {playback.error ? (
        <span role="alert" className="text-xs text-destructive">
          {playback.error}
        </span>
      ) : null}
    </div>
  );
}
