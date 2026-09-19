"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { groupsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { useBulkAssignSalespersonMutation } from "@/lib/api-client/mutations/lead.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function AssignSalespersonDialog({
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
  const { data: groups } = useQuery(groupsQueryOptions());
  const bulkAssign = useBulkAssignSalespersonMutation();
  const [groupId, setGroupId] = useState("");
  const [method, setMethod] = useState<"MANUAL" | "ROUND_ROBIN">("MANUAL");
  const [salespersonId, setSalespersonId] = useState("");
  const [salespersonIds, setSalespersonIds] = useState<Set<string>>(new Set());

  const activeGroups = (groups ?? []).filter((g) => g.status === "ACTIVE");
  const selectedGroup = activeGroups.find((g) => g.id === groupId);
  const members = selectedGroup?.members.filter((m) => m.isActive) ?? [];

  function handleGroupChange(id: string) {
    setGroupId(id);
    setSalespersonId("");
    setSalespersonIds(new Set());
  }

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
        ? { leadIds, method, groupId, salespersonId }
        : { leadIds, method, groupId, salespersonIds: [...salespersonIds] },
      {
        onSuccess: (result) => {
          toast.success(`${result.assignedCount} lead(s) assigned.`);
          onDone();
        },
      },
    );
  }

  const canSubmit = Boolean(groupId) && (method === "MANUAL" ? Boolean(salespersonId) : salespersonIds.size > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Assign Salesperson</DialogTitle>
            <DialogDescription>{leadIds.length} lead(s) selected.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Group</Label>
              <select
                value={groupId}
                onChange={(e) => handleGroupChange(e.target.value)}
                className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs"
              >
                <option value="" disabled>
                  Select a group
                </option>
                {activeGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={method === "MANUAL"} onChange={() => setMethod("MANUAL")} />
                Manual
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={method === "ROUND_ROBIN"} onChange={() => setMethod("ROUND_ROBIN")} />
                Round Robin
              </label>
            </div>

            {method === "MANUAL" ? (
              <div className="space-y-1.5">
                <Label>Salesperson</Label>
                <select
                  value={salespersonId}
                  onChange={(e) => setSalespersonId(e.target.value)}
                  disabled={!groupId}
                  className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs"
                >
                  <option value="" disabled>
                    Select a salesperson
                  </option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Eligible salespeople</Label>
                <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border p-2">
                  {members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Select a group first.</p>
                  ) : null}
                  {members.map((m) => (
                    <label key={m.userId} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={salespersonIds.has(m.userId)}
                        onChange={(e) => toggleSalesperson(m.userId, e.target.checked)}
                      />
                      {m.user.name}
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
