"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAYMENT_MODE_LABELS, SHIPMENT_STATUS_LABELS } from "@/lib/order-status";
import type { PaymentMode, ShipmentStatus } from "@/lib/api-client/types/orders.types";

// Dates are plain YYYY-MM-DD strings, as produced by <input type="date"> - same convention as orders-filters.tsx.
export interface ShiprocketFilters {
  status?: ShipmentStatus;
  courier?: string;
  paymentMode?: PaymentMode;
  dateFrom?: string;
  dateTo?: string;
}

const ALL = "ALL";

interface FilterSelectProps {
  label: string;
  allLabel: string;
  value: string | undefined;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
}

function FilterSelect({ label, allLabel, value, options, onChange }: FilterSelectProps) {
  const items = { [ALL]: allLabel, ...Object.fromEntries(options.map((o) => [o.value, o.label])) };

  return (
    <Select value={value ?? ALL} items={items} onValueChange={(next) => onChange(next === null || next === ALL ? undefined : next)}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Real ShipmentStatus values only, in the order a shipment normally moves through them - the same 9 values
// SHIPMENT_STATUS_LABELS already maps to a friendly label; nothing here is invented.
export const SHIPMENT_STATUS_FILTER_ORDER: ShipmentStatus[] = [
  "CREATED",
  "AWB_ASSIGNED",
  "PICKUP_SCHEDULED",
  "SHIPPED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
];
const STATUS_OPTIONS = SHIPMENT_STATUS_FILTER_ORDER.map((value) => ({ value, label: SHIPMENT_STATUS_LABELS[value] }));
const PAYMENT_MODE_OPTIONS = (Object.keys(PAYMENT_MODE_LABELS) as PaymentMode[]).map((value) => ({ value, label: PAYMENT_MODE_LABELS[value] }));

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

interface DatePreset {
  label: string;
  range: () => { dateFrom: string; dateTo: string };
}
const DATE_PRESETS: DatePreset[] = [
  { label: "Today", range: () => ({ dateFrom: todayIso(), dateTo: todayIso() }) },
  { label: "Last 7 days", range: () => ({ dateFrom: daysAgoIso(6), dateTo: todayIso() }) },
  { label: "Last 30 days", range: () => ({ dateFrom: daysAgoIso(29), dateTo: todayIso() }) },
];

interface ShiprocketFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  filters: ShiprocketFilters;
  onFilterChange: (patch: Partial<ShiprocketFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  couriers: string[];
  dateRangeInvalid: boolean;
}

export function ShiprocketFiltersBar({ searchText, onSearchChange, filters, onFilterChange, onClear, hasActiveFilters, couriers, dateRangeInvalid }: ShiprocketFiltersBarProps) {
  const courierOptions = couriers.map((name) => ({ value: name, label: name }));
  const activePreset = DATE_PRESETS.find((preset) => {
    const { dateFrom, dateTo } = preset.range();
    return filters.dateFrom === dateFrom && filters.dateTo === dateTo;
  });

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by order no., AWB, customer name or mobile"
          aria-label="Search Shiprocket shipments"
          maxLength={100}
          className="pl-8"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <FilterSelect label="Filter by status" allLabel="All statuses" value={filters.status} options={STATUS_OPTIONS} onChange={(value) => onFilterChange({ status: value as ShipmentStatus | undefined })} />
        <FilterSelect
          label="Filter by courier"
          allLabel={courierOptions.length === 0 ? "No couriers yet" : "All couriers"}
          value={filters.courier}
          options={courierOptions}
          onChange={(value) => onFilterChange({ courier: value })}
        />
        <FilterSelect label="Filter by payment type" allLabel="COD & prepaid" value={filters.paymentMode} options={PAYMENT_MODE_OPTIONS} onChange={(value) => onFilterChange({ paymentMode: value as PaymentMode | undefined })} />
        <div className="space-y-1">
          <Label htmlFor="shiprocket-date-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="shiprocket-date-from"
            type="date"
            value={filters.dateFrom ?? ""}
            max={filters.dateTo || undefined}
            onChange={(e) => onFilterChange({ dateFrom: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="shiprocket-date-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="shiprocket-date-to"
            type="date"
            value={filters.dateTo ?? ""}
            min={filters.dateFrom || undefined}
            onChange={(e) => onFilterChange({ dateTo: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Quick range:</span>
        {DATE_PRESETS.map((preset) => (
          <Button key={preset.label} type="button" variant={activePreset?.label === preset.label ? "default" : "outline"} size="sm" onClick={() => onFilterChange(preset.range())}>
            {preset.label}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={onClear} disabled={!hasActiveFilters}>
          <X data-icon="inline-start" />
          Clear filters
        </Button>
        {dateRangeInvalid ? (
          <p role="alert" className="text-sm text-destructive">
            The &ldquo;From&rdquo; date must not be after the &ldquo;To&rdquo; date.
          </p>
        ) : null}
      </div>
    </div>
  );
}
