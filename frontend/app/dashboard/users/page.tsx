"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { managersQueryOptions } from "@/lib/api-client/queries/admin.queries";
import {
  useCreateManagerMutation,
  useDeactivateManagerMutation,
  useUpdateManagerMutation,
} from "@/lib/api-client/mutations/admin.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { ManagerUser } from "@/lib/api-client/types/admin.types";

function EditManagerRow({ manager, onDone }: { manager: ManagerUser; onDone: () => void }) {
  const updateManager = useUpdateManagerMutation();
  const [name, setName] = useState(manager.name);
  const [phone, setPhone] = useState(manager.phone ?? "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    updateManager.mutate(
      { id: manager.id, payload: { name, phone: phone || undefined } },
      { onSuccess: onDone },
    );
  }

  return (
    <TableRow>
      <TableCell colSpan={5}>
        <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor={`edit-name-${manager.id}`}>Name</Label>
            <Input id={`edit-name-${manager.id}`} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`edit-phone-${manager.id}`}>Phone</Label>
            <Input id={`edit-phone-${manager.id}`} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          {updateManager.error ? (
            <p className="text-sm text-destructive sm:col-span-2 lg:col-span-4">
              {getErrorMessage(updateManager.error, "Failed to update manager.")}
            </p>
          ) : null}
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" size="sm" disabled={updateManager.isPending}>
              {updateManager.isPending ? "Saving..." : "Save"}
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

function ManagerRow({ manager }: { manager: ManagerUser }) {
  const [editing, setEditing] = useState(false);
  const deactivateManager = useDeactivateManagerMutation();
  const updateManager = useUpdateManagerMutation();

  if (editing) {
    return <EditManagerRow manager={manager} onDone={() => setEditing(false)} />;
  }

  const isActive = manager.status === "ACTIVE";

  return (
    <TableRow>
      <TableCell className="font-medium">{manager.name}</TableCell>
      <TableCell>{manager.email}</TableCell>
      <TableCell>{manager.phone ?? "—"}</TableCell>
      <TableCell>
        <Badge variant={isActive ? "default" : "secondary"}>{manager.status}</Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Edit
          </Button>
          {isActive ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={deactivateManager.isPending}
              onClick={() => deactivateManager.mutate(manager.id)}
            >
              Deactivate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={updateManager.isPending}
              onClick={() => updateManager.mutate({ id: manager.id, payload: { status: "ACTIVE" } })}
            >
              Reactivate
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function UsersPage() {
  const { data: managers, isPending, error } = useQuery(managersQueryOptions());
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
          setName("");
          setEmail("");
          setPassword("");
          setPhone("");
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Managers</h1>
        <p className="text-sm text-muted-foreground">Add managers and see who&apos;s onboard.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add manager</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone (optional)</Label>
              <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            {createManager.error ? (
              <p className="text-sm text-destructive sm:col-span-2 lg:col-span-4">
                {getErrorMessage(createManager.error, "Failed to create manager.")}
              </p>
            ) : null}
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit" disabled={createManager.isPending}>
                {createManager.isPending ? "Adding..." : "Add manager"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All managers</CardTitle>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Skeleton className="h-32" />
          ) : error ? (
            <p className="text-sm text-destructive">{getErrorMessage(error, "Failed to load managers.")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {managers && managers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No managers yet.
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
