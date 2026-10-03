"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Mic, Phone, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { useInitiateCallMutation } from "@/lib/api-client/mutations/calling.mutations";
import { virtualNumbersQueryOptions } from "@/lib/api-client/queries/calling.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import {
  ActiveCallDialog,
  CallOutcomeForm,
  CALL_STATUS_VARIANT,
  TERMINAL_CALL_STATUSES,
} from "@/components/calling/active-call-dialog";
import { Button } from "@/components/ui/button";
import { useCallTranscriptStream } from "./use-call-transcript-stream";
import type { Call } from "@/lib/api-client/types/calling.types";
import type { LeadFollowUp } from "@/lib/api-client/types/tasks.types";

export { CALL_STATUS_VARIANT, TERMINAL_CALL_STATUSES };

// The minimal shape these calling components need off a lead - satisfied structurally by both the
// full Lead type (leads pages) and AbandonmentListItem.lead (abandoned-leads pages), so both reuse
// the exact same click-to-call / active-call UI without either depending on the other's full type.
export interface CallableLead {
  id: string;
  firstName: string;
  lastName?: string | null;
  mobile: string | null;
  /** This lead's pending call back / follow up reminder, if any - passed through to the outcome form
   *  (both the just-ended live call and past-call history) so "Call back requested" pre-fills/replaces
   *  it instead of silently creating a second, conflicting reminder. */
  tasks?: LeadFollowUp[];
}

function formatDuration(seconds: number | null): string | null {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// One call, rendered the same way whether it's shown in the "latest 5" table popup or the full
// history on the lead detail page. `call.recording` is only ever non-null for ADMIN/MANAGER - the
// backend strips the URL for a SALESPERSON - so no role check is needed here, it just renders
// what it's given.
export function CallHistoryEntry({ leadId, call, currentFollowUp }: { leadId: string; call: Call; currentFollowUp?: LeadFollowUp | null }) {
  const currentUser = useAuthStore((s) => s.user);
  const DirectionIcon = call.direction === "INBOUND" ? PhoneIncoming : PhoneOutgoing;
  const duration = formatDuration(call.durationSeconds);

  const transcriptStatus = call.transcript?.status;
  const transcriptPending = Boolean(call.recording?.recordingUrl) && (!transcriptStatus || transcriptStatus === "PROCESSING");
  // Pushed, not polled - see use-call-transcript-stream.ts. Only opens a connection while this
  // specific call is actually waiting on one, and only for ADMIN/MANAGER (the only ones who can see
  // a transcript at all - a SALESPERSON never has `call.recording.recordingUrl` to begin with).
  useCallTranscriptStream(leadId, call.id, transcriptPending);

  // If the user is a SALESPERSON and this call was handled by a different salesperson (e.g. prior to reassignment),
  // they cannot change/log the outcome or notes. It is strictly read-only for them (no outcome form rendered).
  const isReadOnlyForCurrentSalesperson =
    currentUser?.role === "SALESPERSON" && Boolean(call.agent?.id && call.agent.id !== currentUser.id);

  return (
    <div className="sketch-outline space-y-2.5 p-3 text-sm bg-card/60">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <DirectionIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-semibold text-foreground">
              {call.startedAt ? new Date(call.startedAt).toLocaleString() : "Not started"}
            </p>
            <p className="text-xs text-muted-foreground">
              {call.agent?.name ?? "Unknown agent"}
              {duration ? ` · ${duration}` : ""}
            </p>
          </div>
        </div>
        <Badge variant={CALL_STATUS_VARIANT[call.status]}>
          {call.status.replaceAll("_", " ")}
        </Badge>
      </div>

      {call.recording?.recordingUrl ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2">
          <Mic className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <audio controls className="h-8 w-full min-w-0" src={call.recording.recordingUrl} />
        </div>
      ) : null}

      {/* Manager/admin-only, same gate as the recording above. Transcription runs in the background
          after the recording lands, so it can take a bit to appear - shown as a status line meanwhile. */}
      {call.recording?.recordingUrl ? (
        call.transcript?.transcriptText ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
              <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {call.transcript.diarizedText ? (
                <div className="min-w-0 flex-1 space-y-1">
                  {call.transcript.diarizedText.split("\n").map((line, i) => {
                    const [label, ...rest] = line.split(": ");
                    const text = rest.join(": ");
                    return (
                      <p key={i} className="text-muted-foreground leading-relaxed">
                        <span className={label === "Agent" ? "font-semibold text-primary" : "font-semibold text-foreground"}>{label}: </span>
                        {text}
                      </p>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground leading-relaxed">{call.transcript.transcriptText}</p>
              )}
            </div>
          </div>
        ) : call.transcript?.status === "FAILED" ? (
          <p className="text-xs text-muted-foreground">Transcription failed for this call.</p>
        ) : call.transcript?.status === "EMPTY" ? null : (
          <p className="text-xs text-muted-foreground">Transcribing…</p>
        )
      ) : null}

      {call.outcome || call.notes ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
          {call.outcome ? <p className="font-semibold text-foreground">Outcome: {call.outcome.name}</p> : null}
          {call.notes ? <p className="mt-1 text-muted-foreground leading-relaxed">{call.notes}</p> : null}
        </div>
      ) : null}

      {TERMINAL_CALL_STATUSES.has(call.status) && !isReadOnlyForCurrentSalesperson ? (
        <CallOutcomeForm leadId={leadId} call={call} currentFollowUp={currentFollowUp} />
      ) : null}
    </div>
  );
}

export function ClickToCallButton({ lead }: { lead: CallableLead }) {
  const initiateCall = useInitiateCallMutation(lead.id);
  const { data: virtualNumbers = [] } = useQuery(virtualNumbersQueryOptions());
  const [virtualNumberId, setVirtualNumberId] = useState("");
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const selected = virtualNumberId || virtualNumbers[0]?.id || "";

  if (!lead.mobile) return null;

  return (
    <div className="flex items-center gap-1">
      <NativeSelect
        size="sm"
        aria-label="Call from virtual number"
        className="text-xs"
        wrapperClassName="w-28"
        value={selected}
        disabled={initiateCall.isPending || virtualNumbers.length === 0}
        onChange={(e) => setVirtualNumberId(e.target.value)}
      >
        {virtualNumbers.length === 0 ? <option value="">No line</option> : null}
        {virtualNumbers.map((vn) => (
          <option key={vn.id} value={vn.id}>
            {vn.displayName ?? vn.number}
          </option>
        ))}
      </NativeSelect>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={`Call ${lead.firstName}`}
        disabled={initiateCall.isPending || !selected}
        onClick={() =>
          initiateCall.mutate(selected, {
            onSuccess: (result) => {
              toast.success("Calling your phone now — hold on.");
              setActiveCallId(result.callId);
            },
            onError: (error) =>
              toast.error(getErrorMessage(error, "Failed to start call.")),
          })
        }
      >
        <Phone className="size-3.5" />
      </Button>
      {activeCallId ? (
        <ActiveCallDialog
          lead={{ id: lead.id, firstName: lead.firstName, lastName: lead.lastName ?? null }}
          callId={activeCallId}
          currentFollowUp={lead.tasks?.[0]}
          onClose={() => setActiveCallId(null)}
        />
      ) : null}
    </div>
  );
}
