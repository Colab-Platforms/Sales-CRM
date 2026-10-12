"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutGrid } from "lucide-react";
import { groupsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { Group } from "@/lib/api-client/types/manager.types";

function GroupCard({ group }: { group: Group }) {
  const activeMembers = group.members.filter((m) => m.isActive);
  const isActive = group.status === "ACTIVE";

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
        <Badge variant={isActive ? "default" : "secondary"}>{group.status}</Badge>
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
