"use client";

import Link from "next/link";
import { Eye, Inbox, Mic } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { CallStatusBadge } from "@/components/calling/call-status-badge";
import { callDetailHref } from "@/components/calling/call-history-table";
import { leadDetailHref } from "@/components/leads/lead-table";
import { formatCallDuration } from "@/lib/call-status";
import type { CallDirection, CallListItem, CallListPagination } from "@/lib/api-client/types/call-history.types";

export function IvrCallTableSkeleton() {
  return (
    <div className="sketch-panel space-y-3 bg-card p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

interface IvrCallTableProps {
  direction: Extract<CallDirection, "INBOUND" | "OUTBOUND">;
  calls: CallListItem[];
  pagination?: CallListPagination;
  onPageChange: (page: number) => void;
}

/** Shared by both IVR Inbound and Outbound pages - same data source (`GET /api/calls`, see
 * call.history.service.ts), different column emphasis per direction (caller-first for inbound,
 * agent-first for outbound), matching the IVR spec's two column lists. Rows link to the existing
 * `/dashboard/calling/[callId]` detail page - there is no separate IVR detail view. */
export function IvrCallTable({ direction, calls, pagination, onPageChange }: IvrCallTableProps) {
  const isInbound = direction === "INBOUND";
  const columnCount = 9;

  return (
    <div className="space-y-4">
      <div className="sketch-panel overflow-x-auto bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date &amp; time</TableHead>
              {isInbound ? (
                <>
                  <TableHead>Caller</TableHead>
                  <TableHead>Lead / Customer</TableHead>
                </>
              ) : (
                <>
                  <TableHead>Agent</TableHead>
                  <TableHead>Customer / Lead</TableHead>
                </>
              )}
              <TableHead>DID</TableHead>
              {isInbound ? <TableHead>Agent</TableHead> : null}
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>{isInbound ? "CallSid" : "campid / CallSid"}</TableHead>
              <TableHead className="text-right pr-4">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columnCount} className="py-14 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Inbox className="size-8 text-muted-foreground/40" />
                    <p className="font-semibold">No {isInbound ? "inbound IVR" : "outbound"} calls found</p>
                    <p className="font-hand text-base text-muted-foreground">Try clearing your filters.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {call.startedAt ? new Date(call.startedAt).toLocaleString() : new Date(call.createdAt).toLocaleString()}
                  </TableCell>
                  {isInbound ? (
                    <>
                      <TableCell className="font-mono text-xs">{call.customerNumber ?? "—"}</TableCell>
                      <TableCell>
                        <Link href={leadDetailHref(call.lead.id)} className="font-semibold hover:underline">
                          {call.lead.firstName} {call.lead.lastName ?? ""}
                        </Link>
                        <div className="font-mono text-xs text-muted-foreground">{call.lead.leadNumber}</div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>{call.agent.name}</TableCell>
                      <TableCell>
                        <Link href={leadDetailHref(call.lead.id)} className="font-semibold hover:underline">
                          {call.lead.firstName} {call.lead.lastName ?? ""}
                        </Link>
                        <div className="font-mono text-xs text-muted-foreground">{call.lead.mobile ?? call.customerNumber ?? "—"}</div>
                      </TableCell>
                    </>
                  )}
                  <TableCell className="font-mono text-xs">{call.virtualNumber?.number ?? "—"}</TableCell>
                  {isInbound ? <TableCell>{call.agent.name}</TableCell> : null}
                  <TableCell>
                    <CallStatusBadge status={call.status} />
                  </TableCell>
                  <TableCell className="tabular-nums">{formatCallDuration(call.durationSeconds)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="flex items-center gap-1.5">
                      {call.providerCallId ?? "—"}
                      {call.hasRecording ? <Mic className="size-3.5 text-muted-foreground" aria-label="Recording available" /> : null}
                    </div>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button variant="outline" size="sm" nativeButton={false} render={<Link href={callDetailHref(call.id)} aria-label="View call" />}>
                      <Eye />
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pagination.totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">
            Page <span className="font-semibold text-foreground">{pagination.page}</span> of {pagination.totalPages} · {pagination.total} calls
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
