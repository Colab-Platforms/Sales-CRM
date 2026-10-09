"use client";

import { useState } from "react";
import { Download, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  CALL_STATUS_LABELS,
  LEAD_STATUS_LABELS,
  RANGE_LABELS,
  type DashboardFilters,
  type RangePreset,
} from "@/lib/manager-analytics";
import type { CallStatusFilter, LeadStatusFilter } from "@/lib/api-client/types/manager-analytics.types";

type Patch = (patch: Partial<DashboardFilters>) => void;

export function DateRangeFilter({ filters, onChange }: { filters: DashboardFilters; onChange: Patch }) {
  return (
    <>
      <NativeSelect
        aria-label="Date range"
        value={filters.preset}
        onChange={(e) => onChange({ preset: e.target.value as RangePreset })}
        wrapperClassName="sm:w-44"
      >
        {(Object.keys(RANGE_LABELS) as RangePreset[]).map((p) => (
          <option key={p} value={p}>
            {RANGE_LABELS[p]}
          </option>
        ))}
      </NativeSelect>
      {filters.preset === "custom" ? (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label="From date"
            value={filters.customFrom}
            max={filters.customTo || undefined}
            onChange={(e) => onChange({ customFrom: e.target.value })}
            className="w-full sm:w-40"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            aria-label="To date"
            value={filters.customTo}
            min={filters.customFrom || undefined}
            onChange={(e) => onChange({ customTo: e.target.value })}
            className="w-full sm:w-40"
          />
        </div>
      ) : null}
    </>
  );
}

export function SalespersonFilter({
  value,
  people,
  onChange,
  disabled,
}: {
  value: string;
  people: { id: string; name: string }[];
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <NativeSelect
      aria-label="Salesperson"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      wrapperClassName="sm:w-48"
    >
      <option value="">All Salespeople</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </NativeSelect>
  );
}

export function CallStatusSelect({ value, onChange }: { value: CallStatusFilter; onChange: (v: CallStatusFilter) => void }) {
  return (
    <NativeSelect aria-label="Call status" value={value} onChange={(e) => onChange(e.target.value as CallStatusFilter)} wrapperClassName="sm:w-40">
      {(Object.keys(CALL_STATUS_LABELS) as CallStatusFilter[]).map((s) => (
        <option key={s} value={s}>
          {CALL_STATUS_LABELS[s]}
        </option>
      ))}
    </NativeSelect>
  );
}

export function LeadStatusSelect({ value, onChange }: { value: LeadStatusFilter; onChange: (v: LeadStatusFilter) => void }) {
  return (
    <NativeSelect aria-label="Lead status" value={value} onChange={(e) => onChange(e.target.value as LeadStatusFilter)} wrapperClassName="sm:w-40">
      {(Object.keys(LEAD_STATUS_LABELS) as LeadStatusFilter[]).map((s) => (
        <option key={s} value={s}>
          {LEAD_STATUS_LABELS[s]}
        </option>
      ))}
    </NativeSelect>
  );
}

/**
 * The global filter bar. On desktop the controls sit inline; below `lg` they collapse into a
 * drawer opened from a single "Filters" button so the page is not dominated by form controls.
 */
export function FilterBar({
  filters,
  onChange,
  people,
  showSalesperson = true,
  showLeadStatus = true,
  onExport,
}: {
  filters: DashboardFilters;
  onChange: Patch;
  people: { id: string; name: string }[];
  showSalesperson?: boolean;
  showLeadStatus?: boolean;
  onExport?: () => void;
}) {
  const [open, setOpen] = useState(false);

  const controls = (
    <>
      <DateRangeFilter filters={filters} onChange={onChange} />
      {showSalesperson ? (
        <SalespersonFilter value={filters.salespersonId} people={people} onChange={(id) => onChange({ salespersonId: id })} />
      ) : null}
      <CallStatusSelect value={filters.callStatus} onChange={(callStatus) => onChange({ callStatus })} />
      {showLeadStatus ? <LeadStatusSelect value={filters.leadStatus} onChange={(leadStatus) => onChange({ leadStatus })} /> : null}
    </>
  );

  return (
    <>
      <div className="hidden flex-wrap items-center gap-2 lg:flex">
        {controls}
        {onExport ? (
          <Button variant="outline" onClick={onExport}>
            <Download data-icon="inline-start" /> Export Report
          </Button>
        ) : null}
      </div>
      <div className="flex gap-2 lg:hidden">
        <Button variant="outline" className="flex-1" onClick={() => setOpen(true)}>
          <SlidersHorizontal data-icon="inline-start" /> Filters
        </Button>
        {onExport ? (
          <Button variant="outline" onClick={onExport} aria-label="Export report">
            <Download data-icon="inline-start" /> Export
          </Button>
        ) : null}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4 pb-6 [&_div]:w-full">{controls}</div>
          <div className="px-4 pb-6">
            <Button className="w-full" onClick={() => setOpen(false)}>
              Apply
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
