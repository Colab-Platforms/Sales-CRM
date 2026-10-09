"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import { membershipRequestsQueryOptions } from "@/lib/api-client/queries/membership-requests.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { MembershipRequestView } from "@/lib/api-client/types/membership-requests.types";

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusVariant(status: MembershipRequestView["status"]): "default" | "secondary" | "destructive" {
  if (status === "APPROVED") return "default";
  if (status === "REJECTED") return "destructive";
  return "secondary";
}

export default function RequestsPage() {
  const { data: requests, isPending, error } = useQuery(membershipRequestsQueryOptions("ALL"));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Requests"
        description="Your requests to add a salesperson to one of your teams, and whether Admin/HR approved them."
      />

      {isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load requests.")}
        </div>
      ) : !requests || requests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-14">
            <ClipboardList className="size-9 text-muted-foreground/40" />
            <p className="font-heading text-lg font-bold">No requests yet</p>
            <p className="font-hand text-base text-muted-foreground">
              Requests to add a salesperson to one of your teams will show up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Salesperson</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5">Decision note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="pl-5">
                      <div className="font-semibold">{request.salesperson.name}</div>
                      <div className="text-xs text-muted-foreground">{request.salesperson.username}</div>
                    </TableCell>
                    <TableCell>{request.group.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatWhen(request.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(request.status)}>{request.status}</Badge>
                    </TableCell>
                    <TableCell className="pr-5 text-sm text-muted-foreground">
                      {request.decisionNote ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
