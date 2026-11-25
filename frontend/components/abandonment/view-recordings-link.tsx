"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Headphones, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { abandonmentRecordingsApi, saveBlob } from "@/lib/api-client/endpoints/abandonment.recordings.api";
import { callRecordingsHref } from "@/lib/call-recordings-href";
import { formatDateTime } from "@/lib/order-status";
import type { Call } from "@/lib/api-client/types/calling.types";
import { recordedCalls } from "./recording-cell";

/**
 * The Recording column of the Abandoned Leads table (admin / manager only). "View Recordings" opens the Call Recordings page already filtered to this lead (every recording of the
 * lead, by every telecaller), and the download button saves a recording straight from here: one recording downloads at once, several offer a choice by call time (newest first).
 * A lead with no recording shows "No recording".
 */
export function ViewRecordingsLink({ leadId, calls }: { leadId: string; calls: Call[] }) {
  const router = useRouter();
  const recorded = recordedCalls(calls);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (recorded.length === 0) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="no-recording">
        No recording
      </span>
    );
  }

  async function download(callId: string) {
    setBusyId(callId);
    try {
      saveBlob(await abandonmentRecordingsApi.downloadOne(callId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not download this recording.");
    } finally {
      setBusyId(null);
    }
  }

  const busy = busyId !== null;
  const icon = busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />;

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <Button type="button" variant="outline" size="sm" data-testid="view-recordings" onClick={() => router.push(callRecordingsHref(leadId))}>
        <Headphones className="size-3.5" />
        View Recordings{recorded.length > 1 ? ` (${recorded.length})` : ""}
      </Button>
      {recorded.length === 1 ? (
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Download recording" title="Download recording" data-testid="download-recording" disabled={busy} onClick={() => void download(recorded[0]!.id)}>
          {icon}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Download a recording" title="Download a recording" data-testid="download-recording" disabled={busy} />}>{icon}</DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Download a recording</DropdownMenuLabel>
            </DropdownMenuGroup>
            {recorded.map((c, i) => (
              <DropdownMenuItem key={c.id} onClick={() => void download(c.id)}>
                <Download className="size-3.5" />
                {c.startedAt ? formatDateTime(c.startedAt) : `Call ${recorded.length - i}`}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
