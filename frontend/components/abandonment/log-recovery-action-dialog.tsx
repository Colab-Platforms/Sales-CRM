"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/lib/api-client/client";
import { useLogRecoveryActionMutation } from "@/lib/api-client/mutations/abandonment.mutations";
import { RECOVERY_ACTION_TYPE_LABELS } from "./abandonment-status-badge";
import type { RecoveryActionStatus, RecoveryActionType } from "@/lib/api-client/types/abandonment.types";

const TYPE_OPTIONS: RecoveryActionType[] = ["CALL", "CALLBACK", "CONTINUE_ORDER"];

const STATUS_LABELS: Record<RecoveryActionStatus, string> = {
  PENDING: "Attempted — no outcome yet",
  IN_PROGRESS: "Still following up",
  SUCCESS: "Recovered the sale",
  FAILED: "Could not recover",
};
const STATUS_OPTIONS: RecoveryActionStatus[] = ["PENDING", "IN_PROGRESS", "SUCCESS", "FAILED"];

// Same textarea styling as ui/input.tsx's Input, since this codebase has no dedicated Textarea primitive.
const TEXTAREA_CLASS =
  "w-full min-w-0 rounded-[11px_9px_12px_9px] border-[1.5px] border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

export function LogRecoveryActionDialog({ abandonmentId, open, onOpenChange, onDone }: { abandonmentId: string; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const logAction = useLogRecoveryActionMutation(abandonmentId);
  const [type, setType] = useState<RecoveryActionType>("CALL");
  const [status, setStatus] = useState<RecoveryActionStatus>("PENDING");
  const [notes, setNotes] = useState("");

  function reset() {
    setType("CALL");
    setStatus("PENDING");
    setNotes("");
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    logAction.mutate(
      { type, status, notes: notes || undefined },
      {
        onSuccess: () => {
          toast.success("Recovery action logged.");
          reset();
          onDone();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      {open ? (
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Log recovery action</DialogTitle>
            <DialogDescription>Record what happened when this lead was followed up on.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="recovery-type">Action</Label>
              <NativeSelect id="recovery-type" value={type} onChange={(e) => setType(e.target.value as RecoveryActionType)}>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {RECOVERY_ACTION_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recovery-status">Outcome</Label>
              <NativeSelect id="recovery-status" value={status} onChange={(e) => setStatus(e.target.value as RecoveryActionStatus)}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recovery-notes">Notes</Label>
              <textarea id="recovery-notes" className={cn(TEXTAREA_CLASS)} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did the customer say?" />
            </div>
            {logAction.error ? <p className="text-sm text-destructive">{getErrorMessage(logAction.error, "Failed to log recovery action.")}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={logAction.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={logAction.isPending}>
                {logAction.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
