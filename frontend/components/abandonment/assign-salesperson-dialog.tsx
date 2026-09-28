"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { useBulkAssignSalespersonMutation } from "@/lib/api-client/mutations/abandonment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

// Same shape as leads/assign-salesperson-dialog.tsx, kept separate since it targets abandoned-lead ids.
export function AssignAbandonmentSalespersonDialog({
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
  const { data: salespersons, isPending, error } = useQuery({ ...mySalespersonsQueryOptions(), enabled: open });
  const bulkAssign = useBulkAssignSalespersonMutation();
  const [method, setMethod] = useState<"MANUAL" | "ROUND_ROBIN">("MANUAL");
  const [salespersonId, setSalespersonId] = useState("");
  const [salespersonIds, setSalespersonIds] = useState<Set<string>>(new Set());

  const team = salespersons ?? [];

  useEffect(() => {
    if (open) {
      setMethod("MANUAL");
      setSalespersonId("");
      setSalespersonIds(new Set());
    }
  }, [open]);

  function toggleSalesperson(id: string, checked: boolean) {
    setSalespersonIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleSubmit() {
    bulkAssign.mutate(
      method === "MANUAL"
        ? { abandonmentIds, method, salespersonId }
        : { abandonmentIds, method, salespersonIds: [...salespersonIds] },
      {
        onSuccess: (result) => {
          toast.success(`${result.assignedCount} abandoned lead(s) assigned.`);
          onDone();
        },
      },
    );
  }

  const canSubmit = method === "MANUAL" ? Boolean(salespersonId) : salespersonIds.size > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Assign Salesperson</DialogTitle>
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

            {error ? (
              <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load your salespeople.")}</p>
            ) : null}

            {!isPending && !error && team.length === 0 ? (
              <p className="text-sm text-muted-foreground">No salespeople report to you yet.</p>
            ) : null}

            {method === "MANUAL" ? (
              <div className="space-y-1.5">
                <Label>Salesperson</Label>
                <NativeSelect value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)} disabled={team.length === 0}>
                  <option value="" disabled>
                    Select a salesperson
                  </option>
                  {team.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.name} — {sp.groupName ?? "No team"}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Eligible salespeople</Label>
                <div className="sketch-outline max-h-48 space-y-0.5 overflow-y-auto p-1.5">
                  {team.map((sp) => (
                    <label key={sp.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
                      <input type="checkbox" checked={salespersonIds.has(sp.id)} onChange={(e) => toggleSalesperson(sp.id, e.target.checked)} />
                      {sp.name} — {sp.groupName ?? "No team"}
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
