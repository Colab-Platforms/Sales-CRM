"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { CALL_DIRECTION_LABELS, CALL_STATUS_LABELS, CALL_STATUS_ORDER } from "@/lib/call-status";
import type { CallDirection } from "@/lib/api-client/types/call-history.types";
import type { CallStatus } from "@/lib/api-client/types/calls.types";

export type CallHistoryFilterState = {
  search?: string;
  status?: CallStatus;
  direction?: CallDirection;
  dateFrom?: string;
  dateTo?: string;
};

/** Same search/status/date-range shape as LeadFilters. */
export function CallHistoryFilters({
  value,
  onChange,
}: {
  value: CallHistoryFilterState;
  onChange: (value: CallHistoryFilterState) => void;
}) {
  const [search, setSearch] = useState(value.search ?? "");
  const hasFilters = Boolean(value.search || value.status || value.direction || value.dateFrom || value.dateTo);

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
        <Label htmlFor="call-search" className="text-xs text-muted-foreground">
          Search
        </Label>
        <div className="flex gap-2">
          <Input
            id="call-search"
            placeholder="Customer name, mobile or lead number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
            }}
          />
          <Button variant="outline" size="icon" onClick={submitSearch} type="button" aria-label="Search calls">
            <Search />
          </Button>
        </div>
      </div>

      <div className="w-full space-y-2 sm:w-48">
        <Label htmlFor="call-status-filter" className="text-xs text-muted-foreground">
          Status
        </Label>
        <NativeSelect
          id="call-status-filter"
          value={value.status ?? ""}
          onChange={(e) => onChange({ ...value, status: (e.target.value || undefined) as CallStatus | undefined })}
        >
          <option value="">All statuses</option>
          {CALL_STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {CALL_STATUS_LABELS[status]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="w-full space-y-2 sm:w-40">
        <Label htmlFor="call-direction-filter" className="text-xs text-muted-foreground">
          Direction
        </Label>
        <NativeSelect
          id="call-direction-filter"
          value={value.direction ?? ""}
          onChange={(e) => onChange({ ...value, direction: (e.target.value || undefined) as CallDirection | undefined })}
        >
          <option value="">All</option>
          {(Object.keys(CALL_DIRECTION_LABELS) as CallDirection[]).map((d) => (
            <option key={d} value={d}>
              {CALL_DIRECTION_LABELS[d]}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="w-full space-y-2 sm:w-40">
        <Label htmlFor="call-date-from" className="text-xs text-muted-foreground">
          From
        </Label>
        <Input
          id="call-date-from"
          type="date"
          value={value.dateFrom ?? ""}
          onChange={(e) => onChange({ ...value, dateFrom: e.target.value || undefined })}
        />
      </div>

      <div className="w-full space-y-2 sm:w-40">
        <Label htmlFor="call-date-to" className="text-xs text-muted-foreground">
          To
        </Label>
        <Input
          id="call-date-to"
          type="date"
          value={value.dateTo ?? ""}
          onChange={(e) => onChange({ ...value, dateTo: e.target.value || undefined })}
        />
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
