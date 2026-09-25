"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useUpdateLeadMutation } from "@/lib/api-client/mutations/lead.mutations";
import { leadDetailQueryOptions } from "@/lib/api-client/queries/lead.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import { Skeleton } from "@/components/ui/skeleton";
import { FollowUpTimePicker } from "@/components/follow-ups/follow-up-time-picker";
import { localInputToIso, toLocalInputValue } from "@/components/follow-ups/follow-up-utils";
import { useFollowUpConflict } from "@/components/follow-ups/use-follow-up-conflict";
import type { Lead, LeadPriority } from "@/lib/api-client/types/lead.types";

const PRIORITY_OPTIONS: { value: LeadPriority; label: string }[] = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
];

// Keyed by lead.id from the parent, so React gives this a fresh set of form state whenever the
// dialog opens for a (possibly different) lead, instead of syncing state from a prop via an effect.
function EditLeadForm({ lead, onOpenChange, onDone }: { lead: Lead; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const updateLead = useUpdateLeadMutation();
  const [firstName, setFirstName] = useState(lead.firstName);
  const [lastName, setLastName] = useState(lead.lastName ?? "");
  const [mobile, setMobile] = useState(lead.mobile ?? "");
  const [email, setEmail] = useState(lead.email ?? "");
  const [requirement, setRequirement] = useState(lead.requirement ?? "");
  const [location, setLocation] = useState(lead.location ?? "");
  const [priority, setPriority] = useState<LeadPriority>(lead.priority);
  const [workingStatus, setWorkingStatus] = useState(lead.workingStatus);
  const existing = lead.tasks[0];
  const existingValue = existing ? toLocalInputValue(new Date(existing.scheduledAt)) : "";
  const isFollowUpStatus = workingStatus === "CALL_BACK" || workingStatus === "FOLLOW_UP";
  const statusChanged = workingStatus !== lead.workingStatus;
  // A lead already on call back / follow up starts from the time that's set now, so it can be moved.
  const [followUpAt, setFollowUpAt] = useState(lead.workingStatus === "CALL_BACK" || lead.workingStatus === "FOLLOW_UP" ? existingValue : "");
  // Switching to call back / follow up needs a reminder time (the backend rejects it otherwise).
  const needsFollowUpTime = isFollowUpStatus && statusChanged;
  const showFollowUpPicker = isFollowUpStatus && (statusChanged || Boolean(existing));
  const followUpIso = localInputToIso(followUpAt);
  // Only send a time when it's needed or actually changed - re-saving other fields leaves the reminder alone.
  const sendFollowUp = showFollowUpPicker && Boolean(followUpIso) && (statusChanged || followUpAt !== existingValue);
  const { conflict: timeTaken } = useFollowUpConflict(lead.id, sendFollowUp ? followUpAt : "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateLead.mutate(
      {
        id: lead.id,
        payload: {
          firstName,
          lastName: lastName || undefined,
          mobile: mobile || undefined,
          email: email || undefined,
          requirement: requirement || undefined,
          location: location || undefined,
          priority,
          workingStatus,
          followUpAt: sendFollowUp ? followUpIso : undefined,
        },
      },
      {
        onSuccess: () => {
          toast.success("Lead updated successfully.");
          onDone();
        },
        onError: (err) => toast.error(getErrorMessage(err, "Failed to update lead.")),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-first-name">First Name</Label>
          <Input id="edit-lead-first-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-last-name">Last Name</Label>
          <Input id="edit-lead-last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-mobile">Mobile</Label>
          <Input id="edit-lead-mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-email">Email</Label>
          <Input id="edit-lead-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-requirement">Requirement</Label>
          <Input id="edit-lead-requirement" value={requirement} onChange={(e) => setRequirement(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-location">Location</Label>
          <Input id="edit-lead-location" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-status">Status</Label>
          <NativeSelect id="edit-lead-status" value={workingStatus} onChange={(e) => setWorkingStatus(e.target.value as typeof workingStatus)}>
            {/* ASSIGNED is set by assigning a lead; only offered while the lead already has it (never for a salesperson). */}
            {STATUS_ORDER.filter((status) => status !== "ASSIGNED" || lead.workingStatus === "ASSIGNED").map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-lead-priority">Priority</Label>
          <NativeSelect id="edit-lead-priority" value={priority} onChange={(e) => setPriority(e.target.value as LeadPriority)}>
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {showFollowUpPicker ? (
        <FollowUpTimePicker
          id="edit-lead-follow-up-at"
          leadId={lead.id}
          current={existing}
          label={`${needsFollowUpTime ? "When should you" : "Reschedule your"} ${workingStatus === "CALL_BACK" ? "call back" : "follow up"}${needsFollowUpTime ? "?" : ""}`}
          value={followUpAt}
          onChange={setFollowUpAt}
          disabled={updateLead.isPending}
        />
      ) : null}

      {updateLead.error ? <p className="text-sm text-destructive">{getErrorMessage(updateLead.error, "Failed to update lead.")}</p> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={updateLead.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={updateLead.isPending || !firstName || (!mobile && !email) || (needsFollowUpTime && !followUpIso) || (sendFollowUp && Boolean(timeTaken))}>
          {updateLead.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// Same editable fields the existing PATCH /lead/leads/:id already supports (see lead.validators.ts
// updateLeadSchema) - this dialog adds no new field the backend can't already accept.
export function EditLeadDialog({
  leadId,
  open,
  onOpenChange,
  onDone,
}: {
  leadId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { data: lead, isLoading, error: loadError } = useQuery({
    ...leadDetailQueryOptions(leadId ?? ""),
    enabled: open && Boolean(leadId),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Edit Lead</DialogTitle>
            <DialogDescription>Update this lead&apos;s details.</DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="space-y-3 py-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : loadError || !lead ? (
            <p className="text-sm text-destructive">{getErrorMessage(loadError, "Failed to load this lead.")}</p>
          ) : (
            <EditLeadForm key={lead.id} lead={lead} onOpenChange={onOpenChange} onDone={onDone} />
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
