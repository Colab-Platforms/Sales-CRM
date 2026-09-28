"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";

export interface AbandonmentFilterState {
  search?: string;
  workingStatus?: LeadWorkingStatus;
}

export function AbandonmentFilters({
  value,
  onChange,
  role,
}: {
  value: AbandonmentFilterState;
  onChange: (value: AbandonmentFilterState) => void;
  role: Role;
}) {
  const [search, setSearch] = useState(value.search ?? "");

  const hasFilters = Boolean(value.search || value.workingStatus);

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
        <Label htmlFor="abandonment-search" className="text-xs text-muted-foreground">
          Search
        </Label>
        <div className="flex gap-2">
          <Input
            id="abandonment-search"
            placeholder="Name, phone, email or lead number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
            }}
          />
          <Button variant="outline" size="icon" onClick={submitSearch} type="button" aria-label="Search abandoned leads">
            <Search />
          </Button>
        </div>
      </div>

      <div className="w-full space-y-2 sm:w-48">
        <Label htmlFor="abandonment-status-filter" className="text-xs text-muted-foreground">
          Lead status
        </Label>
        <NativeSelect
          id="abandonment-status-filter"
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

      {hasFilters ? (
        <Button variant="ghost" onClick={clearAll} type="button" className="text-muted-foreground">
          <X />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
