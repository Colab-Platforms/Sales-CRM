"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FollowUpTimePicker } from "@/components/follow-ups/follow-up-time-picker";
import { localInputToIso } from "@/components/follow-ups/follow-up-utils";
import { useFollowUpConflict } from "@/components/follow-ups/use-follow-up-conflict";
import { useSubmitCallOutcomeMutation } from "@/lib/api-client/mutations/calling.mutations";
import { callOutcomesQueryOptions, leadCallsQueryOptions } from "@/lib/api-client/queries/calling.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import type { Call, CallStatus } from "@/lib/api-client/types/calling.types";
import type { LeadFollowUp } from "@/lib/api-client/types/tasks.types";

export const CALL_STATUS_VARIANT: Record<CallStatus, "default" | "secondary" | "destructive" | "outline"> = {
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

export function CallOutcomeForm({
  leadId,
  call,
  currentFollowUp,
  onSaved,
}: {
  leadId: string;
  call: Call;
  /** The reminder already on this lead - shown in the time picker, and replaced if a new time is saved. */
  currentFollowUp?: LeadFollowUp | null;
  onSaved?: () => void;
}) {
  const { data: outcomes = [] } = useQuery(callOutcomesQueryOptions());
  const submitOutcome = useSubmitCallOutcomeMutation(leadId);
  const [outcomeId, setOutcomeId] = useState(call.outcome?.id ?? "");
  const [notes, setNotes] = useState(call.notes ?? "");
  const [followUpAt, setFollowUpAt] = useState("");

  const selectedOutcome = outcomes.find((o) => o.id === outcomeId);
  const noteMissing = Boolean(selectedOutcome?.requiresNote) && !notes.trim();
  const followUpIso = localInputToIso(followUpAt);
  const followUpMissing = Boolean(selectedOutcome?.requiresFollowup) && !followUpIso;
  const { conflict: timeTaken } = useFollowUpConflict(leadId, selectedOutcome?.requiresFollowup ? followUpAt : "");

  function handleSave() {
    if (!outcomeId) return;
    submitOutcome.mutate(
      {
        callId: call.id,
        payload: {
          outcomeId,
          notes: notes.trim() || undefined,
          followUpAt: selectedOutcome?.requiresFollowup ? followUpIso : undefined,
        },
      },
      {
        onSuccess: () => {
          toast.success(selectedOutcome?.requiresFollowup ? "Saved — reminder set." : "Call outcome saved.");
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
          placeholder="What did the customer say? (required)"
          className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
      ) : null}
      {selectedOutcome?.requiresFollowup ? (
        <FollowUpTimePicker
          id={`follow-up-at-${call.id}`}
          leadId={leadId}
          current={currentFollowUp}
          label={`When should you ${selectedOutcome.code === "CALL_BACK_REQUESTED" ? "call back" : "follow up"}?`}
          value={followUpAt}
          onChange={setFollowUpAt}
          disabled={submitOutcome.isPending}
        />
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={!outcomeId || noteMissing || followUpMissing || Boolean(timeTaken) || submitOutcome.isPending}
        onClick={handleSave}
      >
        Save outcome
      </Button>
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

export interface ActiveCallLead {
  id: string;
  firstName: string;
  lastName: string | null;
}

// Live view of one just-started call: polls this lead's calls every 3s (webhook-driven status, no
// push channel exists) until this call reaches a terminal status, then swaps straight into the same
// outcome form the call history uses - so logging the result never waits on the salesperson
// remembering to open history afterwards.
export function ActiveCallDialog({
  lead,
  callId,
  currentFollowUp,
  onClose,
}: {
  lead: ActiveCallLead;
  callId: string;
  currentFollowUp?: LeadFollowUp | null;
  onClose: () => void;
}) {
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
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {lead.firstName} {lead.lastName ?? ""}
          </DialogTitle>
          <DialogDescription>{ended ? "Call ended — log what happened." : "Call in progress."}</DialogDescription>
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
              <CallOutcomeForm leadId={lead.id} call={call} currentFollowUp={currentFollowUp} onSaved={onClose} />
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
