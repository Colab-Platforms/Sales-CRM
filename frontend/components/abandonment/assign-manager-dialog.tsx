"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { managersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import { useBulkAssignManagerMutation } from "@/lib/api-client/mutations/abandonment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

// Same shape as leads/assign-manager-dialog.tsx, kept as its own component (like abandonment.filters.ts
// is kept separate from lead.service.ts) since it targets abandoned-lead ids, not lead ids.
export function AssignAbandonmentManagerDialog({
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
  const { data: managers } = useQuery({ ...managersQueryOptions(), enabled: open });
  const bulkAssign = useBulkAssignManagerMutation();
  const [method, setMethod] = useState<"MANUAL" | "ROUND_ROBIN">("MANUAL");
  const [managerId, setManagerId] = useState("");
  const [managerIds, setManagerIds] = useState<Set<string>>(new Set());

  const activeManagers = (managers ?? []).filter((m) => m.status === "ACTIVE");

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
      method === "MANUAL"
        ? { abandonmentIds, method, managerId }
        : { abandonmentIds, method, managerIds: [...managerIds] },
      {
        onSuccess: (result) => {
          toast.success(`${result.assignedCount} abandoned lead(s) assigned.`);
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
            <DialogDescription>{abandonmentIds.length} abandoned lead(s) selected.</DialogDescription>
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
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">No active managers available.</p>
                  ) : null}
                  {activeManagers.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
                      <input type="checkbox" checked={managerIds.has(m.id)} onChange={(e) => toggleManager(m.id, e.target.checked)} />
                      {m.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {bulkAssign.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(bulkAssign.error, "Failed to assign abandoned leads.")}</p>
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
