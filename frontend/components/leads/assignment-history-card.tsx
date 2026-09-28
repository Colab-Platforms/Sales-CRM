"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { leadAssignmentsQueryOptions } from "@/lib/api-client/queries/lead.queries";
import { formatDateTime } from "@/lib/order-status";
import type { LeadAssignmentRecord } from "@/lib/api-client/types/lead.types";

const ASSIGNMENT_TYPE_LABELS: Record<LeadAssignmentRecord["assignmentType"], string> = {
  MANUAL: "Manual assignment",
  ROUND_ROBIN: "Round robin",
  REASSIGNMENT: "Reassignment",
};

// Reassignment gets its own color so a salesperson losing a lead (or a manager auditing why a
// lead moved) can spot it in the list at a glance, instead of reading every row's label.
const ASSIGNMENT_TYPE_VARIANT: Record<LeadAssignmentRecord["assignmentType"], string> = {
  MANUAL: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  ROUND_ROBIN: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  REASSIGNMENT: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

function AssignmentRow({ assignment, isLast }: { assignment: LeadAssignmentRecord; isLast: boolean }) {
  return (
    <li className="relative pb-4 pl-6 last:pb-0">
      {!isLast ? <span className="absolute top-2 left-[3px] h-full w-px bg-border" aria-hidden="true" /> : null}
      <span
        className="absolute top-1.5 left-0 size-2 rounded-full bg-primary"
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={ASSIGNMENT_TYPE_VARIANT[assignment.assignmentType]}>
          {ASSIGNMENT_TYPE_LABELS[assignment.assignmentType]}
        </Badge>
        {assignment.isCurrent ? <Badge variant="secondary">Current</Badge> : null}
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-sm font-medium">
        <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {assignment.user.name}
        <span className="text-xs font-normal text-muted-foreground">({assignment.user.role})</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {formatDateTime(assignment.assignedAt)}
        {assignment.assignedBy ? (
          <>
            {" "}
            <ArrowRight className="inline size-3" aria-hidden="true" /> by {assignment.assignedBy.name}
          </>
        ) : (
          " · assigned automatically"
        )}
      </p>
      {assignment.unassignedAt ? (
        <p className="text-xs text-muted-foreground">Unassigned {formatDateTime(assignment.unassignedAt)}</p>
      ) : null}
    </li>
  );
}

export function AssignmentHistoryCard({ leadId, bare = false }: { leadId: string; bare?: boolean }) {
  const { data, isLoading, error } = useQuery(leadAssignmentsQueryOptions(leadId));

  const content = isLoading ? (
    <div className="space-y-3" aria-busy="true" aria-label="Loading assignment history">
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-4 w-48" />
    </div>
  ) : error ? (
    <p className="text-sm text-destructive">Failed to load assignment history.</p>
  ) : !data || data.length === 0 ? (
    <p className="text-sm text-muted-foreground">This lead has never been assigned.</p>
  ) : (
    <ol className="space-y-0">
      {data.map((assignment, index) => (
        <AssignmentRow key={assignment.id} assignment={assignment} isLast={index === data.length - 1} />
      ))}
    </ol>
  );

  if (bare) return content;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assignment history</CardTitle>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
