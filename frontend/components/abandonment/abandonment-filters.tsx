"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { ABANDONMENT_STATUS_LABELS } from "./abandonment-status-badge";
import type { AbandonmentStatus } from "@/lib/api-client/types/abandonment.types";

const STATUS_OPTIONS: AbandonmentStatus[] = ["ACTIVE", "IN_PROGRESS", "RECOVERED", "NOT_RECOVERED", "EXPIRED"];

export interface AbandonmentFilterState {
  search?: string;
  status?: AbandonmentStatus;
}

export function AbandonmentFilters({ value, onChange }: { value: AbandonmentFilterState; onChange: (value: AbandonmentFilterState) => void }) {
  const [search, setSearch] = useState(value.search ?? "");

  const hasFilters = Boolean(value.search || value.status);

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

      <div className="w-full space-y-2 sm:w-56">
        <Label htmlFor="abandonment-status-filter" className="text-xs text-muted-foreground">
          Status
        </Label>
        <NativeSelect
          id="abandonment-status-filter"
          value={value.status ?? ""}
          onChange={(e) => onChange({ ...value, status: (e.target.value || undefined) as AbandonmentStatus | undefined })}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {ABANDONMENT_STATUS_LABELS[status]}
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
