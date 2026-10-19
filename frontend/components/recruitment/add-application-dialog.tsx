"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useCreateApplicationMutation } from "@/lib/api-client/mutations/recruitment.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

function AddApplicationForm({ jobs, onDone }: { jobs: { id: string; title: string }[]; onDone: () => void }) {
  const create = useCreateApplicationMutation();
  const [jobId, setJobId] = useState(jobs[0]?.id ?? "");
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [resumeUrl, setResumeUrl] = useState("");
  const [notes, setNotes] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        jobId,
        name: name.trim(),
        mobile: mobile.trim(),
        email: email.trim() || undefined,
        resumeUrl: resumeUrl.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Application added.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Add application</DialogTitle>
        <DialogDescription>Enter a candidate by hand.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        {jobs.length > 1 ? (
          <div className="space-y-1.5">
            <Label htmlFor="app-job">Job</Label>
            <NativeSelect id="app-job" value={jobId} onChange={(e) => setJobId(e.target.value)} required>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Job: <span className="font-medium text-foreground">{jobs[0]?.title}</span>
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="app-name">Name</Label>
          <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="app-mobile">Mobile</Label>
          <Input id="app-mobile" type="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="app-email">Email (optional)</Label>
          <Input id="app-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="app-resume">Resume link (optional)</Label>
          <Input id="app-resume" type="url" value={resumeUrl} onChange={(e) => setResumeUrl(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="app-notes">Notes (optional)</Label>
          <Input id="app-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {create.error ? <p className="text-sm text-destructive">{getErrorMessage(create.error, "Failed to add application.")}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !jobId || name.trim().length < 2 || mobile.trim().length < 8}>
            {create.isPending ? "Adding..." : "Add application"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function AddApplicationDialog({
  jobs,
  open,
  onOpenChange,
}: {
  jobs: { id: string; title: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && jobs.length > 0 ? <AddApplicationForm jobs={jobs} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}
