"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";
import type { AssignmentFilter, LeadListParams } from "@/lib/api-client/types/lead.types";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";

export type LeadFilterState = Omit<LeadListParams, "page" | "limit">;

const STATUS_OPTIONS: LeadWorkingStatus[] = [
  "NEW",
  "ASSIGNED",
  "WORKING",
  "INTERESTED",
  "EXPIRED",
  "CONVERTED",
  "CLOSED",
];

const ASSIGNMENT_OPTIONS: AssignmentFilter[] = ["UNASSIGNED", "ASSIGNED_TO_MANAGER", "ASSIGNED_TO_SALESPERSON"];

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

  function submitSearch() {
    onChange({ ...value, search: search || undefined });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 flex-1 space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Search</label>
        <div className="flex gap-2">
          <Input
            placeholder="Name, phone, email or lead number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
            }}
          />
          <Button variant="outline" size="icon" onClick={submitSearch} type="button">
            <Search className="size-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Status</label>
        <select
          value={value.workingStatus ?? ""}
          onChange={(e) =>
            onChange({ ...value, workingStatus: (e.target.value || undefined) as LeadWorkingStatus | undefined })
          }
          className="border-input h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>

      {role !== "SALESPERSON" ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Assignment</label>
          <select
            value={value.assignment ?? ""}
            onChange={(e) =>
              onChange({ ...value, assignment: (e.target.value || undefined) as AssignmentFilter | undefined })
            }
            className="border-input h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs"
          >
            <option value="">All</option>
            {ASSIGNMENT_OPTIONS.map((assignment) => (
              <option key={assignment} value={assignment}>
                {assignment.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
