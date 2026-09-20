"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Contact, Search, UserPlus, Users2 } from "lucide-react";
import { groupsQueryOptions, mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { useRemoveSalespersonMutation, useUpdateSalespersonMutation } from "@/lib/api-client/mutations/manager.mutations";
import { CreateSalespersonModal } from "@/components/team/create-salesperson-modal";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { MySalesperson } from "@/lib/api-client/types/manager.types";

function EditSalespersonRow({ salesperson, onDone }: { salesperson: MySalesperson; onDone: () => void }) {
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

function SalespersonRow({ salesperson }: { salesperson: MySalesperson }) {
  const [editing, setEditing] = useState(false);
  const removeSalesperson = useRemoveSalespersonMutation();

  if (editing) {
    return <EditSalespersonRow salesperson={salesperson} onDone={() => setEditing(false)} />;
  }

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{salesperson.name}</div>
        <div className="text-xs text-muted-foreground">{salesperson.email}</div>
      </TableCell>
      <TableCell>{salesperson.phone ?? "—"}</TableCell>
      <TableCell>
        <Badge variant="outline">{salesperson.groupName}</Badge>
      </TableCell>
      <TableCell>
        <Badge variant={salesperson.status === "ACTIVE" ? "default" : "secondary"}>{salesperson.status}</Badge>
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
            onClick={() => removeSalesperson.mutate({ groupId: salesperson.groupId, userId: salesperson.id })}
          >
            Remove
          </Button>
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
        sp.groupName.toLowerCase().includes(q),
    );
  }, [salespersons, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Salespersons</h1>
          <p className="text-sm text-muted-foreground">Everyone you&apos;ve added across your teams, in one place.</p>
        </div>
        <Button onClick={() => setIsAddOpen(true)} className="gap-2 sm:self-center">
          <UserPlus className="size-4" />
          Add Salesperson
        </Button>
      </div>

      {salespersons && salespersons.length > 0 ? (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or group..."
            className="pl-9"
          />
        </div>
      ) : null}

      {isPending ? (
        <Skeleton className="h-40" />
      ) : error ? (
        <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load salespersons.")}</p>
      ) : (salespersons?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
            <Users2 className="size-8 text-muted-foreground/50" />
            <p className="font-medium text-foreground">No salespeople yet</p>
            <p className="text-sm text-muted-foreground">Add your first salesperson to get started.</p>
            <Button size="sm" className="mt-2 gap-1.5" onClick={() => setIsAddOpen(true)}>
              <UserPlus className="size-3.5" />
              Add Salesperson
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10">
            <Contact className="size-8 text-muted-foreground/50" />
            <p className="font-medium text-foreground">No matches</p>
            <p className="text-sm text-muted-foreground">Try a different search term.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((sp) => (
                  <SalespersonRow key={sp.id} salesperson={sp} />
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
