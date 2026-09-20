"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderPlus, UserPlus, LayoutGrid } from "lucide-react";
import { groupsQueryOptions, salespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import {
  useAddExistingSalespersonMutation,
  useAddSalespersonMutation,
  useCreateGroupMutation,
  useDeleteGroupMutation,
  useRemoveSalespersonMutation,
  useUpdateGroupMutation,
  useUpdateSalespersonMutation,
} from "@/lib/api-client/mutations/manager.mutations";
import { CreateSalespersonModal } from "@/components/team/create-salesperson-modal";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import type { Group, GroupMember } from "@/lib/api-client/types/manager.types";

function CreateGroupModalContent({ onDone }: { onDone: () => void }) {
  const createGroup = useCreateGroupMutation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createGroup.mutate(
      { name, description: description || undefined },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Create Group</DialogTitle>
        <DialogDescription>
          Create a new team group. You can add salespeople to it once it&apos;s created.
        </DialogDescription>
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

        {createGroup.error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2.5 text-sm text-destructive">
            {getErrorMessage(createGroup.error, "Failed to create group.")}
          </div>
        ) : null}

        <DialogFooter className="gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onDone}
            disabled={createGroup.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createGroup.isPending}>
            {createGroup.isPending ? "Creating..." : "Create Group"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function EditGroupForm({ group, onDone }: { group: Group; onDone: () => void }) {
  const updateGroup = useUpdateGroupMutation();
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
        <Input
          id={`group-edit-name-${group.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
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
        <select
          id={`group-edit-status-${group.id}`}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs"
        >
          <option value="ACTIVE">ACTIVE</option>
          <option value="INACTIVE">INACTIVE</option>
        </select>
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
  const addSalesperson = useAddSalespersonMutation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    addSalesperson.mutate(
      { groupId, payload: { name, email, password, phone: phone || undefined } },
      { onSuccess: onDone },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1.5">
        <Label htmlFor={`sp-name-${groupId}`}>Name</Label>
        <Input id={`sp-name-${groupId}`} value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`sp-email-${groupId}`}>Email</Label>
        <Input
          id={`sp-email-${groupId}`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
        <Label htmlFor={`sp-phone-${groupId}`}>Phone (optional)</Label>
        <Input id={`sp-phone-${groupId}`} value={phone} onChange={(e) => setPhone(e.target.value)} />
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
  const addExisting = useAddExistingSalespersonMutation();
  const { data: salespersons, isPending, error } = useQuery(salespersonsQueryOptions());
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
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <div className="min-w-64 space-y-1.5">
        <Label htmlFor={`existing-userid-${groupId}`}>Existing salesperson</Label>
        <select
          id={`existing-userid-${groupId}`}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs"
          required
        >
          <option value="" disabled>
            Select a salesperson
          </option>
          {options.map((sp) => (
            <option key={sp.id} value={sp.id}>
              {sp.name} ({sp.email}){sp.currentGroup ? ` — currently in ${sp.currentGroup.name}` : ""}
            </option>
          ))}
        </select>
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

function EditMemberRow({ groupId, member, onDone }: { groupId: string; member: GroupMember; onDone: () => void }) {
  const updateSalesperson = useUpdateSalespersonMutation();
  const [name, setName] = useState(member.user.name);
  const [phone, setPhone] = useState(member.user.phone ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateSalesperson.mutate(
      { groupId, userId: member.userId, payload: { name, phone: phone || undefined } },
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
  const removeSalesperson = useRemoveSalespersonMutation();

  if (editing) {
    return <EditMemberRow groupId={groupId} member={member} onDone={() => setEditing(false)} />;
  }

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{member.user.name}</div>
        <div className="text-xs text-muted-foreground">{member.user.email}</div>
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
  );
}

function GroupCard({ group }: { group: Group }) {
  const activeMembers = group.members.filter((m) => m.isActive);
  const deleteGroup = useDeleteGroupMutation();
  const [editingGroup, setEditingGroup] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [addingExisting, setAddingExisting] = useState(false);

  const isActive = group.status === "ACTIVE";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        {editingGroup ? (
          <div className="flex-1">
            <EditGroupForm group={group} onDone={() => setEditingGroup(false)} />
          </div>
        ) : (
          <>
            <div>
              <CardTitle>{group.name}</CardTitle>
              {group.description ? <p className="text-sm text-muted-foreground">{group.description}</p> : null}
            </div>
            <div className="flex items-center gap-2">
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

export default function TeamPage() {
  const { data: groups, isPending, error } = useQuery(groupsQueryOptions());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAddSalespersonOpen, setIsAddSalespersonOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground">Create groups and add salespeople to your team.</p>
        </div>
        <div className="flex flex-wrap gap-2 sm:self-center">
          <Button variant="outline" onClick={() => setIsAddSalespersonOpen(true)} className="gap-2">
            <UserPlus className="size-4" />
            Add Salesperson
          </Button>
          <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
            <FolderPlus className="size-4" />
            Create Group
          </Button>
        </div>
      </div>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        {isCreateOpen ? <CreateGroupModalContent onDone={() => setIsCreateOpen(false)} /> : null}
      </Dialog>

      <Dialog open={isAddSalespersonOpen} onOpenChange={setIsAddSalespersonOpen}>
        {isAddSalespersonOpen ? (
          <CreateSalespersonModal groups={groups ?? []} onDone={() => setIsAddSalespersonOpen(false)} />
        ) : null}
      </Dialog>

      {isPending ? (
        <Skeleton className="h-40" />
      ) : error ? (
        <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load groups.")}</p>
      ) : groups && groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
            <LayoutGrid className="size-8 text-muted-foreground/50" />
            <p className="font-medium text-foreground">No groups yet</p>
            <p className="text-sm text-muted-foreground">Get started by creating your first team group.</p>
            <Button size="sm" className="mt-2 gap-1.5" onClick={() => setIsCreateOpen(true)}>
              <FolderPlus className="size-3.5" />
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
