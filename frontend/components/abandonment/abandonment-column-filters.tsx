"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColumnFilter, RadioList, RangeInputs } from "@/components/orders/column-filter";
import { STATUS_LABELS, STATUS_ORDER } from "@/lib/status";
import { RECOVERY_ACTION_TYPE_LABELS } from "./abandonment-status-badge";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { Role } from "@/lib/api-client/types/auth.types";
import type { AbandonmentDateRange, ListAbandonmentsParams } from "@/lib/api-client/types/abandonment.types";

export type LastActionFilter = "CALL" | "CALLBACK" | "CONTINUE_ORDER" | "NONE";

/** What the table's column filters (and the search box above it) have chosen. Dates are calendar days (YYYY-MM-DD) in IST, the server's reporting timezone. */
export interface AbandonmentFilterState {
  search?: string;
  workingStatus?: LeadWorkingStatus;
  /** Item keys chosen in the table's Items column filter (any of them). */
  items?: string[];
  lead?: string;
  contact?: string;
  assignee?: string;
  lastAction?: LastActionFilter;
  valueMin?: number;
  valueMax?: number;
  detectedFrom?: string;
  detectedTo?: string;
}

export const LAST_ACTION_LABELS: Record<LastActionFilter, string> = { ...RECOVERY_ACTION_TYPE_LABELS, NONE: "No action yet" };

/** True when any filter (search box included) narrows the list. */
export function hasAnyFilter(f: AbandonmentFilterState): boolean {
  return Boolean(f.search || f.workingStatus || (f.items && f.items.length > 0) || f.lead || f.contact || f.assignee || f.lastAction || f.valueMin !== undefined || f.valueMax !== undefined || f.detectedFrom || f.detectedTo);
}

/**
 * The query the API takes. A custom "Detected" range replaces the Today / Yesterday / All tabs (the day tabs would otherwise cut the range down),
 * so dateRange becomes "all" while one is set. Days are sent as IST day bounds, the same calendar the server uses for those tabs.
 */
export function toApiFilters(f: AbandonmentFilterState, range: AbandonmentDateRange): Omit<ListAbandonmentsParams, "page" | "pageSize"> {
  const { detectedFrom, detectedTo, ...rest } = f;
  const custom = Boolean(detectedFrom || detectedTo);
  return {
    ...rest,
    dateRange: custom ? "all" : range,
    ...(detectedFrom ? { dateFrom: `${detectedFrom}T00:00:00.000+05:30` } : {}),
    ...(detectedTo ? { dateTo: `${detectedTo}T23:59:59.999+05:30` } : {}),
  };
}

function TextBody({ label, initial, onApply, close }: { label: string; initial?: string; onApply: (value: string | undefined) => void; close: () => void }) {
  const [text, setText] = useState(initial ?? "");
  const apply = () => {
    onApply(text.trim() || undefined);
    close();
  };
  return (
    <div className="grid gap-2">
      <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} placeholder={`Search ${label.toLowerCase()}…`} aria-label={`Filter ${label}`} className="h-8 text-sm" maxLength={100} />
      <Button type="button" size="sm" onClick={apply} disabled={text.trim() === (initial ?? "")}>
        Apply
      </Button>
    </div>
  );
}

const money = (n: number) => n.toLocaleString("en-IN");

/**
 * The funnel for one column header of the Abandoned Leads table (Items has its own, see items-filter.tsx). Every filter writes into the same state, so they combine,
 * and each is sent to the server - they narrow the whole result set, not the page on screen.
 */
export function AbandonmentColumnFilter({ column, value, onChange, role }: { column: string; value: AbandonmentFilterState; onChange: (next: AbandonmentFilterState) => void; role: Role }) {
  const set = (patch: Partial<AbandonmentFilterState>) => onChange({ ...value, ...patch });

  if (column === "Lead") {
    return (
      <ColumnFilter label="Lead" active={Boolean(value.lead)} summary={value.lead} onClear={() => set({ lead: undefined })} renderBody={(close) => <TextBody key={value.lead ?? ""} label="name or lead number" initial={value.lead} onApply={(lead) => set({ lead })} close={close} />} />
    );
  }
  if (column === "Contact") {
    return (
      <ColumnFilter label="Contact" active={Boolean(value.contact)} summary={value.contact} onClear={() => set({ contact: undefined })} renderBody={(close) => <TextBody key={value.contact ?? ""} label="phone or email" initial={value.contact} onApply={(contact) => set({ contact })} close={close} />} />
    );
  }
  if (column === "Assigned to") {
    return (
      <ColumnFilter label="Assigned to" active={Boolean(value.assignee)} summary={value.assignee} onClear={() => set({ assignee: undefined })} renderBody={(close) => <TextBody key={value.assignee ?? ""} label="assigned user's name" initial={value.assignee} onApply={(assignee) => set({ assignee })} close={close} />} />
    );
  }
  if (column === "Value") {
    const active = value.valueMin !== undefined || value.valueMax !== undefined;
    return (
      <ColumnFilter
        label="Value"
        active={active}
        summary={`${value.valueMin !== undefined ? money(value.valueMin) : "any"} – ${value.valueMax !== undefined ? money(value.valueMax) : "any"}`}
        onClear={() => set({ valueMin: undefined, valueMax: undefined })}
        renderBody={(close) => (
          <RangeInputs
            key={`${value.valueMin ?? ""}-${value.valueMax ?? ""}`}
            fromLabel="Min"
            toLabel="Max"
            type="number"
            initialFrom={value.valueMin !== undefined ? String(value.valueMin) : ""}
            initialTo={value.valueMax !== undefined ? String(value.valueMax) : ""}
            validate={(from, to) => (from && Number(from) < 0) || (to && Number(to) < 0) ? "Values cannot be negative" : from && to && Number(from) > Number(to) ? "Min must not be above Max" : null}
            onApply={(from, to) => {
              set({ valueMin: from ? Number(from) : undefined, valueMax: to ? Number(to) : undefined });
              close();
            }}
          />
        )}
      />
    );
  }
  if (column === "Detected") {
    const active = Boolean(value.detectedFrom || value.detectedTo);
    return (
      <ColumnFilter
        label="Detected"
        active={active}
        summary={`${value.detectedFrom ?? "any"} → ${value.detectedTo ?? "any"}`}
        onClear={() => set({ detectedFrom: undefined, detectedTo: undefined })}
        renderBody={(close) => (
          <>
            <p className="text-xs text-muted-foreground">A date range here replaces the Today / Yesterday / All tabs.</p>
            <RangeInputs
              key={`${value.detectedFrom ?? ""}-${value.detectedTo ?? ""}`}
              fromLabel="From"
              toLabel="To"
              type="date"
              initialFrom={value.detectedFrom}
              initialTo={value.detectedTo}
              validate={(from, to) => (from && to && from > to ? "From must not be after To" : null)}
              onApply={(from, to) => {
                set({ detectedFrom: from || undefined, detectedTo: to || undefined });
                close();
              }}
            />
          </>
        )}
      />
    );
  }
  if (column === "Lead Status") {
    return (
      <ColumnFilter
        label="Lead Status"
        active={Boolean(value.workingStatus)}
        summary={value.workingStatus ? STATUS_LABELS[value.workingStatus] : undefined}
        onClear={() => set({ workingStatus: undefined })}
        renderBody={(close) => (
          <RadioList
            name="Lead status"
            options={STATUS_ORDER.filter((s) => role !== "SALESPERSON" || s !== "ASSIGNED").map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
            value={value.workingStatus ?? null}
            onPick={(v) => {
              set({ workingStatus: (v ?? undefined) as LeadWorkingStatus | undefined });
              close();
            }}
          />
        )}
      />
    );
  }
  if (column === "Last action") {
    return (
      <ColumnFilter
        label="Last action"
        active={Boolean(value.lastAction)}
        summary={value.lastAction ? LAST_ACTION_LABELS[value.lastAction] : undefined}
        onClear={() => set({ lastAction: undefined })}
        renderBody={(close) => (
          <RadioList
            name="Last action"
            options={(Object.keys(LAST_ACTION_LABELS) as LastActionFilter[]).map((k) => ({ value: k, label: LAST_ACTION_LABELS[k] }))}
            value={value.lastAction ?? null}
            onPick={(v) => {
              set({ lastAction: (v ?? undefined) as LastActionFilter | undefined });
              close();
            }}
          />
        )}
      />
    );
  }
  return null;
}
