"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, UserPlus } from "lucide-react";
import { groupsQueryOptions, mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { useCreateMembershipRequestMutation } from "@/lib/api-client/mutations/membership-requests.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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
import type { Group } from "@/lib/api-client/types/manager.types";

function RequestAddSalespersonModalContent({ group, onDone }: { group: Group; onDone: () => void }) {
  const createRequest = useCreateMembershipRequestMutation();
  const { data: salespersons, isPending, error: loadError } = useQuery(mySalespersonsQueryOptions());
  const [salespersonId, setSalespersonId] = useState("");
  const [note, setNote] = useState("");

  const currentMemberIds = new Set(group.members.filter((m) => m.isActive).map((m) => m.userId));
  const options = (salespersons ?? []).filter((sp) => sp.status === "ACTIVE" && !currentMemberIds.has(sp.id));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createRequest.mutate(
      { groupId: group.id, salespersonId, note: note.trim() || undefined },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>Request to Add Salesperson</DialogTitle>
        <DialogDescription>
          Send Admin/HR a request to add a salesperson to {group.name}. They&apos;ll review it before anything
          changes.
        </DialogDescription>
      </DialogHeader>

      {isPending ? (
        <Skeleton className="h-16" />
      ) : loadError ? (
        <p className="text-sm text-destructive">{getErrorMessage(loadError, "Failed to load salespersons.")}</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`request-sp-${group.id}`}>Salesperson</Label>
            <NativeSelect
              id={`request-sp-${group.id}`}
              value={salespersonId}
              onChange={(e) => setSalespersonId(e.target.value)}
              required
            >
              <option value="" disabled>
                Select a salesperson
              </option>
              {options.map((sp) => (
                <option key={sp.id} value={sp.id}>
                  {sp.name} ({sp.username}){sp.groupName ? ` — currently in ${sp.groupName}` : ""}
                </option>
              ))}
            </NativeSelect>
            {options.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Everyone reporting to you is already in this group.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor={`request-note-${group.id}`}>Note</Label>
              <span className="text-xs text-muted-foreground">Optional</span>
            </div>
            <textarea
              id={`request-note-${group.id}`}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why should this salesperson join this team?"
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>

          {createRequest.error ? (
            <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {getErrorMessage(createRequest.error, "Failed to submit request.")}
            </div>
          ) : null}

          <DialogFooter className="gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onDone} disabled={createRequest.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={createRequest.isPending || !salespersonId}>
              {createRequest.isPending ? "Submitting..." : "Submit Request"}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  );
}

function GroupCard({ group }: { group: Group }) {
  const activeMembers = group.members.filter((m) => m.isActive);
  const isActive = group.status === "ACTIVE";
  const [isRequestOpen, setIsRequestOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <CardTitle>{group.name}</CardTitle>
          {group.description ? <p className="text-sm text-muted-foreground">{group.description}</p> : null}
          <p className="font-hand text-sm text-muted-foreground">
            {activeMembers.length} salesperson{activeMembers.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={isActive ? "default" : "secondary"}>{group.status}</Badge>
          {isActive ? (
            <Button size="sm" variant="outline" onClick={() => setIsRequestOpen(true)}>
              <UserPlus />
              Request to add salesperson
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="sketch-outline overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Salesperson</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeMembers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    No salespeople in this group yet.
                  </TableCell>
                </TableRow>
              ) : (
                activeMembers.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <div className="font-medium">{member.user.name}</div>
                      <div className="text-xs text-muted-foreground">{member.user.username}</div>
                    </TableCell>
                    <TableCell>{member.user.phone ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={member.user.status === "ACTIVE" ? "default" : "secondary"}>
                        {member.user.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <Dialog open={isRequestOpen} onOpenChange={setIsRequestOpen}>
        {isRequestOpen ? (
          <RequestAddSalespersonModalContent group={group} onDone={() => setIsRequestOpen(false)} />
        ) : null}
      </Dialog>
    </Card>
  );
}

export default function TeamPage() {
  const { data: groups, isPending, error } = useQuery(groupsQueryOptions());

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Your groups and the salespeople on them. Team and salesperson changes are managed by Admin/HR."
      />

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
            <p className="font-hand text-base text-muted-foreground">
              Ask Admin or HR to set up a group for your team.
            </p>
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
