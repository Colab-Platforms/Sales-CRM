"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Lock, Mic, Phone, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { useInitiateCallMutation, useSubmitCallOutcomeMutation } from "@/lib/api-client/mutations/calling.mutations";
import { virtualNumbersQueryOptions, callOutcomesQueryOptions, leadCallsQueryOptions } from "@/lib/api-client/queries/calling.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import type { Lead } from "@/lib/api-client/types/lead.types";
import type { Call, CallStatus } from "@/lib/api-client/types/calling.types";

export const CALL_STATUS_VARIANT: Record<
  CallStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  INITIATED: "outline",
  RINGING_AGENT: "outline",
  AGENT_ANSWERED: "outline",
  RINGING_CUSTOMER: "outline",
  CONNECTED: "default",
  COMPLETED: "default",
  NO_ANSWER: "secondary",
  BUSY: "secondary",
  NOT_REACHABLE: "secondary",
  FAILED: "destructive",
};

// A call the salesperson can (and should) log an outcome for - it's over, one way or another.
// Deliberately not limited to calls that connected: BUSY/NO_ANSWER/NOT_REACHABLE/FAILED are
// themselves outcomes a salesperson picks (they just never require a note - see requiresNote below).
export const TERMINAL_CALL_STATUSES: ReadonlySet<CallStatus> = new Set([
  "COMPLETED",
  "NO_ANSWER",
  "BUSY",
  "NOT_REACHABLE",
  "FAILED",
]);

function formatDuration(seconds: number | null): string | null {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CallOutcomeForm({ leadId, call, onSaved }: { leadId: string; call: Call; onSaved?: () => void }) {
  const { data: outcomes = [] } = useQuery(callOutcomesQueryOptions());
  const submitOutcome = useSubmitCallOutcomeMutation(leadId);
  const [outcomeId, setOutcomeId] = useState(call.outcome?.id ?? "");
  const [notes, setNotes] = useState(call.notes ?? "");

  const selectedOutcome = outcomes.find((o) => o.id === outcomeId);
  const noteMissing = Boolean(selectedOutcome?.requiresNote) && !notes.trim();

  function handleSave() {
    if (!outcomeId) return;
    submitOutcome.mutate(
      { callId: call.id, payload: { outcomeId, notes: notes.trim() || undefined } },
      {
        onSuccess: () => {
          toast.success("Call outcome saved.");
          onSaved?.();
        },
        onError: (error) => toast.error(getErrorMessage(error, "Failed to save call outcome.")),
      },
    );
  }

  return (
    <div className="space-y-2 border-t border-border/60 pt-2">
      <NativeSelect
        size="sm"
        aria-label="Call outcome"
        value={outcomeId}
        disabled={submitOutcome.isPending}
        onChange={(e) => setOutcomeId(e.target.value)}
      >
        <option value="">{call.outcome ? call.outcome.name : "Log outcome…"}</option>
        {outcomes.map((outcome) => (
          <option key={outcome.id} value={outcome.id}>
            {outcome.name}
          </option>
        ))}
      </NativeSelect>
      {/* Required once the outcome says the customer actually spoke (picked up) - not for a call that never connected. */}
      {selectedOutcome?.requiresNote ? (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="What did the customer say? (required note)"
          className="w-full min-w-0 resize-y rounded-[10px_8px_11px_8px] border-[1.5px] border-ink-line-soft bg-card/60 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ink-line focus:ring-1 focus:ring-ring shadow-xs"
        />
      ) : null}
      <Button
        size="sm"
        disabled={!outcomeId || noteMissing || submitOutcome.isPending}
        onClick={handleSave}
        className="sketch-press border-[1.5px] border-ink-line bg-primary text-primary-foreground font-semibold rounded-[10px_8px_11px_8px]"
      >
        {submitOutcome.isPending ? "Saving..." : "Save outcome"}
      </Button>
    </div>
  );
}

// One call, rendered the same way whether it's shown in the "latest 5" table popup or the full
// history on the lead detail page. `call.recording` is only ever non-null for ADMIN/MANAGER - the
// backend strips the URL for a SALESPERSON - so no role check is needed here, it just renders
// what it's given.
export function CallHistoryEntry({ leadId, call }: { leadId: string; call: Call }) {
  const currentUser = useAuthStore((s) => s.user);
  const DirectionIcon = call.direction === "INBOUND" ? PhoneIncoming : PhoneOutgoing;
  const duration = formatDuration(call.durationSeconds);

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

      {call.outcome || call.notes ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
          {call.outcome ? <p className="font-semibold text-foreground">Outcome: {call.outcome.name}</p> : null}
          {call.notes ? <p className="mt-1 text-muted-foreground leading-relaxed">{call.notes}</p> : null}
        </div>
      ) : null}

      {TERMINAL_CALL_STATUSES.has(call.status) && !isReadOnlyForCurrentSalesperson ? (
        <CallOutcomeForm leadId={leadId} call={call} />
      ) : null}
    </div>
  );
}

// One line of human-readable text per non-terminal CallStatus, shown while the popup is watching
// the call. Terminal statuses never reach here - they flip the popup into the outcome form instead.
const IN_PROGRESS_LABEL: Record<CallStatus, string> = {
  INITIATED: "Starting the call…",
  RINGING_AGENT: "Ringing your phone…",
  AGENT_ANSWERED: "Connecting you to the customer…",
  RINGING_CUSTOMER: "Ringing the customer…",
  CONNECTED: "On call…",
  COMPLETED: "Call ended",
  NO_ANSWER: "Call ended",
  BUSY: "Call ended",
  NOT_REACHABLE: "Call ended",
  FAILED: "Call ended",
};

// Live view of one just-started call: polls this lead's calls every 3s (webhook-driven status, no
// push channel exists) until this call reaches a terminal status, then swaps straight into the same
// outcome form the call history uses - so logging the result never waits on the salesperson
// remembering to open history afterwards.
export function ActiveCallDialog({ lead, callId, onClose }: { lead: Lead; callId: string; onClose: () => void }) {
  const { data: calls } = useQuery({
    ...leadCallsQueryOptions(lead.id),
    refetchInterval: (query) => {
      const call = query.state.data?.find((c) => c.id === callId);
      return call && TERMINAL_CALL_STATUSES.has(call.status) ? false : 3000;
    },
  });
  const call = calls?.find((c) => c.id === callId);
  const ended = Boolean(call && TERMINAL_CALL_STATUSES.has(call.status));

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {lead.firstName} {lead.lastName ?? ""}
          </DialogTitle>
          <DialogDescription>
            {ended ? "Call ended — log what happened." : "Call in progress."}
          </DialogDescription>
        </DialogHeader>

        {!ended ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {call ? IN_PROGRESS_LABEL[call.status] : "Starting the call…"}
          </div>
        ) : (
          call && (
            <div className="space-y-2">
              <Badge variant={CALL_STATUS_VARIANT[call.status]}>
                {call.status.replaceAll("_", " ")}
                {call.durationSeconds ? ` · ${call.durationSeconds}s` : ""}
              </Badge>
              <CallOutcomeForm leadId={lead.id} call={call} onSaved={onClose} />
            </div>
          )
        )}

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {ended ? "Log later" : "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ClickToCallButton({ lead }: { lead: Lead }) {
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
        <ActiveCallDialog lead={lead} callId={activeCallId} onClose={() => setActiveCallId(null)} />
      ) : null}
    </div>
  );
}
