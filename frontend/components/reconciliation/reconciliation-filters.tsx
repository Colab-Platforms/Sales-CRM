"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NO_PAYMENT_LABEL, PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_ORDER } from "@/lib/order-status";
import { RECONCILIATION_STATUS_LABELS, RECONCILIATION_STATUS_ORDER } from "@/lib/reconciliation-status";
import type { PaymentMode, PaymentStatusFilter } from "@/lib/api-client/types/orders.types";
import type { ReconciliationStatus } from "@/lib/api-client/types/reconciliation.types";

// Dates are plain YYYY-MM-DD strings, as produced by <input type="date">.
export interface ReconciliationFilters {
  paymentStatus?: PaymentStatusFilter;
  paymentMode?: PaymentMode;
  reconciliationStatus?: ReconciliationStatus;
  provider?: string;
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

const PAYMENT_STATUS_OPTIONS = [
  ...PAYMENT_STATUS_ORDER.map((value) => ({ value, label: PAYMENT_STATUS_LABELS[value] })),
  { value: "NONE", label: NO_PAYMENT_LABEL },
];
const PAYMENT_MODE_OPTIONS = (Object.keys(PAYMENT_MODE_LABELS) as PaymentMode[]).map((value) => ({
  value,
  label: PAYMENT_MODE_LABELS[value],
}));
const RECONCILIATION_STATUS_OPTIONS = RECONCILIATION_STATUS_ORDER.map((value) => ({
  value,
  label: RECONCILIATION_STATUS_LABELS[value],
}));

interface ReconciliationFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  filters: ReconciliationFilters;
  onFilterChange: (patch: Partial<ReconciliationFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  dateRangeInvalid: boolean;
}

export function ReconciliationFiltersBar({
  searchText,
  onSearchChange,
  filters,
  onFilterChange,
  onClear,
  hasActiveFilters,
  dateRangeInvalid,
}: ReconciliationFiltersBarProps) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by order no., customer name, mobile, email, lead no. or payment reference"
          aria-label="Search orders"
          maxLength={100}
          className="pl-8"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <FilterSelect
          label="Filter by payment status"
          allLabel="All payments"
          value={filters.paymentStatus}
          options={PAYMENT_STATUS_OPTIONS}
          onChange={(value) => onFilterChange({ paymentStatus: value as PaymentStatusFilter | undefined })}
        />
        <FilterSelect
          label="Filter by COD / Prepaid"
          allLabel="COD & prepaid"
          value={filters.paymentMode}
          options={PAYMENT_MODE_OPTIONS}
          onChange={(value) => onFilterChange({ paymentMode: value as PaymentMode | undefined })}
        />
        <FilterSelect
          label="Filter by reconciliation status"
          allLabel="All reconciliation statuses"
          value={filters.reconciliationStatus}
          options={RECONCILIATION_STATUS_OPTIONS}
          onChange={(value) => onFilterChange({ reconciliationStatus: value as ReconciliationStatus | undefined })}
        />
        <div className="space-y-1">
          <Label htmlFor="reconciliation-provider" className="text-xs text-muted-foreground">
            Payment provider
          </Label>
          <Input
            id="reconciliation-provider"
            value={filters.provider ?? ""}
            onChange={(e) => onFilterChange({ provider: e.target.value || undefined })}
            placeholder="e.g. Razorpay"
            maxLength={100}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="reconciliation-date-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="reconciliation-date-from"
            type="date"
            value={filters.dateFrom ?? ""}
            max={filters.dateTo || undefined}
            onChange={(e) => onFilterChange({ dateFrom: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="reconciliation-date-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="reconciliation-date-to"
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
