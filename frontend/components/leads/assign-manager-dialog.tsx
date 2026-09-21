"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { managersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import { useBulkAssignManagerMutation } from "@/lib/api-client/mutations/lead.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export function AssignManagerDialog({
  open,
  onOpenChange,
  leadIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadIds: string[];
  onDone: () => void;
}) {
  const { data: managers } = useQuery({ ...managersQueryOptions(), enabled: open });
  const bulkAssign = useBulkAssignManagerMutation();
  const [method, setMethod] = useState<"MANUAL" | "ROUND_ROBIN">("MANUAL");
  const [managerId, setManagerId] = useState("");
  const [managerIds, setManagerIds] = useState<Set<string>>(new Set());

  const activeManagers = (managers ?? []).filter((m) => m.status === "ACTIVE");

  // This dialog stays mounted between opens (only its content is conditionally
  // rendered), so without this reset a stale manager selection from a previous
  // batch could silently carry over into a new one.
  useEffect(() => {
    if (open) {
      setMethod("MANUAL");
      setManagerId("");
      setManagerIds(new Set());
    }
  }, [open]);

  function toggleManager(id: string, checked: boolean) {
    setManagerIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleSubmit() {
    bulkAssign.mutate(
      method === "MANUAL" ? { leadIds, method, managerId } : { leadIds, method, managerIds: [...managerIds] },
      {
        onSuccess: (result) => {
          toast.success(`${result.assignedCount} lead(s) assigned.`);
          onDone();
        },
      },
    );
  }

  const canSubmit = method === "MANUAL" ? Boolean(managerId) : managerIds.size > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Assign Manager</DialogTitle>
            <DialogDescription>{leadIds.length} lead(s) selected.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2.5">
              <label className="sketch-outline flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-sm font-medium has-checked:border-primary/60 has-checked:bg-primary/8">
                <input type="radio" checked={method === "MANUAL"} onChange={() => setMethod("MANUAL")} />
                Manual
              </label>
              <label className="sketch-outline flex cursor-pointer items-center gap-2.5 px-3 py-2.5 text-sm font-medium has-checked:border-primary/60 has-checked:bg-primary/8">
                <input type="radio" checked={method === "ROUND_ROBIN"} onChange={() => setMethod("ROUND_ROBIN")} />
                Round Robin
              </label>
            </div>

            {method === "MANUAL" ? (
              <div className="space-y-1.5">
                <Label>Manager</Label>
                <NativeSelect value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="" disabled>
                    Select a manager
                  </option>
                  {activeManagers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Eligible managers</Label>
                <div className="sketch-outline max-h-48 space-y-0.5 overflow-y-auto p-1.5">
                  {activeManagers.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      No active managers available.
                    </p>
                  ) : null}
                  {activeManagers.map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={managerIds.has(m.id)}
                        onChange={(e) => toggleManager(m.id, e.target.checked)}
                      />
                      {m.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {bulkAssign.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(bulkAssign.error, "Failed to assign leads.")}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={bulkAssign.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!canSubmit || bulkAssign.isPending}>
              {bulkAssign.isPending ? "Assigning..." : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
