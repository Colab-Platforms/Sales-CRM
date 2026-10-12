"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderPlus, KeyRound, LayoutGrid, UserPlus } from "lucide-react";
import {
  adminGroupsQueryOptions,
  adminSalespersonsQueryOptions,
  managersQueryOptions,
} from "@/lib/api-client/queries/admin.queries";
import {
  useAddExistingSalespersonToGroupMutation,
  useAddSalespersonToGroupMutation,
  useCreateAdminGroupMutation,
  useCreateManagerMutation,
  useCreateSalespersonMutation,
  useDeleteAdminGroupMutation,
  useRemoveSalespersonFromGroupMutation,
  useResetSalespersonPasswordMutation,
  useUpdateAdminGroupMutation,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { Group, GroupMember, ManagerUser } from "@/lib/api-client/types/admin.types";

interface AccountFieldErrors {
  name?: string;
  username?: string;
  password?: string;
  reportingManagerId?: string;
}

const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/i;

function validateAccountFields(
  fields: { name: string; username: string; password: string; reportingManagerId?: string },
  opts: { requireReportingManager: boolean },
): AccountFieldErrors {
  const errors: AccountFieldErrors = {};
  if (fields.name.trim().length < 2) errors.name = "Name must be at least 2 characters.";
  if (!USERNAME_PATTERN.test(fields.username.trim())) errors.username = "Use 3-50 letters, numbers, dots, underscores or hyphens.";
  if (fields.password.length < 6) errors.password = "Password must be at least 6 characters.";
  if (opts.requireReportingManager && !fields.reportingManagerId) {
    errors.reportingManagerId = "Select a reporting manager.";
  }
  return errors;
}

function CreateManagerModalContent({ onDone }: { onDone: () => void }) {
  const createManager = useCreateManagerMutation();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AccountFieldErrors>({});

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errors = validateAccountFields({ name, username, password }, { requireReportingManager: false });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    createManager.mutate(
      { name, username, password, phone },
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
          <Label htmlFor="create-mgr-name">Full Name</Label>
          <Input
            id="create-mgr-name"
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
          <Label htmlFor="create-mgr-username">Username</Label>
          <Input
            id="create-mgr-username"
            type="text"
            placeholder="sarah.connor_avatar"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setFieldErrors((prev) => ({ ...prev, username: undefined }));
            }}
            required
          />
          {fieldErrors.username ? <p className="text-xs text-destructive">{fieldErrors.username}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="create-mgr-password">Password</Label>
          <PasswordInput
            id="create-mgr-password"
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
          <Label htmlFor="create-mgr-phone">Phone Number</Label>
          <Input
            id="create-mgr-phone"
            type="tel"
            required
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
          <Button type="button" variant="outline" onClick={onDone} disabled={createManager.isPending}>
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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [reportingManagerId, setReportingManagerId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AccountFieldErrors>({});

  const activeManagers = managers.filter((m) => m.status === "ACTIVE");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errors = validateAccountFields(
      { name, username, password, reportingManagerId },
      { requireReportingManager: true },
    );
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    createSalesperson.mutate(
      { name, username, password, phone, reportingManagerId },
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
          <Label htmlFor="create-sp-username">Username</Label>
          <Input
            id="create-sp-username"
            type="text"
            placeholder="john.doe@company.com"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setFieldErrors((prev) => ({ ...prev, username: undefined }));
            }}
            required
          />
          {fieldErrors.username ? <p className="text-xs text-destructive">{fieldErrors.username}</p> : null}
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
          <Label htmlFor="create-sp-phone">Phone Number</Label>
          <Input
            id="create-sp-phone"
            type="tel"
            required
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
                {manager.name} ({manager.username})
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
          <Button type="button" variant="outline" onClick={onDone} disabled={createSalesperson.isPending}>
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

function CreateGroupModalContent({ managers, onDone }: { managers: ManagerUser[]; onDone: () => void }) {
  const createGroup = useCreateAdminGroupMutation();
  const activeManagers = managers.filter((m) => m.status === "ACTIVE");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [managerId, setManagerId] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createGroup.mutate(
      { name, description: description || undefined, managerId },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Create Group</DialogTitle>
        <DialogDescription>Create a new team and assign the manager who will own it.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="group-name">Group Name</Label>
          <Input
            id="group-name"
            placeholder="e.g. North Region Sales"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="group-description">Description</Label>
            <span className="text-xs text-muted-foreground">Optional</span>
          </div>
          <Input
            id="group-description"
            placeholder="e.g. Handles inbound leads for the north region"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="group-manager">Manager</Label>
          <NativeSelect
            id="group-manager"
            value={managerId}
            onChange={(e) => setManagerId(e.target.value)}
            required
          >
            <option value="" disabled>
              Select a manager
            </option>
            {activeManagers.map((manager) => (
              <option key={manager.id} value={manager.id}>
                {manager.name} ({manager.username})
              </option>
            ))}
          </NativeSelect>
          {activeManagers.length === 0 ? (
            <p className="text-xs text-muted-foreground">Add an active manager first.</p>
          ) : null}
        </div>

        {createGroup.error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(createGroup.error, "Failed to create group.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={createGroup.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={createGroup.isPending || !managerId}>
            {createGroup.isPending ? "Creating..." : "Create Group"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function EditGroupForm({ group, onDone }: { group: Group; onDone: () => void }) {
  const updateGroup = useUpdateAdminGroupMutation();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [status, setStatus] = useState(group.status);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateGroup.mutate(
      { groupId: group.id, payload: { name, description: description || undefined, status: status as "ACTIVE" | "INACTIVE" } },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label htmlFor={`group-edit-name-${group.id}`}>Group name</Label>
        <Input id={`group-edit-name-${group.id}`} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`group-edit-description-${group.id}`}>Description</Label>
        <Input
          id={`group-edit-description-${group.id}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`group-edit-status-${group.id}`}>Status</Label>
        <NativeSelect id={`group-edit-status-${group.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </NativeSelect>
      </div>
      {updateGroup.error ? (
        <p className="text-sm text-destructive sm:col-span-3">
          {getErrorMessage(updateGroup.error, "Failed to update group.")}
        </p>
      ) : null}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm" disabled={updateGroup.isPending}>
          {updateGroup.isPending ? "Saving..." : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddSalespersonForm({ groupId, onDone }: { groupId: string; onDone: () => void }) {
  const addSalesperson = useAddSalespersonToGroupMutation();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    addSalesperson.mutate({ groupId, payload: { name, username, password, phone } }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={handleSubmit} className="sketch-dashed grid gap-4 bg-muted/30 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1.5">
        <Label htmlFor={`sp-name-${groupId}`}>Name</Label>
        <Input id={`sp-name-${groupId}`} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`sp-username-${groupId}`}>Username</Label>
        <Input
          id={`sp-username-${groupId}`}
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`sp-password-${groupId}`}>Password</Label>
        <PasswordInput
          id={`sp-password-${groupId}`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`sp-phone-${groupId}`}>Phone</Label>
        <Input id={`sp-phone-${groupId}`} required value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      {addSalesperson.error ? (
        <p className="text-sm text-destructive sm:col-span-2 lg:col-span-4">
          {getErrorMessage(addSalesperson.error, "Failed to add salesperson.")}
        </p>
      ) : null}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit" size="sm" disabled={addSalesperson.isPending}>
          {addSalesperson.isPending ? "Adding..." : "Add"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddExistingSalespersonForm({
  groupId,
  currentMemberIds,
  onDone,
}: {
  groupId: string;
  currentMemberIds: string[];
  onDone: () => void;
}) {
  const addExisting = useAddExistingSalespersonToGroupMutation();
  const { data: salespersons, isPending, error } = useQuery(adminSalespersonsQueryOptions());
  const [userId, setUserId] = useState("");

  const options = (salespersons ?? []).filter((sp) => !currentMemberIds.includes(sp.id));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    addExisting.mutate({ groupId, payload: { userId } }, { onSuccess: onDone });
  }

  if (isPending) {
    return <Skeleton className="h-16" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load salespersons.")}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="sketch-dashed flex flex-wrap items-end gap-3 bg-muted/30 p-4">
      <div className="min-w-64 flex-1 space-y-1.5">
        <Label htmlFor={`existing-userid-${groupId}`}>Existing salesperson</Label>
        <NativeSelect id={`existing-userid-${groupId}`} value={userId} onChange={(e) => setUserId(e.target.value)} required>
          <option value="" disabled>
            Select a salesperson
          </option>
          {options.map((sp) => (
            <option key={sp.id} value={sp.id}>
              {sp.name} ({sp.username}){sp.reportingManager ? ` — reports to ${sp.reportingManager.name}` : ""}
            </option>
          ))}
        </NativeSelect>
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">No other salespersons available to add.</p>
        ) : null}
      </div>
      {addExisting.error ? (
        <p className="w-full text-sm text-destructive">
          {getErrorMessage(addExisting.error, "Failed to add salesperson.")}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={addExisting.isPending || !userId}>
        {addExisting.isPending ? "Adding..." : "Add"}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

interface PasswordFieldErrors {
  password?: string;
  confirmPassword?: string;
}

function ChangePasswordModalContent({
  memberName,
  isPending,
  error,
  onSubmit,
  onDone,
}: {
  memberName: string;
  isPending: boolean;
  error: unknown;
  onSubmit: (password: string, onSuccess: () => void) => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<PasswordFieldErrors>({});

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errors: PasswordFieldErrors = {};
    if (password.length < 6) errors.password = "Password must be at least 6 characters.";
    if (password !== confirmPassword) errors.confirmPassword = "Passwords do not match.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    onSubmit(password, onDone);
  }

  return (
    <DialogContent className="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>Change Password</DialogTitle>
        <DialogDescription>Set a new password for {memberName}.</DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="member-password-new">New Password</Label>
          <PasswordInput
            id="member-password-new"
            placeholder="Enter a new password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldErrors((prev) => ({ ...prev, password: undefined }));
            }}
            required
            autoFocus
            autoComplete="new-password"
          />
          {fieldErrors.password ? (
            <p className="text-xs text-destructive">{fieldErrors.password}</p>
          ) : (
            <p className="text-xs text-muted-foreground">At least 6 characters.</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="member-password-confirm">Confirm Password</Label>
          <PasswordInput
            id="member-password-confirm"
            placeholder="Re-enter the new password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setFieldErrors((prev) => ({ ...prev, confirmPassword: undefined }));
            }}
            required
            autoComplete="new-password"
          />
          {fieldErrors.confirmPassword ? <p className="text-xs text-destructive">{fieldErrors.confirmPassword}</p> : null}
        </div>

        {error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(error, "Failed to update password.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Updating..." : "Update Password"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function EditMemberRow({ member, onDone }: { member: GroupMember; onDone: () => void }) {
  const updateSalesperson = useUpdateSalespersonMutation();
  const [name, setName] = useState(member.user.name);
  const [phone, setPhone] = useState(member.user.phone ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateSalesperson.mutate(
      { id: member.userId, payload: { name, phone: phone || undefined } },
      { onSuccess: onDone },
    );
  }

  return (
    <TableRow>
      <TableCell colSpan={4}>
        <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor={`member-name-${member.id}`}>Name</Label>
            <Input id={`member-name-${member.id}`} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`member-phone-${member.id}`}>Phone</Label>
            <Input id={`member-phone-${member.id}`} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          {updateSalesperson.error ? (
            <p className="text-sm text-destructive sm:col-span-2 lg:col-span-4">
              {getErrorMessage(updateSalesperson.error, "Failed to update salesperson.")}
            </p>
          ) : null}
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm" disabled={updateSalesperson.isPending}>
              {updateSalesperson.isPending ? "Saving..." : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      </TableCell>
    </TableRow>
  );
}

function MemberRow({ groupId, member }: { groupId: string; member: GroupMember }) {
  const [editing, setEditing] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const removeSalesperson = useRemoveSalespersonFromGroupMutation();
  const resetPassword = useResetSalespersonPasswordMutation();

  if (editing) {
    return <EditMemberRow member={member} onDone={() => setEditing(false)} />;
  }

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="font-medium">{member.user.name}</div>
          <div className="text-xs text-muted-foreground">{member.user.username}</div>
        </TableCell>
        <TableCell>{member.user.phone ?? "—"}</TableCell>
        <TableCell>
          <Badge variant={member.user.status === "ACTIVE" ? "default" : "secondary"}>{member.user.status}</Badge>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setIsPasswordDialogOpen(true)}>
              <KeyRound />
              Change Password
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={removeSalesperson.isPending}
              onClick={() => removeSalesperson.mutate({ groupId, userId: member.userId })}
            >
              Remove
            </Button>
          </div>
        </TableCell>
      </TableRow>

      <Dialog open={isPasswordDialogOpen} onOpenChange={setIsPasswordDialogOpen}>
        {isPasswordDialogOpen ? (
          <ChangePasswordModalContent
            memberName={member.user.name}
            isPending={resetPassword.isPending}
            error={resetPassword.error}
            onSubmit={(password, onSuccess) =>
              resetPassword.mutate({ id: member.userId, payload: { password } }, { onSuccess })
            }
            onDone={() => setIsPasswordDialogOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function GroupCard({ group }: { group: Group }) {
  const activeMembers = group.members.filter((m) => m.isActive);
  const deleteGroup = useDeleteAdminGroupMutation();
  const [editingGroup, setEditingGroup] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [addingExisting, setAddingExisting] = useState(false);

  const isActive = group.status === "ACTIVE";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
        {editingGroup ? (
          <div className="flex-1">
            <EditGroupForm group={group} onDone={() => setEditingGroup(false)} />
          </div>
        ) : (
          <>
            <div className="min-w-0 space-y-1">
              <CardTitle>{group.name}</CardTitle>
              {group.description ? <p className="text-sm text-muted-foreground">{group.description}</p> : null}
              <p className="font-hand text-sm text-muted-foreground">
                Managed by {group.manager.name} · {activeMembers.length} salesperson
                {activeMembers.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={isActive ? "default" : "secondary"}>{group.status}</Badge>
              <Button size="sm" variant="outline" onClick={() => setEditingGroup(true)}>
                Edit
              </Button>
              {isActive ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleteGroup.isPending}
                  onClick={() => deleteGroup.mutate(group.id)}
                >
                  Deactivate
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setEditingGroup(true)}>
                  Reactivate
                </Button>
              )}
            </div>
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="sketch-outline overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Salesperson</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeMembers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No salespeople in this group yet.
                  </TableCell>
                </TableRow>
              ) : (
                activeMembers.map((member) => <MemberRow key={member.id} groupId={group.id} member={member} />)
              )}
            </TableBody>
          </Table>
        </div>

        {addingNew ? (
          <AddSalespersonForm groupId={group.id} onDone={() => setAddingNew(false)} />
        ) : addingExisting ? (
          <AddExistingSalespersonForm
            groupId={group.id}
            currentMemberIds={activeMembers.map((m) => m.userId)}
            onDone={() => setAddingExisting(false)}
          />
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setAddingNew(true)}>
              Add salesperson
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAddingExisting(true)}>
              Add existing salesperson
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function GroupsPage() {
  const { data: groups, isPending, error } = useQuery(adminGroupsQueryOptions());
  const { data: managers } = useQuery(managersQueryOptions());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAddManagerOpen, setIsAddManagerOpen] = useState(false);
  const [isAddSalespersonOpen, setIsAddSalespersonOpen] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Teams"
        description="Create teams, assign a manager, and manage who's on each team."
        actions={
          <>
            <Button variant="outline" onClick={() => setIsAddSalespersonOpen(true)}>
              <UserPlus />
              Add Salesperson
            </Button>
            <Button variant="outline" onClick={() => setIsAddManagerOpen(true)}>
              <UserPlus />
              Add Manager
            </Button>
            <Button onClick={() => setIsCreateOpen(true)}>
              <FolderPlus />
              Create Group
            </Button>
          </>
        }
      />

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        {isCreateOpen ? (
          <CreateGroupModalContent managers={managers ?? []} onDone={() => setIsCreateOpen(false)} />
        ) : null}
      </Dialog>

      <Dialog open={isAddManagerOpen} onOpenChange={setIsAddManagerOpen}>
        {isAddManagerOpen ? <CreateManagerModalContent onDone={() => setIsAddManagerOpen(false)} /> : null}
      </Dialog>

      <Dialog open={isAddSalespersonOpen} onOpenChange={setIsAddSalespersonOpen}>
        {isAddSalespersonOpen ? (
          <CreateSalespersonModalContent managers={managers ?? []} onDone={() => setIsAddSalespersonOpen(false)} />
        ) : null}
      </Dialog>

      {isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load groups.")}
        </div>
      ) : groups && groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14">
            <LayoutGrid className="size-9 text-muted-foreground/40" />
            <p className="font-heading text-lg font-bold">No groups yet</p>
            <p className="font-hand text-base text-muted-foreground">Get started by creating your first team.</p>
            <Button className="mt-3" onClick={() => setIsCreateOpen(true)}>
              <FolderPlus />
              Create Group
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups?.map((group) => (
            <GroupCard key={group.id} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}
