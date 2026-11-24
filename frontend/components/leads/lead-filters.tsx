"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { segmentsQueryOptions } from "@/lib/api-client/queries/segment.queries";
import { CUSTOMER_CLASS_LABELS } from "@/components/leads/lead-tags";
import type { Segment } from "@/lib/api-client/types/segment.types";
import type { CustomerClass } from "@/lib/api-client/types/lead.types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Search, X } from "lucide-react";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import type { AssignmentFilter, LeadListParams } from "@/lib/api-client/types/lead.types";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";

export type LeadFilterState = Omit<LeadListParams, "page" | "limit">;

const ASSIGNMENT_LABELS: Record<AssignmentFilter, string> = {
  UNASSIGNED: "Unassigned",
  ASSIGNED_TO_MANAGER: "Assigned to manager",
  ASSIGNED_TO_SALESPERSON: "Assigned to salesperson",
};

const ASSIGNMENT_OPTIONS: AssignmentFilter[] = [
  "UNASSIGNED",
  "ASSIGNED_TO_MANAGER",
  "ASSIGNED_TO_SALESPERSON",
];

const CLASS_OPTIONS: CustomerClass[] = ["REPEAT", "LOYAL", "VIP"];

/** The campaign-segment and customer-classification filters: independent of each other (a VIP customer in "Diwali Mega Sale" matches both). Counts are shown when the caller may see them. */
export function SegmentClassFilters({ value, onChange, segments }: { value: LeadFilterState; onChange: (value: LeadFilterState) => void; segments: Segment[] }) {
  return (
    <>
      <div className="w-full space-y-2 sm:w-56">
        <Label htmlFor="lead-segment-filter" className="text-xs text-muted-foreground">
          Campaign segment
        </Label>
        <NativeSelect id="lead-segment-filter" value={value.segmentId ?? ""} onChange={(e) => onChange({ ...value, segmentId: e.target.value || undefined })}>
          <option value="">All segments</option>
          {segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.counts ? ` (${s.counts.total.toLocaleString("en-IN")})` : ""}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="w-full space-y-2 sm:w-44">
        <Label htmlFor="lead-class-filter" className="text-xs text-muted-foreground">
          Customer type
        </Label>
        <NativeSelect id="lead-class-filter" value={value.customerClass ?? ""} onChange={(e) => onChange({ ...value, customerClass: (e.target.value || undefined) as CustomerClass | undefined })}>
          <option value="">All customers</option>
          {CLASS_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {CUSTOMER_CLASS_LABELS[c]}
            </option>
          ))}
        </NativeSelect>
      </div>
    </>
  );
}

export function LeadFilters({
  value,
  onChange,
  role,
}: {
  value: LeadFilterState;
  onChange: (value: LeadFilterState) => void;
  role: Role;
}) {
  const [search, setSearch] = useState(value.search ?? "");

  // admins and managers see per-segment totals; a salesperson only needs the names
  const { data: segments } = useQuery(segmentsQueryOptions({ counts: role !== "SALESPERSON" }));
  const hasFilters = Boolean(value.segmentId || value.customerClass || value.search || value.workingStatus || value.assignment || value.bucket || value.aiAgent || value.aiAgentIntent);

  function submitSearch() {
    onChange({ ...value, search: search || undefined });
  }

  function clearAll() {
    setSearch("");
    onChange({});
  }

  return (
    <div className="sketch-outline flex flex-wrap items-end gap-4 bg-card/60 p-4">
      <div className="min-w-60 flex-1 space-y-2">
        <Label htmlFor="lead-search" className="text-xs text-muted-foreground">
          Search
        </Label>
        <div className="flex gap-2">
          <Input
            id="lead-search"
            placeholder="Name, phone, email or lead number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
            }}
          />
          <Button variant="outline" size="icon" onClick={submitSearch} type="button" aria-label="Search leads">
            <Search />
          </Button>
        </div>
      </div>

      <div className="w-full space-y-2 sm:w-48">
        <Label htmlFor="lead-status-filter" className="text-xs text-muted-foreground">
          Status
        </Label>
        <NativeSelect
          id="lead-status-filter"
          value={value.workingStatus ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              workingStatus: (e.target.value || undefined) as LeadWorkingStatus | undefined,
            })
          }
        >
          <option value="">All statuses</option>
          {STATUS_ORDER.filter((status) => role !== "SALESPERSON" || status !== "ASSIGNED").map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <SegmentClassFilters value={value} onChange={onChange} segments={segments ?? []} />

      {role !== "SALESPERSON" ? (
        <div className="w-full space-y-2 sm:w-56">
          <Label htmlFor="lead-assignment-filter" className="text-xs text-muted-foreground">
            Assignment
          </Label>
          <NativeSelect
            id="lead-assignment-filter"
            value={value.assignment ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                assignment: (e.target.value || undefined) as AssignmentFilter | undefined,
              })
            }
          >
            <option value="">All</option>
            {ASSIGNMENT_OPTIONS.map((assignment) => (
              <option key={assignment} value={assignment}>
                {ASSIGNMENT_LABELS[assignment]}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      <div className="w-full space-y-2 sm:w-48">
        <Label htmlFor="lead-ai-agent-filter" className="text-xs text-muted-foreground">
          AI Agent
        </Label>
        <NativeSelect
          id="lead-ai-agent-filter"
          value={value.aiAgent ?? ""}
          onChange={(e) => onChange({ ...value, aiAgent: (e.target.value || undefined) as LeadFilterState["aiAgent"] })}
        >
          <option value="">All leads</option>
          <option value="ONLY">AI Agent leads</option>
          <option value="EXCLUDE">Without AI Agent</option>
        </NativeSelect>
      </div>

      <div className="w-full space-y-2 sm:w-48">
        <Label htmlFor="lead-ai-agent-intent-filter" className="text-xs text-muted-foreground">
          AI Agent intent
        </Label>
        <NativeSelect
          id="lead-ai-agent-intent-filter"
          value={value.aiAgentIntent ?? ""}
          onChange={(e) => onChange({ ...value, aiAgentIntent: (e.target.value || undefined) as LeadFilterState["aiAgentIntent"] })}
        >
          <option value="">All</option>
          <option value="ALREADY_ORDERED">Already ordered</option>
          <option value="INTERESTED">Interested</option>
        </NativeSelect>
      </div>

      {role === "SALESPERSON" ? (
        <Button
          type="button"
          variant={value.bucket === "TODAY" ? "default" : "outline"}
          onClick={() => onChange({ ...value, bucket: value.bucket === "TODAY" ? undefined : "TODAY" })}
        >
          Today&apos;s bucket
        </Button>
      ) : null}

      {hasFilters ? (
        <Button variant="ghost" onClick={clearAll} type="button" className="text-muted-foreground">
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
