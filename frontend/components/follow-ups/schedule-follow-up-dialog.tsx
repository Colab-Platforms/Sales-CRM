"use client";

import { useState } from "react";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FollowUpTimePicker } from "./follow-up-time-picker";
import { localInputToIso, toLocalInputValue } from "./follow-up-utils";
import type { LeadFollowUp } from "@/lib/api-client/types/tasks.types";
import { useFollowUpConflict } from "./use-follow-up-conflict";

/**
 * Asks when to call back / follow up. Used both when a lead is switched to that status and (with
 * `reschedule`) to move the reminder a lead already has - then the existing time is shown and pre-filled.
 */
export function ScheduleFollowUpDialog({
  kind,
  leadId,
  leadName,
  current,
  reschedule,
  isPending,
  onConfirm,
  onCancel,
}: {
  kind: "CALL_BACK" | "FOLLOW_UP";
  leadId: string;
  leadName: string;
  /** The reminder already set on the lead, if any. */
  current?: LeadFollowUp | null;
  reschedule?: boolean;
  isPending: boolean;
  onConfirm: (followUpAtIso: string) => void;
  onCancel: () => void;
}) {
  const currentValue = current ? toLocalInputValue(new Date(current.scheduledAt)) : "";
  // Rescheduling starts from the time that's set now; switching status starts empty.
  const [value, setValue] = useState(reschedule ? currentValue : "");
  const iso = localInputToIso(value);
  const { conflict } = useFollowUpConflict(leadId, value);
  const verb = kind === "CALL_BACK" ? "call back" : "follow up";
  const unchanged = reschedule && value === currentValue;

  return (
    <Dialog open onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="size-4 text-primary" />
            {reschedule ? `Reschedule ${verb}` : `When should you ${verb}?`}
          </DialogTitle>
          <DialogDescription>
            {reschedule ? (
              <>Change when you&apos;re reminded about {leadName}.</>
            ) : (
              <>
                {leadName} will be marked <span className="font-medium text-foreground">{kind === "CALL_BACK" ? "Call back" : "Follow up"}</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <FollowUpTimePicker id="schedule-follow-up-at" label="Remind me at" leadId={leadId} current={current} value={value} onChange={setValue} disabled={isPending} />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => iso && onConfirm(iso)} disabled={!iso || unchanged || Boolean(conflict) || isPending}>
            {reschedule ? "Update reminder" : "Set reminder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
