"use client";

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { membershipRequestsQueryOptions } from "@/lib/api-client/queries/membership-requests.queries";
import {
  useApproveMembershipRequestMutation,
  useRejectMembershipRequestMutation,
} from "@/lib/api-client/mutations/membership-requests.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
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
import type { MembershipRequestStatusFilter, MembershipRequestView } from "@/lib/api-client/types/membership-requests.types";

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusVariant(status: MembershipRequestView["status"]): "default" | "secondary" | "destructive" {
  if (status === "APPROVED") return "default";
  if (status === "REJECTED") return "destructive";
  return "secondary";
}

function RejectModalContent({
  request,
  isPending,
  error,
  onSubmit,
  onDone,
}: {
  request: MembershipRequestView;
  isPending: boolean;
  error: unknown;
  onSubmit: (note: string) => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      setNoteError("A reason is required.");
      return;
    }
    onSubmit(note.trim());
  }

  return (
    <DialogContent className="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>Reject Request</DialogTitle>
        <DialogDescription>
          Reject adding {request.salesperson.name} to {request.group.name}. Let {request.requestedBy.name} know why.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="reject-note">Reason</Label>
          <textarea
            id="reject-note"
            rows={3}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteError(undefined);
            }}
            placeholder="e.g. This salesperson is already fully allocated to another team."
            autoFocus
            required
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {noteError ? <p className="text-xs text-destructive">{noteError}</p> : null}
        </div>
        {error ? (
          <div className="sketch-outline border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {getErrorMessage(error, "Failed to reject request.")}
          </div>
        ) : null}
        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onDone} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={isPending}>
            {isPending ? "Rejecting..." : "Reject"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function RequestRow({ request }: { request: MembershipRequestView }) {
  const approve = useApproveMembershipRequestMutation();
  const reject = useRejectMembershipRequestMutation();
  const [isRejectOpen, setIsRejectOpen] = useState(false);
  const isPending = request.status === "PENDING";

  return (
    <>
      <TableRow>
        <TableCell className="pl-5">
          <div className="font-semibold">{request.salesperson.name}</div>
          <div className="text-xs text-muted-foreground">{request.salesperson.username}</div>
        </TableCell>
        <TableCell>{request.group.name}</TableCell>
        <TableCell>{request.requestedBy.name}</TableCell>
        <TableCell className="max-w-64 truncate text-sm text-muted-foreground" title={request.requestNote ?? undefined}>
          {request.requestNote ?? "—"}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">{formatWhen(request.createdAt)}</TableCell>
        <TableCell>
          <Badge variant={statusVariant(request.status)}>{request.status}</Badge>
          {request.status !== "PENDING" && request.decisionNote ? (
            <p className="mt-1 max-w-56 truncate text-xs text-muted-foreground" title={request.decisionNote}>
              {request.decisionNote}
            </p>
          ) : null}
        </TableCell>
        <TableCell className="pr-5 text-right">
          {isPending ? (
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                disabled={approve.isPending}
                onClick={() => approve.mutate({ id: request.id })}
              >
                {approve.isPending ? "Approving..." : "Approve"}
              </Button>
              <Button size="sm" variant="destructive" disabled={reject.isPending} onClick={() => setIsRejectOpen(true)}>
                Reject
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              {request.decidedBy ? `Decided by ${request.decidedBy.name}` : "—"}
            </span>
          )}
        </TableCell>
      </TableRow>
      {approve.error ? (
        <TableRow>
          <TableCell colSpan={7} className="pb-3 text-sm text-destructive">
            {getErrorMessage(approve.error, "Failed to approve request.")}
          </TableCell>
        </TableRow>
      ) : null}

      <Dialog open={isRejectOpen} onOpenChange={setIsRejectOpen}>
        {isRejectOpen ? (
          <RejectModalContent
            request={request}
            isPending={reject.isPending}
            error={reject.error}
            onSubmit={(note) => reject.mutate({ id: request.id, note }, { onSuccess: () => setIsRejectOpen(false) })}
            onDone={() => setIsRejectOpen(false)}
          />
        ) : null}
      </Dialog>
    </>
  );
}

export default function ApprovalsPage() {
  const [status, setStatus] = useState<MembershipRequestStatusFilter>("PENDING");
  const { data: requests, isPending, error } = useQuery(membershipRequestsQueryOptions(status));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Manager requests to add a salesperson to one of their teams."
        actions={
          <NativeSelect
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as MembershipRequestStatusFilter)}
            wrapperClassName="w-40"
          >
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="ALL">All</option>
          </NativeSelect>
        }
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
            <ClipboardCheck className="size-9 text-muted-foreground/40" />
            <p className="font-heading text-lg font-bold">Nothing here</p>
            <p className="font-hand text-base text-muted-foreground">
              {status === "PENDING" ? "No requests are waiting on a decision." : "No requests match this filter."}
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
                  <TableHead>Requested by</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((request) => (
                  <RequestRow key={request.id} request={request} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
