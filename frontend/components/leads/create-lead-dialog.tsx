"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useCreateLeadMutation } from "@/lib/api-client/mutations/lead.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateLeadDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const createLead = useCreateLeadMutation();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [requirement, setRequirement] = useState("");

  function reset() {
    setFirstName("");
    setLastName("");
    setMobile("");
    setEmail("");
    setRequirement("");
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createLead.mutate(
      {
        firstName,
        lastName: lastName || undefined,
        mobile: mobile || undefined,
        email: email || undefined,
        requirement: requirement || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Lead created successfully.");
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
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>New Lead</DialogTitle>
            <DialogDescription>Add a lead manually to the central lead system.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lead-first-name">First Name</Label>
                <Input id="lead-first-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-last-name">Last Name</Label>
                <Input id="lead-last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="lead-mobile">Mobile</Label>
                <Input id="lead-mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-email">Email</Label>
                <Input id="lead-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-requirement">Requirement</Label>
              <Input id="lead-requirement" value={requirement} onChange={(e) => setRequirement(e.target.value)} />
            </div>
            {createLead.error ? (
              <p className="text-sm text-destructive">{getErrorMessage(createLead.error, "Failed to create lead.")}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={createLead.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={createLead.isPending || !firstName || (!mobile && !email)}>
                {createLead.isPending ? "Creating..." : "Create Lead"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
