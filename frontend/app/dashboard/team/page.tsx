"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { groupsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import {
  useAddExistingSalespersonMutation,
  useAddSalespersonMutation,
  useCreateGroupMutation,
  useDeleteGroupMutation,
  useRemoveSalespersonMutation,
  useUpdateGroupMutation,
  useUpdateSalespersonMutation,
} from "@/lib/api-client/mutations/manager.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { Group, GroupMember } from "@/lib/api-client/types/manager.types";

function CreateGroupForm() {
  const createGroup = useCreateGroupMutation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createGroup.mutate(
      { name, description: description || undefined },
      { onSuccess: () => { setName(""); setDescription(""); } },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create group</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Group name</Label>
            <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-description">Description (optional)</Label>
            <Input id="group-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {createGroup.error ? (
            <p className="text-sm text-destructive sm:col-span-2">
              {getErrorMessage(createGroup.error, "Failed to create group.")}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={createGroup.isPending}>
              {createGroup.isPending ? "Creating..." : "Create group"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
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
        <Input
          id={`sp-password-${groupId}`}
          type="password"
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

function AddExistingSalespersonForm({ groupId, onDone }: { groupId: string; onDone: () => void }) {
  const addExisting = useAddExistingSalespersonMutation();
  const [userId, setUserId] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    addExisting.mutate({ groupId, payload: { userId } }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <div className="space-y-1.5">
        <Label htmlFor={`existing-userid-${groupId}`}>Existing salesperson user ID</Label>
        <Input
          id={`existing-userid-${groupId}`}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="Paste user ID"
          required
        />
      </div>
      {addExisting.error ? (
        <p className="w-full text-sm text-destructive">
          {getErrorMessage(addExisting.error, "Failed to add salesperson.")}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={addExisting.isPending}>
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
          <AddExistingSalespersonForm groupId={group.id} onDone={() => setAddingExisting(false)} />
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">Create groups and add salespeople to your team.</p>
      </div>

      <CreateGroupForm />

      {isPending ? (
        <Skeleton className="h-40" />
      ) : error ? (
        <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load groups.")}</p>
      ) : groups && groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No groups yet. Create one above.</p>
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
