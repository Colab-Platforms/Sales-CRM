"use client";

import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Card, CardContent } from "@/components/ui/card";
import { RangeControls, istDay } from "@/components/abandonment/export-shared";
import type { CallRecordingFilterState, CallRecordingOptions } from "@/lib/api-client/endpoints/call-recordings.api";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";
import type { ItemOption } from "@/lib/abandonment-items";
import { MultiSelect } from "./multi-select";

export function defaultFilters(): CallRecordingFilterState {
  return { from: istDay(-29), to: istDay(), telecallerIds: [], customer: "", mobile: "", items: [], statuses: [], outcomes: [], leadType: "all", sort: "latest" };
}

/** Call-length choices; each is a [min, max] in seconds, from the same duration the table shows. */
const DURATIONS: { id: string; label: string; min?: number; max?: number }[] = [
  { id: "any", label: "Any length" },
  { id: "short", label: "Under 1 minute", max: 59 },
  { id: "1-3", label: "1 – 3 minutes", min: 60, max: 180 },
  { id: "3-5", label: "3 – 5 minutes", min: 180, max: 300 },
  { id: "long", label: "Over 5 minutes", min: 300 },
];
const durationId = (f: CallRecordingFilterState) => DURATIONS.find((d) => d.min === f.minDuration && d.max === f.maxDuration)?.id ?? "any";

/** How many filters (besides the date range and the sort order) narrow the list. */
export function activeFilterCount(f: CallRecordingFilterState): number {
  return [f.telecallerIds.length > 0, f.customer.trim() !== "", f.mobile.trim() !== "", f.items.length > 0, f.statuses.length > 0, f.outcomes.length > 0, f.minDuration !== undefined || f.maxDuration !== undefined, Boolean(f.leadId), f.leadType !== "all"].filter(Boolean).length;
}

export function CallRecordingsFilters({ value, onChange, onApply, onReset, options, optionsLoading, products, productsLoading, dirty, matching, fetching, leadLabel, onClearLead }: {
  value: CallRecordingFilterState;
  onChange: (next: CallRecordingFilterState) => void;
  onApply: () => void;
  onReset: () => void;
  options?: CallRecordingOptions;
  optionsLoading: boolean;
  products: ItemOption[];
  productsLoading: boolean;
  /** The edited filters differ from the ones the table shows. */
  dirty: boolean;
  /** Recordings the APPLIED filters match (from the server), when known. */
  matching?: number;
  fetching: boolean;
  leadLabel?: string;
  onClearLead: () => void;
}) {
  const set = (patch: Partial<CallRecordingFilterState>) => onChange({ ...value, ...patch });
  const rangeInvalid = !value.from || !value.to || value.from > value.to;
  return (
    <Card>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rangeInvalid) onApply();
          }}
          data-testid="call-recording-filters"
        >
          <div className="flex flex-wrap items-center gap-2">
            <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">Filters</p>
            {value.leadId ? (
              <button type="button" onClick={onClearLead} className="inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs font-medium hover:bg-muted" aria-label="Remove the lead filter" data-testid="lead-chip">
                Lead: {leadLabel ?? "selected lead"} ×
              </button>
            ) : null}
            <p className="ml-auto text-sm text-muted-foreground" aria-live="polite" data-testid="matching-count">
              {matching === undefined ? (fetching ? "Counting…" : "") : `${matching.toLocaleString("en-IN")} recording${matching === 1 ? "" : "s"} match`}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <RangeControls from={value.from} to={value.to} idPrefix="call-recordings" onChange={(from, to) => set({ from, to })} />
          </div>
          {rangeInvalid ? <p className="text-sm text-destructive" role="alert">Choose a From date that is not after the To date.</p> : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MultiSelect label="Telecaller" options={(options?.telecallers ?? []).map((t) => ({ value: t.id, label: t.name }))} selected={value.telecallerIds} onChange={(telecallerIds) => set({ telecallerIds })} loading={optionsLoading} emptyText="No telecaller has a recording yet" />
            <label className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Customer name</span>
              <Input value={value.customer} onChange={(e) => set({ customer: e.target.value })} placeholder="Name or lead number" maxLength={100} />
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Mobile number</span>
              <Input value={value.mobile} onChange={(e) => set({ mobile: e.target.value })} placeholder="e.g. 98765 43210" inputMode="tel" maxLength={30} />
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Lead type</span>
              <NativeSelect value={value.leadType} onChange={(e) => set({ leadType: e.target.value === "abandoned" ? "abandoned" : e.target.value === "regular" ? "regular" : "all" })} aria-label="Lead type">
                <option value="all">All leads</option>
                <option value="abandoned">Abandoned checkout leads</option>
                <option value="regular">Regular leads</option>
              </NativeSelect>
            </label>
            <MultiSelect label="Product (abandoned carts)" options={products.map((p) => ({ value: p.key, label: `${p.name}${p.sku ? ` · ${p.sku}` : ""}` }))} selected={value.items} onChange={(items) => set({ items })} loading={productsLoading} emptyText="No products in abandoned checkouts yet" />
            <MultiSelect label="Lead status" options={(options?.leadStatuses ?? []).map((s) => ({ value: s.value, label: s.label }))} selected={value.statuses} onChange={(statuses) => set({ statuses: statuses as LeadWorkingStatus[] })} loading={optionsLoading} searchable={false} />
            <MultiSelect label="Call outcome" options={options?.outcomes ?? []} selected={value.outcomes} onChange={(outcomes) => set({ outcomes })} loading={optionsLoading} />
            <label className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Call duration</span>
              <NativeSelect
                value={durationId(value)}
                onChange={(e) => {
                  const d = DURATIONS.find((x) => x.id === e.target.value);
                  set({ minDuration: d?.min, maxDuration: d?.max });
                }}
                aria-label="Call duration"
              >
                {DURATIONS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={rangeInvalid || !dirty} data-testid="apply-filters">
              Apply Filters
            </Button>
            <Button type="button" variant="outline" onClick={onReset} data-testid="reset-filters">
              <RotateCcw />
              Reset Filters
            </Button>
            {dirty ? <span className="text-xs text-muted-foreground">Filters changed - click Apply Filters to update the list.</span> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
