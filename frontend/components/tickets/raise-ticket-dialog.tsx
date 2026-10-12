"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateTicketMutation } from "@/lib/api-client/mutations/tickets.mutations";
import { TICKET_CATEGORY_LABELS, TICKET_DESCRIPTION_MAX, TICKET_PRIORITY_LABELS, TICKET_SUBJECT_MAX, validateTicketForm } from "@/lib/ticket-status";
import type { TicketCategory, TicketPriority } from "@/lib/api-client/types/tickets.types";

const EMPTY = { category: "OTHER" as TicketCategory, priority: "MEDIUM" as TicketPriority, subject: "", description: "" };

export function RaiseTicketDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<{ subject?: string; description?: string }>({});
  const create = useCreateTicketMutation();

  function close(next: boolean) {
    if (!next) {
      if (create.isPending) return;
      setValues(EMPTY);
      setErrors({});
    }
    onOpenChange(next);
  }

  function submit() {
    const found = validateTicketForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(
      { ...values, subject: values.subject.trim(), description: values.description.trim() },
      {
        onSuccess: (t) => {
          toast.success(`Ticket #${t.ticketNumber} raised. Your manager has been notified.`);
          close(false);
        },
        onError: (e) => toast.error(getErrorMessage(e, "Could not raise the ticket.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Raise a ticket</DialogTitle>
          <DialogDescription>Facing a problem or difficulty? Tell us what happened and your manager will pick it up.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label htmlFor="ticket-category" className="text-sm font-medium">
                Category
              </label>
              <NativeSelect id="ticket-category" value={values.category} onChange={(e) => setValues({ ...values, category: e.target.value as TicketCategory })}>
                {(Object.keys(TICKET_CATEGORY_LABELS) as TicketCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {TICKET_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="ticket-priority" className="text-sm font-medium">
                Priority
              </label>
              <NativeSelect id="ticket-priority" value={values.priority} onChange={(e) => setValues({ ...values, priority: e.target.value as TicketPriority })}>
                {(Object.keys(TICKET_PRIORITY_LABELS) as TicketPriority[]).map((p) => (
                  <option key={p} value={p}>
                    {TICKET_PRIORITY_LABELS[p]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="ticket-subject" className="text-sm font-medium">
              Subject
            </label>
            <Input id="ticket-subject" maxLength={TICKET_SUBJECT_MAX} placeholder="e.g. Cannot place order for a lead" value={values.subject} onChange={(e) => setValues({ ...values, subject: e.target.value })} aria-invalid={Boolean(errors.subject)} />
            {errors.subject ? (
              <p role="alert" className="text-xs text-destructive">
                {errors.subject}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="ticket-description" className="text-sm font-medium">
              What is the problem?
            </label>
            <textarea
              id="ticket-description"
              rows={5}
              maxLength={TICKET_DESCRIPTION_MAX}
              placeholder="What were you doing, what did you expect, and what happened instead? Mention the lead or order number if relevant."
              value={values.description}
              onChange={(e) => setValues({ ...values, description: e.target.value })}
              aria-invalid={Boolean(errors.description)}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            {errors.description ? (
              <p role="alert" className="text-xs text-destructive">
                {errors.description}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Submitting…" : "Raise ticket"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
