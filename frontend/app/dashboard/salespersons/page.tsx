"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Contact, Search, UserPlus, Users2 } from "lucide-react";
import { groupsQueryOptions, mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import {
  useAddExistingSalespersonMutation,
  useRemoveSalespersonMutation,
  useUpdateSalespersonMutation,
} from "@/lib/api-client/mutations/manager.mutations";
import { CreateSalespersonModal } from "@/components/team/create-salesperson-modal";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { Group, MySalesperson } from "@/lib/api-client/types/manager.types";

function EditSalespersonRow({
  salesperson,
  onDone,
}: {
  salesperson: MySalesperson & { groupId: string };
  onDone: () => void;
}) {
  const updateSalesperson = useUpdateSalespersonMutation();
  const [name, setName] = useState(salesperson.name);
  const [phone, setPhone] = useState(salesperson.phone ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateSalesperson.mutate(
      { groupId: salesperson.groupId, userId: salesperson.id, payload: { name, phone: phone || undefined } },
      { onSuccess: onDone },
    );
  }

  return (
    <TableRow>
      <TableCell colSpan={5}>
        <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor={`edit-sp-name-${salesperson.id}`}>Name</Label>
            <Input id={`edit-sp-name-${salesperson.id}`} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`edit-sp-phone-${salesperson.id}`}>Phone</Label>
            <Input id={`edit-sp-phone-${salesperson.id}`} value={phone} onChange={(e) => setPhone(e.target.value)} />
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

function AddToTeamRow({
  salesperson,
  groups,
  onDone,
}: {
  salesperson: MySalesperson;
  groups: Group[];
  onDone: () => void;
}) {
  const addExisting = useAddExistingSalespersonMutation();
  const activeGroups = groups.filter((g) => g.status === "ACTIVE");
  const [groupId, setGroupId] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    addExisting.mutate({ groupId, payload: { userId: salesperson.id } }, { onSuccess: onDone });
  }

  return (
    <TableRow>
      <TableCell colSpan={5}>
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 space-y-1.5">
            <Label htmlFor={`add-team-${salesperson.id}`}>Add {salesperson.name} to which group?</Label>
            <NativeSelect
              id={`add-team-${salesperson.id}`}
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              required
            >
              <option value="" disabled>
                Select a group
              </option>
              {activeGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {addExisting.error ? (
            <p className="w-full text-sm text-destructive">
              {getErrorMessage(addExisting.error, "Failed to add to group.")}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={addExisting.isPending || !groupId}>
            {addExisting.isPending ? "Adding..." : "Add"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </form>
      </TableCell>
    </TableRow>
  );
}

function SalespersonRow({ salesperson, groups }: { salesperson: MySalesperson; groups: Group[] }) {
  const [editing, setEditing] = useState(false);
  const [addingToTeam, setAddingToTeam] = useState(false);
  const removeSalesperson = useRemoveSalespersonMutation();

  if (editing && salesperson.groupId) {
    return (
      <EditSalespersonRow
        salesperson={salesperson as MySalesperson & { groupId: string }}
        onDone={() => setEditing(false)}
      />
    );
  }

  if (addingToTeam) {
    return <AddToTeamRow salesperson={salesperson} groups={groups} onDone={() => setAddingToTeam(false)} />;
  }

  return (
    <TableRow>
      <TableCell className="pl-5">
        <div className="font-semibold">{salesperson.name}</div>
        <div className="text-xs text-muted-foreground">{salesperson.email}</div>
      </TableCell>
      <TableCell>{salesperson.phone ?? "—"}</TableCell>
      <TableCell>
        {salesperson.groupName ? (
          <Badge variant="outline">{salesperson.groupName}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Not in a team yet</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={salesperson.status === "ACTIVE" ? "default" : "secondary"}>
          {salesperson.status === "ACTIVE" ? "Active" : "Inactive"}
        </Badge>
      </TableCell>
      <TableCell className="pr-5 text-right">
        <div className="flex justify-end gap-2">
          {salesperson.groupId ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={removeSalesperson.isPending}
                onClick={() => removeSalesperson.mutate({ groupId: salesperson.groupId as string, userId: salesperson.id })}
              >
                Remove
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAddingToTeam(true)}>
              Add to a team
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function SalespersonsPage() {
  const { data: salespersons, isPending, error } = useQuery(mySalespersonsQueryOptions());
  const { data: groups } = useQuery(groupsQueryOptions());
  const [search, setSearch] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);

  const filtered = useMemo(() => {
    const list = salespersons ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (sp) =>
        sp.name.toLowerCase().includes(q) ||
        sp.email.toLowerCase().includes(q) ||
        (sp.groupName ?? "").toLowerCase().includes(q),
    );
  }, [salespersons, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Salespersons"
        description="Everyone reporting to you — added by you or assigned by admin — in one place."
        actions={
          <Button onClick={() => setIsAddOpen(true)}>
            <UserPlus />
            Add Salesperson
          </Button>
        }
      />

      {salespersons && salespersons.length > 0 ? (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or group..."
            className="pl-9.5"
          />
        </div>
      ) : null}

      {isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load salespersons.")}
        </div>
      ) : (salespersons?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14">
            <Users2 className="size-9 text-muted-foreground/40" />
            <p className="font-heading text-lg font-bold">No salespeople yet</p>
            <p className="font-hand text-base text-muted-foreground">
              Add your first salesperson to get started.
            </p>
            <Button className="mt-3" onClick={() => setIsAddOpen(true)}>
              <UserPlus />
              Add Salesperson
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14">
            <Contact className="size-9 text-muted-foreground/40" />
            <p className="font-heading text-lg font-bold">No matches</p>
            <p className="font-hand text-base text-muted-foreground">Try a different search term.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Salesperson</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((sp) => (
                  <SalespersonRow key={sp.id} salesperson={sp} groups={groups ?? []} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        {isAddOpen ? <CreateSalespersonModal groups={groups ?? []} onDone={() => setIsAddOpen(false)} /> : null}
      </Dialog>
    </div>
  );
}
