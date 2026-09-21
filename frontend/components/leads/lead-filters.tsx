"use client";

import { useState } from "react";
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

  const hasFilters = Boolean(value.search || value.workingStatus || value.assignment);

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
          {STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </NativeSelect>
      </div>

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

      {hasFilters ? (
        <Button variant="ghost" onClick={clearAll} type="button" className="text-muted-foreground">
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
