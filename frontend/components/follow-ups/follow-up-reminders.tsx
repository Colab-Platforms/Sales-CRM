"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { AlarmClock, BellRing, Check, ExternalLink, Phone, Quote, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ActiveCallDialog, type ActiveCallLead } from "@/components/calling/active-call-dialog";
import { customerDetailHref } from "@/components/orders/orders-table";
import { myFollowUpsQueryOptions } from "@/lib/api-client/queries/tasks.queries";
import { virtualNumbersQueryOptions } from "@/lib/api-client/queries/calling.queries";
import { useCompleteTaskMutation, useSnoozeTaskMutation } from "@/lib/api-client/mutations/tasks.mutations";
import { useInitiateCallMutation } from "@/lib/api-client/mutations/calling.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import type { FollowUpTask, LeadFollowUp } from "@/lib/api-client/types/tasks.types";
import { desktopNotify, loadSessionSet, playChime, saveSessionSet } from "./follow-up-alerts";
import {
  DUE_POPUP_WINDOW_MS,
  FOLLOW_UP_TYPE_LABEL,
  HEADS_UP_MS,
  formatRelative,
  formatWhen,
  leadDisplayName,
} from "./follow-up-utils";

const ALERTED_KEY = "follow-ups:alerted";
const DISMISSED_KEY = "follow-ups:dismissed";

// A reminder is identified by task + time, so snoozing (a new time) makes it fire again.
const reminderKey = (task: FollowUpTask) => `${task.id}@${task.scheduledAt}`;

/** Re-renders every `intervalMs` so time-based checks advance between polls. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function FollowUpDueDialog({
  task,
  now,
  onClose,
  onCallStarted,
}: {
  task: FollowUpTask;
  now: number;
  onClose: () => void;
  onCallStarted: (lead: ActiveCallLead, callId: string, current: LeadFollowUp) => void;
}) {
  const router = useRouter();
  const initiateCall = useInitiateCallMutation(task.lead.id);
  const completeTask = useCompleteTaskMutation();
  const snoozeTask = useSnoozeTaskMutation();
  const { data: virtualNumbers = [] } = useQuery(virtualNumbersQueryOptions());
  const [virtualNumberId, setVirtualNumberId] = useState("");
  const selectedLine = virtualNumberId || virtualNumbers[0]?.id || "";
  const busy = initiateCall.isPending || completeTask.isPending || snoozeTask.isPending;
  const name = leadDisplayName(task.lead);
  const lead: ActiveCallLead = { id: task.lead.id, firstName: task.lead.firstName, lastName: task.lead.lastName };

  function callNow() {
    initiateCall.mutate(selectedLine, {
      onSuccess: (result) => {
        toast.success("Calling your phone now — hold on.");
        onCallStarted(lead, result.callId, { id: task.id, type: task.type, scheduledAt: task.scheduledAt });
      },
      onError: (error) => toast.error(getErrorMessage(error, "Failed to start call.")),
    });
  }

  function snooze(minutes: number) {
    snoozeTask.mutate(
      { id: task.id, minutes },
      {
        onSuccess: () => {
          toast.success(`Snoozed — reminding you in ${minutes} min.`);
          onClose();
        },
        onError: (error) => toast.error(getErrorMessage(error, "Failed to snooze.")),
      },
    );
  }

  function markDone() {
    completeTask.mutate(task.id, {
      onSuccess: () => {
        toast.success("Reminder marked done.");
        onClose();
      },
      onError: (error) => toast.error(getErrorMessage(error, "Failed to mark done.")),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[460px]" showCloseButton={false}>
        {/* Header band: the one thing to notice at a glance - who, and that it's time. */}
        <div className="border-b border-border bg-primary/10 px-5 pt-5 pb-4">
          <div className="mb-3 flex items-center gap-3">
            <span className="relative flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/40" />
              <BellRing className="relative size-4" />
            </span>
            <Badge variant="outline" className="bg-card">
              {FOLLOW_UP_TYPE_LABEL[task.type]} due
            </Badge>
            <span className="ml-auto text-xs text-muted-foreground">{formatRelative(task.scheduledAt, now)}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-2 shrink-0 text-muted-foreground hover:bg-primary/20 hover:text-foreground"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </div>
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-xl">{name}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-sm text-foreground">{task.lead.mobile ?? "No phone number"}</span>
              <span className="text-muted-foreground/50">·</span>
              <span className="font-mono text-xs">{task.lead.leadNumber}</span>
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-5 pb-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlarmClock className="size-4" />
            Scheduled for <span className="font-medium text-foreground">{formatWhen(task.scheduledAt)}</span>
          </div>

          {task.description ? (
            <div className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <p className="whitespace-pre-wrap">{task.description}</p>
            </div>
          ) : null}

          {task.lead.mobile ? (
            <div className="flex gap-2">
              {virtualNumbers.length > 1 ? (
                <NativeSelect
                  aria-label="Call from virtual number"
                  wrapperClassName="w-36"
                  value={selectedLine}
                  disabled={busy}
                  onChange={(e) => setVirtualNumberId(e.target.value)}
                >
                  {virtualNumbers.map((vn) => (
                    <option key={vn.id} value={vn.id}>
                      {vn.displayName ?? vn.number}
                    </option>
                  ))}
                </NativeSelect>
              ) : null}
              <Button className="flex-1" size="lg" onClick={callNow} disabled={busy || !selectedLine}>
                <Phone />
                {virtualNumbers.length === 0 ? "No calling line set up" : "Call now"}
              </Button>
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-2">
            <Button variant="outline" size="sm" onClick={() => snooze(10)} disabled={busy}>
              <AlarmClock />
              10 min
            </Button>
            <Button variant="outline" size="sm" onClick={() => snooze(30)} disabled={busy}>
              <AlarmClock />
              30 min
            </Button>
            <Button variant="outline" size="sm" onClick={markDone} disabled={busy}>
              <Check />
              Done
            </Button>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <Button
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => {
                onClose();
                router.push(customerDetailHref(task.lead.id));
              }}
            >
              <ExternalLink />
              Open lead
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Later
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Watches the signed-in user's pending call backs / follow-ups: a heads-up toast (plus desktop
 * notification and chime) 5 minutes before, and a pop-up at the scheduled time. Only works while a
 * CRM tab is open - there is no push/background service.
 */
export function FollowUpReminders() {
  const router = useRouter();
  const { data: followUps = [] } = useQuery(myFollowUpsQueryOptions());
  const now = useNow(10_000);
  const alerted = useRef<Set<string> | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadSessionSet(DISMISSED_KEY));
  const [activeCall, setActiveCall] = useState<{ lead: ActiveCallLead; callId: string; current: LeadFollowUp } | null>(null);

  function dismiss(task: FollowUpTask) {
    setDismissed((prev) => {
      const next = new Set(prev).add(reminderKey(task));
      saveSessionSet(DISMISSED_KEY, next);
      return next;
    });
  }

  // The oldest reminder that is due now and hasn't been handled yet. One pop-up at a time.
  const dueTask = activeCall
    ? undefined
    : followUps.find((task) => {
        const at = new Date(task.scheduledAt).getTime();
        return at <= now && now - at < DUE_POPUP_WINDOW_MS && !dismissed.has(reminderKey(task));
      });

  useEffect(() => {
    alerted.current ??= loadSessionSet(ALERTED_KEY);
    const fired = alerted.current;
    let changed = false;

    for (const task of followUps) {
      const at = new Date(task.scheduledAt).getTime();
      const key = reminderKey(task);
      const name = leadDisplayName(task.lead);
      const kind = FOLLOW_UP_TYPE_LABEL[task.type];

      if (at > now && at - now <= HEADS_UP_MS && !fired.has(`soon:${key}`)) {
        fired.add(`soon:${key}`);
        changed = true;
        toast(`${kind} ${name} ${formatRelative(task.scheduledAt, now)}`, {
          description: task.description ?? task.lead.mobile ?? undefined,
          icon: <BellRing className="size-4 text-primary" />,
          duration: 20_000,
          action: { label: "Open lead", onClick: () => router.push(customerDetailHref(task.lead.id)) },
        });
        desktopNotify(`${kind} in 5 minutes`, `${name}${task.lead.mobile ? ` · ${task.lead.mobile}` : ""}`, `soon:${key}`);
        playChime(1);
      }

      if (at <= now && now - at < DUE_POPUP_WINDOW_MS && !fired.has(`due:${key}`)) {
        fired.add(`due:${key}`);
        changed = true;
        desktopNotify(`${kind} now: ${name}`, task.description ?? task.lead.mobile ?? "", `due:${key}`, true);
        playChime(2);
      }
    }

    if (changed) saveSessionSet(ALERTED_KEY, fired);
  }, [followUps, now, router]);

  return (
    <>
      {dueTask ? (
        <FollowUpDueDialog
          key={reminderKey(dueTask)}
          task={dueTask}
          now={now}
          onClose={() => dismiss(dueTask)}
          onCallStarted={(lead, callId, current) => {
            dismiss(dueTask);
            setActiveCall({ lead, callId, current });
          }}
        />
      ) : null}
      {activeCall ? (
        <ActiveCallDialog lead={activeCall.lead} currentFollowUp={activeCall.current} callId={activeCall.callId} onClose={() => setActiveCall(null)} />
      ) : null}
    </>
  );
}
