"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/stores/auth-store";
import { adminSalespersonsQueryOptions } from "@/lib/api-client/queries/admin.queries";
import { mySalespersonsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { virtualNumbersQueryOptions } from "@/lib/api-client/queries/calling.queries";
import { CALL_STATUS_LABELS, CALL_STATUS_ORDER } from "@/lib/call-status";
import type { CallStatus } from "@/lib/api-client/types/calls.types";
import type { CallListParams } from "@/lib/api-client/types/call-history.types";

export type IvrFilterState = Omit<CallListParams, "page" | "limit" | "direction">;

/** Same search/status/date-range shape as CallHistoryFilters, plus the IVR-specific
 * agent/DID/recording filters (section 8 of the IVR spec). The direction itself is fixed by the
 * page (Inbound vs Outbound), so it's never a filter here. */
export function IvrFilters({ value, onChange }: { value: IvrFilterState; onChange: (value: IvrFilterState) => void }) {
  const role = useAuthStore((s) => s.user?.role);
  const [search, setSearch] = useState(value.search ?? "");

  // ADMIN sees every salesperson, MANAGER sees their own team, SALESPERSON never needs this filter
  // (lead-scope already limits them to their own calls - see call.history.filters.ts).
  const { data: adminAgents } = useQuery({ ...adminSalespersonsQueryOptions(), enabled: role === "ADMIN" });
  const { data: managerAgents } = useQuery({ ...mySalespersonsQueryOptions(), enabled: role === "MANAGER" });
  const agents = role === "ADMIN" ? adminAgents : role === "MANAGER" ? managerAgents : undefined;

  const { data: virtualNumbers } = useQuery(virtualNumbersQueryOptions());

  const hasFilters = Boolean(value.search || value.status || value.dateFrom || value.dateTo || value.agentId || value.virtualNumberId || value.hasRecording !== undefined);

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
        <Label htmlFor="ivr-search" className="text-xs text-muted-foreground">
          Search
        </Label>
        <div className="flex gap-2">
          <Input
            id="ivr-search"
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

      <div className="w-full space-y-2 sm:w-44">
        <Label htmlFor="ivr-status-filter" className="text-xs text-muted-foreground">
          Status
        </Label>
        <NativeSelect
          id="ivr-status-filter"
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

      {agents ? (
        <div className="w-full space-y-2 sm:w-44">
          <Label htmlFor="ivr-agent-filter" className="text-xs text-muted-foreground">
            Agent
          </Label>
          <NativeSelect id="ivr-agent-filter" value={value.agentId ?? ""} onChange={(e) => onChange({ ...value, agentId: e.target.value || undefined })}>
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      <div className="w-full space-y-2 sm:w-44">
        <Label htmlFor="ivr-did-filter" className="text-xs text-muted-foreground">
          DID / Virtual number
        </Label>
        <NativeSelect id="ivr-did-filter" value={value.virtualNumberId ?? ""} onChange={(e) => onChange({ ...value, virtualNumberId: e.target.value || undefined })}>
          <option value="">All numbers</option>
          {(virtualNumbers ?? []).map((vn) => (
            <option key={vn.id} value={vn.id}>
              {vn.displayName ?? vn.number}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="w-full space-y-2 sm:w-36">
        <Label htmlFor="ivr-recording-filter" className="text-xs text-muted-foreground">
          Recording
        </Label>
        <NativeSelect
          id="ivr-recording-filter"
          value={value.hasRecording === undefined ? "" : String(value.hasRecording)}
          onChange={(e) => onChange({ ...value, hasRecording: e.target.value === "" ? undefined : e.target.value === "true" })}
        >
          <option value="">Any</option>
          <option value="true">Available</option>
          <option value="false">Not available</option>
        </NativeSelect>
      </div>

      <div className="w-full space-y-2 sm:w-40">
        <Label htmlFor="ivr-date-from" className="text-xs text-muted-foreground">
          From
        </Label>
        <Input id="ivr-date-from" type="date" value={value.dateFrom ?? ""} onChange={(e) => onChange({ ...value, dateFrom: e.target.value || undefined })} />
      </div>

      <div className="w-full space-y-2 sm:w-40">
        <Label htmlFor="ivr-date-to" className="text-xs text-muted-foreground">
          To
        </Label>
        <Input id="ivr-date-to" type="date" value={value.dateTo ?? ""} onChange={(e) => onChange({ ...value, dateTo: e.target.value || undefined })} />
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
