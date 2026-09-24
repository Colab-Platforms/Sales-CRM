"use client";

import { toast } from "sonner";
import { useDeleteLeadMutation } from "@/lib/api-client/mutations/lead.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function DeleteLeadDialog({
  lead,
  open,
  onOpenChange,
  onDeleted,
}: {
  lead: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const deleteLead = useDeleteLeadMutation();

  function handleConfirm() {
    if (!lead) return;
    deleteLead.mutate(lead.id, {
      onSuccess: () => {
        toast.success(`${lead.name} was deleted.`);
        onDeleted();
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) deleteLead.reset();
        onOpenChange(next);
      }}
    >
      {open && lead ? (
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete lead?</DialogTitle>
            <DialogDescription>
              This will permanently delete <span className="font-semibold text-foreground">{lead.name}</span>. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {deleteLead.error ? (
            <p role="alert" className="text-sm text-destructive">
              {getErrorMessage(deleteLead.error, "Failed to delete lead.")}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={deleteLead.isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirm} disabled={deleteLead.isPending}>
              {deleteLead.isPending ? "Deleting..." : "Delete Lead"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
