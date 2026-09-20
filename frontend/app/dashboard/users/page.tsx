"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus, Users } from "lucide-react";
import { managersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import {
  useCreateManagerMutation,
  useDeactivateManagerMutation,
  useUpdateManagerMutation,
} from "@/lib/api-client/mutations/admin.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { ManagerUser } from "@/lib/api-client/types/admin.types";

function CreateManagerModalContent({ onDone }: { onDone: () => void }) {
  const createManager = useCreateManagerMutation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createManager.mutate(
      { name, email, password, phone: phone || undefined },
      {
        onSuccess: () => {
          toast.success("Manager added successfully.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Add New Manager</DialogTitle>
        <DialogDescription>
          Create a new manager account. They will be granted permissions to oversee sales teams and reps.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="create-name">Full Name</Label>
          <Input
            id="create-name"
            placeholder="e.g. Sarah Connor"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-email">Email Address</Label>
          <Input
            id="create-email"
            type="email"
            placeholder="sarah.connor@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-password">Password</Label>
          <PasswordInput
            id="create-password"
            placeholder="Enter a secure password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="create-phone">Phone Number</Label>
            <span className="text-xs text-muted-foreground">Optional</span>
          </div>
          <Input
            id="create-phone"
            type="tel"
            placeholder="+1 (555) 000-0000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        {createManager.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(createManager.error, "Failed to create manager.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onDone}
            disabled={createManager.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createManager.isPending}>
            {createManager.isPending ? "Adding Manager..." : "Add Manager"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function EditManagerModalContent({
  manager,
  onDone,
}: {
  manager: ManagerUser;
  onDone: () => void;
}) {
  const updateManager = useUpdateManagerMutation();
  const [name, setName] = useState(manager.name);
  const [phone, setPhone] = useState(manager.phone ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateManager.mutate(
      { id: manager.id, payload: { name, phone: phone || undefined } },
      {
        onSuccess: () => {
          toast.success("Manager updated successfully");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>Edit Manager</DialogTitle>
        <DialogDescription>
          Update profile information for {manager.name}.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-name-${manager.id}`}>Name</Label>
          <Input
            id={`edit-name-${manager.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-email-${manager.id}`}>Email</Label>
          <Input
            id={`edit-email-${manager.id}`}
            value={manager.email}
            disabled
            className="bg-muted/50 text-muted-foreground cursor-not-allowed"
          />
          <p className="text-xs text-muted-foreground">Email address cannot be changed.</p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor={`edit-phone-${manager.id}`}>Phone</Label>
            <span className="text-xs text-muted-foreground">Optional</span>
          </div>
          <Input
            id={`edit-phone-${manager.id}`}
            value={phone}
            placeholder="+1 (555) 000-0000"
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        {updateManager.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(updateManager.error, "Failed to update manager.")}
          </div>
        ) : null}
        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onDone}
            disabled={updateManager.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateManager.isPending}>
            {updateManager.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ManagerRow({ manager }: { manager: ManagerUser }) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const deactivateManager = useDeactivateManagerMutation();
  const updateManager = useUpdateManagerMutation();

  const isActive = manager.status === "ACTIVE";

  return (
    <>
      <TableRow>
        <TableCell className="pl-5 font-semibold">{manager.name}</TableCell>
        <TableCell className="text-muted-foreground">{manager.email}</TableCell>
        <TableCell>{manager.phone ?? "—"}</TableCell>
        <TableCell>
          <Badge variant={isActive ? "default" : "secondary"}>
            {isActive ? "Active" : "Inactive"}
          </Badge>
        </TableCell>
        <TableCell className="pr-5 text-right">
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setIsEditDialogOpen(true)}>
              Edit
            </Button>
            {isActive ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={deactivateManager.isPending}
                onClick={() =>
                  deactivateManager.mutate(manager.id, {
                    onSuccess: () => toast.success(`${manager.name} deactivated`),
                  })
                }
              >
                {deactivateManager.isPending ? "Deactivating..." : "Deactivate"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={updateManager.isPending}
                onClick={() =>
                  updateManager.mutate(
                    { id: manager.id, payload: { status: "ACTIVE" } },
                    {
                      onSuccess: () => toast.success(`${manager.name} reactivated`),
                    },
                  )
                }
              >
                {updateManager.isPending ? "Reactivating..." : "Reactivate"}
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        {isEditDialogOpen ? (
          <EditManagerModalContent
            manager={manager}
            onDone={() => setIsEditDialogOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

export default function UsersPage() {
  const { data: managers, isPending, error } = useQuery(managersQueryOptions());
  const [isAddOpen, setIsAddOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Managers"
        description="Manage manager accounts, monitor active statuses, and configure team permissions."
        actions={
          <Button onClick={() => setIsAddOpen(true)}>
            <UserPlus />
            Add Manager
          </Button>
        }
      />

      {/* Add Manager Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        {isAddOpen ? (
          <CreateManagerModalContent onDone={() => setIsAddOpen(false)} />
        ) : null}
      </Dialog>

      {/* Managers Table Card */}
      <Card>
        <CardHeader>
          <CardTitle>All Managers</CardTitle>
          <CardDescription>
            {managers
              ? `${managers.length} manager${managers.length === 1 ? "" : "s"} listed`
              : "Loading managers..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isPending ? (
            <div className="space-y-3 px-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <div className="sketch-outline mx-5 border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {getErrorMessage(error, "Failed to load managers.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {managers && managers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-14 text-center">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Users className="size-9 text-muted-foreground/40" />
                        <p className="font-heading text-lg font-bold">No managers yet</p>
                        <p className="font-hand text-base text-muted-foreground">
                          Get started by adding your first manager to the platform.
                        </p>
                        <Button className="mt-3" onClick={() => setIsAddOpen(true)}>
                          <UserPlus />
                          Add Manager
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  managers?.map((manager) => <ManagerRow key={manager.id} manager={manager} />)
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
