"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useBulkUpdateLeadStatusMutation } from "@/lib/api-client/mutations/abandonment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import { localInputToIso } from "@/components/follow-ups/follow-up-utils";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";

// Admin-only bulk status change for abandoned leads - same tool the Leads page has
// (bulk-update-status-dialog.tsx), since an abandoned lead is still a Lead underneath. ASSIGNED is
// excluded: that status is a side effect of assigning a lead, not something to set directly here.
const SELECTABLE_STATUSES = STATUS_ORDER.filter((status) => status !== "ASSIGNED");

export function AbandonmentBulkUpdateStatusDialog({
  open,
  onOpenChange,
  abandonmentIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  abandonmentIds: string[];
  onDone: () => void;
}) {
  const bulkUpdateStatus = useBulkUpdateLeadStatusMutation();
  const [workingStatus, setWorkingStatus] = useState<LeadWorkingStatus>("NOT_INTERESTED");
  const [followUpAt, setFollowUpAt] = useState("");

  // Dialog stays mounted between opens - reset so a previous batch's picks don't carry over.
  useEffect(() => {
    if (open) {
      setWorkingStatus("NOT_INTERESTED");
      setFollowUpAt("");
    }
  }, [open]);

  const isFollowUpStatus = workingStatus === "CALL_BACK" || workingStatus === "FOLLOW_UP";
  const followUpIso = localInputToIso(followUpAt);
  const canSubmit = !isFollowUpStatus || Boolean(followUpIso);

  function handleSubmit() {
    bulkUpdateStatus.mutate(
      { abandonmentIds, workingStatus, followUpAt: isFollowUpStatus ? followUpIso : undefined },
      {
        onSuccess: (result) => {
          toast.success(`${result.updatedCount} lead(s) updated.`);
          onDone();
        },
        onError: (err) => toast.error(getErrorMessage(err, "Failed to update lead status.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Change Status</DialogTitle>
            <DialogDescription>{abandonmentIds.length} lead(s) selected.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="abandonment-bulk-status-select">Status</Label>
              <NativeSelect id="abandonment-bulk-status-select" value={workingStatus} onChange={(e) => setWorkingStatus(e.target.value as LeadWorkingStatus)}>
                {SELECTABLE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </NativeSelect>
            </div>

            {isFollowUpStatus ? (
              <div className="space-y-1.5">
                <Label htmlFor="abandonment-bulk-status-follow-up-at">
                  When should {workingStatus === "CALL_BACK" ? "the call back" : "the follow up"} be?
                </Label>
                <Input
                  id="abandonment-bulk-status-follow-up-at"
                  type="datetime-local"
                  value={followUpAt}
                  onChange={(e) => setFollowUpAt(e.target.value)}
                  disabled={bulkUpdateStatus.isPending}
                />
                <p className="text-xs text-muted-foreground">Applied to every selected lead.</p>
              </div>
            ) : null}

            {bulkUpdateStatus.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(bulkUpdateStatus.error, "Failed to update lead status.")}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={bulkUpdateStatus.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit || bulkUpdateStatus.isPending}>
              {bulkUpdateStatus.isPending ? "Updating..." : "Update Status"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
