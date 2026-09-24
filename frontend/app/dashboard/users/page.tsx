"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus, Users } from "lucide-react";
import { adminSalespersonsQueryOptions, managersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import {
  useCreateManagerMutation,
  useCreateSalespersonMutation,
  useDeactivateManagerMutation,
  useUpdateManagerMutation,
  useUpdateSalespersonMutation,
} from "@/lib/api-client/mutations/admin.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
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
import type { ManagerUser, SalespersonUser } from "@/lib/api-client/types/admin.types";

interface AccountFieldErrors {
  name?: string;
  email?: string;
  password?: string;
  reportingManagerId?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Client-side mirror of the backend's zod rules, so obvious mistakes (short
// password, malformed email) show up instantly under the offending field
// instead of round-tripping to the server and landing in a generic banner
// that gives no clue which field was wrong.
function validateAccountFields(
  fields: { name: string; email: string; password: string; reportingManagerId?: string },
  opts: { requireReportingManager: boolean },
): AccountFieldErrors {
  const errors: AccountFieldErrors = {};
  if (fields.name.trim().length < 2) errors.name = "Name must be at least 2 characters.";
  if (!EMAIL_PATTERN.test(fields.email.trim())) errors.email = "Enter a valid email address.";
  if (fields.password.length < 6) errors.password = "Password must be at least 6 characters.";
  if (opts.requireReportingManager && !fields.reportingManagerId) {
    errors.reportingManagerId = "Select a reporting manager.";
  }
  return errors;
}

function CreateManagerModalContent({ onDone }: { onDone: () => void }) {
  const createManager = useCreateManagerMutation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AccountFieldErrors>({});

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errors = validateAccountFields({ name, email, password }, { requireReportingManager: false });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

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
            onChange={(e) => {
              setName(e.target.value);
              setFieldErrors((prev) => ({ ...prev, name: undefined }));
            }}
            required
            autoFocus
          />
          {fieldErrors.name ? <p className="text-xs text-destructive">{fieldErrors.name}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-email">Email Address</Label>
          <Input
            id="create-email"
            type="email"
            placeholder="sarah.connor@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setFieldErrors((prev) => ({ ...prev, email: undefined }));
            }}
            required
          />
          {fieldErrors.email ? <p className="text-xs text-destructive">{fieldErrors.email}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-password">Password</Label>
          <PasswordInput
            id="create-password"
            placeholder="Enter a secure password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldErrors((prev) => ({ ...prev, password: undefined }));
            }}
            required
            autoComplete="new-password"
          />
          {fieldErrors.password ? <p className="text-xs text-destructive">{fieldErrors.password}</p> : null}
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

function CreateSalespersonModalContent({ managers, onDone }: { managers: ManagerUser[]; onDone: () => void }) {
  const createSalesperson = useCreateSalespersonMutation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [reportingManagerId, setReportingManagerId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AccountFieldErrors>({});

  const activeManagers = managers.filter((m) => m.status === "ACTIVE");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errors = validateAccountFields(
      { name, email, password, reportingManagerId },
      { requireReportingManager: true },
    );
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    createSalesperson.mutate(
      { name, email, password, phone: phone || undefined, reportingManagerId },
      {
        onSuccess: () => {
          toast.success("Salesperson added successfully.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Add New Salesperson</DialogTitle>
        <DialogDescription>
          Create a salesperson account and assign the manager they&apos;ll report to. Only that manager will be able
          to see and add them to a team.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="create-sp-name">Full Name</Label>
          <Input
            id="create-sp-name"
            placeholder="e.g. John Doe"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setFieldErrors((prev) => ({ ...prev, name: undefined }));
            }}
            required
            autoFocus
          />
          {fieldErrors.name ? <p className="text-xs text-destructive">{fieldErrors.name}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-sp-email">Email Address</Label>
          <Input
            id="create-sp-email"
            type="email"
            placeholder="john.doe@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setFieldErrors((prev) => ({ ...prev, email: undefined }));
            }}
            required
          />
          {fieldErrors.email ? <p className="text-xs text-destructive">{fieldErrors.email}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-sp-password">Password</Label>
          <PasswordInput
            id="create-sp-password"
            placeholder="Enter a secure password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldErrors((prev) => ({ ...prev, password: undefined }));
            }}
            required
            autoComplete="new-password"
          />
          {fieldErrors.password ? (
            <p className="text-xs text-destructive">{fieldErrors.password}</p>
          ) : (
            <p className="text-xs text-muted-foreground">At least 6 characters.</p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="create-sp-phone">Phone Number</Label>
            <span className="text-xs text-muted-foreground">Optional</span>
          </div>
          <Input
            id="create-sp-phone"
            type="tel"
            placeholder="+1 (555) 000-0000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-sp-manager">Reporting Manager</Label>
          <NativeSelect
            id="create-sp-manager"
            value={reportingManagerId}
            onChange={(e) => {
              setReportingManagerId(e.target.value);
              setFieldErrors((prev) => ({ ...prev, reportingManagerId: undefined }));
            }}
            required
          >
            <option value="" disabled>
              Select a manager
            </option>
            {activeManagers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.name} ({manager.email})
              </option>
            ))}
          </NativeSelect>
          {fieldErrors.reportingManagerId ? (
            <p className="text-xs text-destructive">{fieldErrors.reportingManagerId}</p>
          ) : activeManagers.length === 0 ? (
            <p className="text-xs text-muted-foreground">Add an active manager first.</p>
          ) : null}
        </div>

        {createSalesperson.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(createSalesperson.error, "Failed to create salesperson.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onDone}
            disabled={createSalesperson.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createSalesperson.isPending || !reportingManagerId}>
            {createSalesperson.isPending ? "Adding Salesperson..." : "Add Salesperson"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function EditSalespersonModalContent({
  salesperson,
  managers,
  onDone,
}: {
  salesperson: SalespersonUser;
  managers: ManagerUser[];
  onDone: () => void;
}) {
  const updateSalesperson = useUpdateSalespersonMutation();
  const [name, setName] = useState(salesperson.name);
  const [phone, setPhone] = useState(salesperson.phone ?? "");
  const [reportingManagerId, setReportingManagerId] = useState(salesperson.reportingManager?.id ?? "");
  const [nameError, setNameError] = useState<string | undefined>();

  const activeManagers = managers.filter(
    (m) => m.status === "ACTIVE" || m.id === salesperson.reportingManager?.id,
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setNameError("Name must be at least 2 characters.");
      return;
    }
    if (!reportingManagerId) return;

    updateSalesperson.mutate(
      { id: salesperson.id, payload: { name, phone: phone || undefined, reportingManagerId } },
      {
        onSuccess: () => {
          toast.success("Salesperson updated successfully.");
          onDone();
        },
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>Edit Salesperson</DialogTitle>
        <DialogDescription>Update profile information and reporting manager for {salesperson.name}.</DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-sp-name-${salesperson.id}`}>Name</Label>
          <Input
            id={`edit-sp-name-${salesperson.id}`}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(undefined);
            }}
            required
            autoFocus
          />
          {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-sp-email-${salesperson.id}`}>Email</Label>
          <Input
            id={`edit-sp-email-${salesperson.id}`}
            value={salesperson.email}
            disabled
            className="bg-muted/50 text-muted-foreground cursor-not-allowed"
          />
          <p className="text-xs text-muted-foreground">Email address cannot be changed.</p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor={`edit-sp-phone-${salesperson.id}`}>Phone</Label>
            <span className="text-xs text-muted-foreground">Optional</span>
          </div>
          <Input
            id={`edit-sp-phone-${salesperson.id}`}
            value={phone}
            placeholder="+1 (555) 000-0000"
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-sp-manager-${salesperson.id}`}>Reporting Manager</Label>
          <NativeSelect
            id={`edit-sp-manager-${salesperson.id}`}
            value={reportingManagerId}
            onChange={(e) => setReportingManagerId(e.target.value)}
            required
          >
            <option value="" disabled>
              Select a manager
            </option>
            {activeManagers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.name} ({manager.email})
              </option>
            ))}
          </NativeSelect>
          {reportingManagerId !== (salesperson.reportingManager?.id ?? "") ? (
            <p className="text-xs text-muted-foreground">
              Reassigning removes this salesperson from their current manager&apos;s team.
            </p>
          ) : null}
        </div>
        {updateSalesperson.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(updateSalesperson.error, "Failed to update salesperson.")}
          </div>
        ) : null}
        <DialogFooter className="pt-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={updateSalesperson.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={updateSalesperson.isPending || !reportingManagerId}>
            {updateSalesperson.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function SalespersonRow({ salesperson, managers }: { salesperson: SalespersonUser; managers: ManagerUser[] }) {
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const updateSalesperson = useUpdateSalespersonMutation();
  const isActive = salesperson.status === "ACTIVE";

  return (
    <>
      <TableRow>
        <TableCell className="pl-5 font-semibold">{salesperson.name}</TableCell>
        <TableCell className="text-muted-foreground">{salesperson.email}</TableCell>
        <TableCell>{salesperson.phone ?? "—"}</TableCell>
        <TableCell>{salesperson.reportingManager?.name ?? "—"}</TableCell>
        <TableCell>
          <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Active" : "Inactive"}</Badge>
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
                disabled={updateSalesperson.isPending}
                onClick={() =>
                  updateSalesperson.mutate(
                    { id: salesperson.id, payload: { status: "INACTIVE" } },
                    { onSuccess: () => toast.success(`${salesperson.name} deactivated`) },
                  )
                }
              >
                {updateSalesperson.isPending ? "Deactivating..." : "Deactivate"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={updateSalesperson.isPending}
                onClick={() =>
                  updateSalesperson.mutate(
                    { id: salesperson.id, payload: { status: "ACTIVE" } },
                    { onSuccess: () => toast.success(`${salesperson.name} reactivated`) },
                  )
                }
              >
                {updateSalesperson.isPending ? "Reactivating..." : "Reactivate"}
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        {isEditDialogOpen ? (
          <EditSalespersonModalContent
            salesperson={salesperson}
            managers={managers}
            onDone={() => setIsEditDialogOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
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
  const { data: salespersons, isPending: isSalespersonsPending, error: salespersonsError } = useQuery(
    adminSalespersonsQueryOptions(),
  );
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isAddSalespersonOpen, setIsAddSalespersonOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Manage manager and salesperson accounts. Salespersons are visible only to the manager they report to."
        actions={
          <>
            <Button variant="outline" onClick={() => setIsAddSalespersonOpen(true)}>
              <UserPlus />
              Add Salesperson
            </Button>
            <Button onClick={() => setIsAddOpen(true)}>
              <UserPlus />
              Add Manager
            </Button>
          </>
        }
      />

      {/* Add Manager Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        {isAddOpen ? (
          <CreateManagerModalContent onDone={() => setIsAddOpen(false)} />
        ) : null}
      </Dialog>

      {/* Add Salesperson Dialog */}
      <Dialog open={isAddSalespersonOpen} onOpenChange={setIsAddSalespersonOpen}>
        {isAddSalespersonOpen ? (
          <CreateSalespersonModalContent managers={managers ?? []} onDone={() => setIsAddSalespersonOpen(false)} />
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

      {/* Salespersons Table Card */}
      <Card>
        <CardHeader>
          <CardTitle>All Salespersons</CardTitle>
          <CardDescription>
            {salespersons
              ? `${salespersons.length} salesperson${salespersons.length === 1 ? "" : "s"} listed`
              : "Loading salespersons..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isSalespersonsPending ? (
            <div className="space-y-3 px-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : salespersonsError ? (
            <div className="sketch-outline mx-5 border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {getErrorMessage(salespersonsError, "Failed to load salespersons.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Reporting Manager</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {salespersons && salespersons.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-14 text-center">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Users className="size-9 text-muted-foreground/40" />
                        <p className="font-heading text-lg font-bold">No salespersons yet</p>
                        <p className="font-hand text-base text-muted-foreground">
                          Add a salesperson and assign the manager they&apos;ll report to.
                        </p>
                        <Button className="mt-3" onClick={() => setIsAddSalespersonOpen(true)}>
                          <UserPlus />
                          Add Salesperson
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  salespersons?.map((salesperson) => (
                    <SalespersonRow key={salesperson.id} salesperson={salesperson} managers={managers ?? []} />
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
