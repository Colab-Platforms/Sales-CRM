"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Search, UserPlus, Users } from "lucide-react";
import { recruitersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import {
  useCreateRecruiterMutation,
  useResetRecruiterPasswordMutation,
  useUpdateRecruiterMutation,
} from "@/lib/api-client/mutations/admin.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import type { RecruiterUser } from "@/lib/api-client/types/admin.types";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/i;

function CreateRecruiterDialogContent({ onDone }: { onDone: () => void }) {
  const createRecruiter = useCreateRecruiterMutation();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError("Name must be at least 2 characters.");
    if (!USERNAME_PATTERN.test(username.trim())) return setError("Use 3-50 letters, numbers, dots, underscores or hyphens for the username.");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    setError(null);
    createRecruiter.mutate(
      { name: name.trim(), username: username.trim(), password, phone: phone.trim() },
      {
        onSuccess: () => {
          toast.success("Recruiter added.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Add recruiter</DialogTitle>
        <DialogDescription>Recruiters call the applicants assigned to them. Their phone number is used to connect calls.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="recruiter-name">Full name</Label>
          <Input id="recruiter-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recruiter-username">Username</Label>
          <Input id="recruiter-username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recruiter-password">Password</Label>
          <PasswordInput
            id="recruiter-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recruiter-phone">Phone number</Label>
          <Input id="recruiter-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
        {error || createRecruiter.error ? (
          <p className="text-sm text-destructive">{error ?? getErrorMessage(createRecruiter.error, "Failed to add recruiter.")}</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={createRecruiter.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={createRecruiter.isPending}>
            {createRecruiter.isPending ? "Adding..." : "Add recruiter"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ResetPasswordDialogContent({ recruiter, onDone }: { recruiter: RecruiterUser; onDone: () => void }) {
  const reset = useResetRecruiterPasswordMutation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setError(null);
    reset.mutate(
      { id: recruiter.id, payload: { password } },
      {
        onSuccess: () => {
          toast.success("Password updated.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>Change password</DialogTitle>
        <DialogDescription>Set a new password for {recruiter.name}.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="recruiter-new-password">New password</Label>
          <PasswordInput id="recruiter-new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="new-password" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recruiter-confirm-password">Confirm password</Label>
          <PasswordInput id="recruiter-confirm-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        </div>
        {error || reset.error ? <p className="text-sm text-destructive">{error ?? getErrorMessage(reset.error, "Failed to update password.")}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={reset.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={reset.isPending}>
            {reset.isPending ? "Updating..." : "Update password"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function RecruiterRow({ recruiter }: { recruiter: RecruiterUser }) {
  const [passwordOpen, setPasswordOpen] = useState(false);
  const update = useUpdateRecruiterMutation();
  const isActive = recruiter.status === "ACTIVE";

  return (
    <>
      <TableRow>
        <TableCell className="pl-5 font-semibold">{recruiter.name}</TableCell>
        <TableCell className="text-muted-foreground">{recruiter.username}</TableCell>
        <TableCell>{recruiter.phone ?? "—"}</TableCell>
        <TableCell>
          <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Active" : "Inactive"}</Badge>
        </TableCell>
        <TableCell className="pr-5 text-right">
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setPasswordOpen(true)}>
              <KeyRound />
              Change password
            </Button>
            <Button
              size="sm"
              variant={isActive ? "destructive" : "outline"}
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: recruiter.id, payload: { status: isActive ? "INACTIVE" : "ACTIVE" } },
                  { onSuccess: () => toast.success(`${recruiter.name} ${isActive ? "deactivated" : "reactivated"}`) },
                )
              }
            >
              {isActive ? "Deactivate" : "Reactivate"}
            </Button>
          </div>
        </TableCell>
      </TableRow>
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        {passwordOpen ? <ResetPasswordDialogContent recruiter={recruiter} onDone={() => setPasswordOpen(false)} /> : null}
      </Dialog>
    </>
  );
}

export default function RecruitersPage() {
  const { data: recruiters, isPending, error } = useQuery(recruitersQueryOptions());
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");

  const term = search.trim().toLowerCase();
  const filtered = recruiters?.filter(
    (r) => !term || r.name.toLowerCase().includes(term) || r.username.toLowerCase().includes(term) || (r.phone ?? "").includes(term),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recruiters"
        description="Recruiters call the job applicants you assign to them."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <UserPlus />
            Add recruiter
          </Button>
        }
      />

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        {addOpen ? <CreateRecruiterDialogContent onDone={() => setAddOpen(false)} /> : null}
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>All recruiters</CardTitle>
          <CardDescription>
            {recruiters ? `${recruiters.length} recruiter${recruiters.length === 1 ? "" : "s"} listed` : "Loading recruiters…"}
          </CardDescription>
          <div className="relative mt-3 max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search recruiters"
              placeholder="Search by name, username or phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {isPending ? (
            <div className="space-y-3 px-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <div className="sketch-outline mx-5 border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {getErrorMessage(error, "Failed to load recruiters.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Name</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recruiters?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-14 text-center">
                      <div className="flex flex-col items-center gap-2">
                        <Users className="size-9 text-muted-foreground/40" />
                        <p className="font-heading text-lg font-bold">No recruiters yet</p>
                        <Button className="mt-2" onClick={() => setAddOpen(true)}>
                          <UserPlus />
                          Add recruiter
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : filtered?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      No recruiters match &ldquo;{search.trim()}&rdquo;.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered?.map((r) => <RecruiterRow key={r.id} recruiter={r} />)
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
