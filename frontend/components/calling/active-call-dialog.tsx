"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Phone, PhoneCall, PhoneMissed, PhoneOff } from "lucide-react";
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

// Imperative handle so the active-call dialog's own "Close"/"Log later" button can ask this form
// "is there a selected-but-unsaved outcome?" before actually closing, instead of silently discarding
// it - see requestClose below.
export interface CallOutcomeFormHandle {
  /** Returns true if it's safe for the caller to close immediately. Returns false if it either
   *  kicked off a save (caller should wait for onSaved to close) or blocked an invalid selection
   *  with a toast (caller should stay open). */
  requestClose: () => boolean;
}

export const CallOutcomeForm = forwardRef<CallOutcomeFormHandle, {
  leadId: string;
  call: Call;
  /** The reminder already on this lead - shown in the time picker, and replaced if a new time is saved. */
  currentFollowUp?: LeadFollowUp | null;
  onSaved?: () => void;
  /** Live active-call dialog only: if the salesperson already picked a (valid) outcome while the
   *  call was still connected, save it the instant the call ends instead of making them click Save
   *  again. Left off for the call-history form, where `call` is already terminal on mount and
   *  nothing was just "selected" in this render. */
  autoSaveOnEnd?: boolean;
}>(function CallOutcomeForm({
  leadId,
  call,
  currentFollowUp,
  onSaved,
  autoSaveOnEnd = false,
}, ref) {
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
  const canSave = Boolean(outcomeId) && !noteMissing && !followUpMissing && !timeTaken && !submitOutcome.isPending;
  // True once the salesperson has picked something that hasn't made it to the server yet (a fresh
  // pick while live, or an edit to an already-saved outcome) - the case the Close button must not
  // silently throw away.
  const hasUnsavedSelection = Boolean(outcomeId) && !(call.outcome?.id === outcomeId && notes === (call.notes ?? ""));

  useImperativeHandle(ref, () => ({
    requestClose: () => {
      if (!hasUnsavedSelection) return true;
      // A save is already underway (e.g. auto-saved on call end) - don't close yet and don't nag;
      // onSaved will close the dialog once it lands.
      if (submitOutcome.isPending) return false;
      if (canSave) {
        handleSave();
        return false;
      }
      toast.error(
        noteMissing
          ? "Add a note for this outcome before closing."
          : followUpMissing
            ? "Pick a follow-up time before closing."
            : "Finish logging the outcome before closing.",
      );
      return false;
    },
  }));

  const isTerminal = TERMINAL_CALL_STATUSES.has(call.status);
  const wasTerminalRef = useRef(isTerminal);
  useEffect(() => {
    const justEnded = isTerminal && !wasTerminalRef.current;
    wasTerminalRef.current = isTerminal;
    if (autoSaveOnEnd && justEnded && canSave) {
      handleSave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal]);

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
        disabled={!canSave}
        onClick={handleSave}
      >
        Save outcome
      </Button>
    </div>
  );
});


// The outcome form should appear the moment the customer actually picks up - not just once the call
// has ended - so the salesperson can log it live instead of hunting for it afterwards.
const CONNECTED_OR_LATER: ReadonlySet<CallStatus> = new Set(["CONNECTED", ...TERMINAL_CALL_STATUSES]);

// The three stages a live call walks through, in order. Terminal statuses are past the last one.
const CALL_STAGES = ["Your phone", "Customer", "Connected"] as const;

function stageIndex(status: CallStatus | undefined): number {
  switch (status) {
    case undefined:
    case "INITIATED":
    case "RINGING_AGENT":
      return 0;
    case "AGENT_ANSWERED":
    case "RINGING_CUSTOMER":
      return 1;
    default:
      return 2;
  }
}

const HEADLINE: Record<CallStatus, string> = {
  INITIATED: "Starting the call…",
  RINGING_AGENT: "Ringing your phone",
  AGENT_ANSWERED: "Calling the customer",
  RINGING_CUSTOMER: "Calling the customer",
  CONNECTED: "On call",
  COMPLETED: "Call ended",
  NO_ANSWER: "No answer",
  BUSY: "Customer busy",
  NOT_REACHABLE: "Customer not reachable",
  FAILED: "Call failed",
};

const HINT: Partial<Record<CallStatus, string>> = {
  INITIATED: "Setting up the connection.",
  RINGING_AGENT: "Pick up your phone to be connected.",
  AGENT_ANSWERED: "Hang on, dialing the customer.",
  RINGING_CUSTOMER: "Hang on, dialing the customer.",
  CONNECTED: "You can log the outcome while you talk.",
};

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Ticks once a second from the moment the customer picked up; once the call ends it shows the
// provider's final duration instead.
function useCallClock(call: Call | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  const live = call?.status === "CONNECTED";
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  if (!call) return null;
  if (live) {
    const from = call.answeredAt ? new Date(call.answeredAt).getTime() : null;
    return from ? formatClock(Math.max(0, Math.floor((now - from) / 1000))) : null;
  }
  return call.durationSeconds ? formatClock(call.durationSeconds) : null;
}

function initialsOf(lead: ActiveCallLead): string {
  return `${lead.firstName[0] ?? ""}${lead.lastName?.[0] ?? ""}`.toUpperCase() || "?";
}

function CallHero({ lead, call }: { lead: ActiveCallLead; call: Call | undefined }) {
  const status = call?.status;
  const ended = Boolean(status && TERMINAL_CALL_STATUSES.has(status));
  const connected = status === "CONNECTED";
  const good = status === "COMPLETED";
  const bad = status === "FAILED";
  const clock = useCallClock(call);

  const Icon = ended ? (bad ? PhoneOff : good ? PhoneCall : PhoneMissed) : connected ? PhoneCall : Phone;
  const tone =
    connected || good
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : bad
        ? "bg-destructive/15 text-destructive"
        : ended
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          : "bg-primary/10 text-primary";
  const ring = connected ? "bg-emerald-500/30" : "bg-primary/25";

  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <div className="relative flex size-20 items-center justify-center">
        {!ended ? <span className={`absolute inset-0 animate-ping rounded-full ${ring}`} /> : null}
        <span className={`relative flex size-20 items-center justify-center rounded-full ${tone}`}>
          <Icon className="size-8" />
        </span>
        <span className="absolute -bottom-1 -right-1 flex size-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[11px] font-semibold text-foreground">
          {initialsOf(lead)}
        </span>
      </div>

      <div className="space-y-0.5">
        <p className="text-base font-semibold leading-tight">
          {lead.firstName} {lead.lastName ?? ""}
        </p>
        <p className="text-sm font-medium">{status ? HEADLINE[status] : "Starting the call…"}</p>
        {status && HINT[status] ? <p className="text-xs text-muted-foreground">{HINT[status]}</p> : null}
      </div>

      {clock ? <p className="font-mono text-2xl font-semibold tabular-nums tracking-wider">{clock}</p> : null}
    </div>
  );
}

function CallStepper({ status }: { status: CallStatus | undefined }) {
  const ended = Boolean(status && TERMINAL_CALL_STATUSES.has(status));
  const current = stageIndex(status);
  return (
    <ol className="flex items-center gap-2" aria-label="Call progress">
      {CALL_STAGES.map((label, i) => {
        const done = ended ? i <= current : i < current;
        const active = !ended && i === current;
        return (
          <li key={label} className="flex flex-1 flex-col gap-1.5">
            <span
              className={`h-1.5 rounded-full transition-colors ${
                done ? "bg-emerald-500" : active ? "animate-pulse bg-primary" : "bg-muted"
              }`}
            />
            <span className={`text-center text-[11px] ${done || active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

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
  // Nobody spoke: the backend already logged "Ringing / no answer", so there's no form to fill in.
  const noAnswer = call?.status === "NO_ANSWER";
  const showOutcome = Boolean(call && !noAnswer && CONNECTED_OR_LATER.has(call.status));
  const outcomeFormRef = useRef<CallOutcomeFormHandle>(null);

  // Closing (the footer button, the built-in "X", Escape, or a click outside) must never silently
  // drop a selected-but-unsaved outcome. Asks the form: it returns true when there's nothing unsaved
  // (close now), or false when it either kicked off a save (the dialog closes itself via onSaved once
  // that resolves) or blocked with a toast telling the salesperson what's missing.
  function mayCloseNow() {
    return !outcomeFormRef.current || outcomeFormRef.current.requestClose();
  }

  return (
    <Dialog
      open
      // base-ui drives the close itself for the X / Escape / outside-press (see DialogStore.setOpen:
      // it runs dispatchOpenChange unless eventDetails.isCanceled). The controlled `open` prop alone
      // does NOT hold it open, so when we want to keep it open we must call eventDetails.cancel().
      onOpenChange={(open, eventDetails) => {
        if (open) return;
        if (mayCloseNow()) {
          onClose();
        } else {
          eventDetails.cancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader className="sr-only">
          <DialogTitle>
            Call with {lead.firstName} {lead.lastName ?? ""}
          </DialogTitle>
          <DialogDescription>Live call status and outcome.</DialogDescription>
        </DialogHeader>

        <CallHero lead={lead} call={call} />
        <CallStepper status={call?.status} />

        {noAnswer ? (
          <p className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2.5 text-center text-sm text-muted-foreground">
            Marked as <span className="font-medium text-foreground">Ringing / no answer</span> automatically.
          </p>
        ) : showOutcome && call ? (
          <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {ended ? "Log what happened" : "Log outcome"}
              </span>
              <Badge variant={CALL_STATUS_VARIANT[call.status]}>{call.status.replaceAll("_", " ")}</Badge>
            </div>
            <CallOutcomeForm
              ref={outcomeFormRef}
              leadId={lead.id}
              call={call}
              currentFollowUp={currentFollowUp}
              onSaved={onClose}
              autoSaveOnEnd
            />
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for updates…
          </div>
        )}

        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (mayCloseNow()) onClose();
            }}
          >
            {ended && !noAnswer ? "Log later" : "Close"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
