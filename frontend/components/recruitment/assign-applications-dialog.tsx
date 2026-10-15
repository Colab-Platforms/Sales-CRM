"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { recruitersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import { useAssignApplicationsMutation } from "@/lib/api-client/mutations/recruitment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function AssignApplicationsDialog({
  applicationIds,
  open,
  onOpenChange,
  onDone,
}: {
  applicationIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { data: recruiters = [], isPending } = useQuery({ ...recruitersQueryOptions(), enabled: open });
  const assign = useAssignApplicationsMutation();
  const [selected, setSelected] = useState<string[]>([]);

  const active = recruiters.filter((r) => r.status === "ACTIVE");
  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  function handleAssign() {
    assign.mutate(
      { applicationIds, recruiterIds: selected },
      {
        onSuccess: (result) => {
          toast.success(`${result.assignedCount} application(s) assigned.`);
          setSelected([]);
          onDone();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSelected([]);
          assign.reset();
        }
        onOpenChange(next);
      }}
    >
      {open ? (
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Assign to recruiters</DialogTitle>
            <DialogDescription>
              {applicationIds.length} application(s) selected. Pick one recruiter, or several to split them evenly.
            </DialogDescription>
          </DialogHeader>

          <div className="sketch-outline max-h-64 space-y-1 overflow-y-auto p-2">
            {isPending ? (
              <p className="p-2 text-sm text-muted-foreground">Loading recruiters…</p>
            ) : active.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No active recruiters. Add one on the Recruiters page first.</p>
            ) : (
              active.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                  <input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} className="size-4" />
                  <span className="text-sm font-medium">{r.name}</span>
                  <span className="text-xs text-muted-foreground">{r.username}</span>
                </label>
              ))
            )}
          </div>

          {assign.error ? <p className="text-sm text-destructive">{getErrorMessage(assign.error, "Failed to assign.")}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button onClick={handleAssign} disabled={selected.length === 0 || assign.isPending}>
              {assign.isPending ? "Assigning..." : selected.length > 1 ? `Split across ${selected.length}` : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
