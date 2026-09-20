"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ACTIVITY_SOURCE_LABELS, ACTIVITY_SOURCE_ORDER, ACTIVITY_TYPE_LABELS, AUDIT_FILTERABLE_TYPES } from "@/lib/audit-status";
import type { ActivitySource, ActivityType } from "@/lib/api-client/types/audit.types";

export interface AuditFilters {
  type?: ActivityType;
  source?: ActivitySource;
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
    <Select
      value={value ?? ALL}
      items={items}
      onValueChange={(next) => onChange(next === null || next === ALL ? undefined : next)}
    >
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

const TYPE_OPTIONS = AUDIT_FILTERABLE_TYPES.map((value) => ({ value, label: ACTIVITY_TYPE_LABELS[value] }));
const SOURCE_OPTIONS = ACTIVITY_SOURCE_ORDER.map((value) => ({ value, label: ACTIVITY_SOURCE_LABELS[value] }));

interface AuditFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  filters: AuditFilters;
  onFilterChange: (patch: Partial<AuditFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  dateRangeInvalid: boolean;
}

export function AuditFiltersBar({
  searchText,
  onSearchChange,
  filters,
  onFilterChange,
  onClear,
  hasActiveFilters,
  dateRangeInvalid,
}: AuditFiltersBarProps) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by title, description, customer or order"
          aria-label="Search audit trail"
          maxLength={100}
          className="pl-8"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect
          label="Filter by action"
          allLabel="All actions"
          value={filters.type}
          options={TYPE_OPTIONS}
          onChange={(value) => onFilterChange({ type: value as ActivityType | undefined })}
        />
        <FilterSelect
          label="Filter by source"
          allLabel="All sources"
          value={filters.source}
          options={SOURCE_OPTIONS}
          onChange={(value) => onFilterChange({ source: value as ActivitySource | undefined })}
        />
        <div className="space-y-1">
          <Label htmlFor="audit-date-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="audit-date-from"
            type="date"
            value={filters.dateFrom ?? ""}
            max={filters.dateTo || undefined}
            onChange={(e) => onFilterChange({ dateFrom: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-date-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="audit-date-to"
            type="date"
            value={filters.dateTo ?? ""}
            min={filters.dateFrom || undefined}
            onChange={(e) => onFilterChange({ dateTo: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={onClear} disabled={!hasActiveFilters}>
          <X data-icon="inline-start" />
          Clear filters
        </Button>
        {dateRangeInvalid ? (
          <p role="alert" className="text-sm text-destructive">
            The “From” date must not be after the “To” date.
          </p>
        ) : null}
      </div>
    </div>
  );
}
