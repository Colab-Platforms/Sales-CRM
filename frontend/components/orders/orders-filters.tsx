"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  NO_PAYMENT_LABEL,
  ORDER_SOURCE_LABELS,
  ORDER_SOURCE_ORDER,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_ORDER,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_ORDER,
} from "@/lib/order-status";
import type { OrderSource, OrderStatus, PaymentStatusFilter } from "@/lib/api-client/types/orders.types";

// Dates are plain YYYY-MM-DD strings, as produced by <input type="date">.
export interface OrdersFilters {
  status?: OrderStatus;
  paymentStatus?: PaymentStatusFilter;
  source?: OrderSource;
  salespersonId?: string;
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

const STATUS_OPTIONS = ORDER_STATUS_ORDER.map((value) => ({ value, label: ORDER_STATUS_LABELS[value] }));
const PAYMENT_OPTIONS = [
  ...PAYMENT_STATUS_ORDER.map((value) => ({ value, label: PAYMENT_STATUS_LABELS[value] })),
  { value: "NONE", label: NO_PAYMENT_LABEL },
];
const SOURCE_OPTIONS = ORDER_SOURCE_ORDER.map((value) => ({ value, label: ORDER_SOURCE_LABELS[value] }));

interface OrdersFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  filters: OrdersFilters;
  onFilterChange: (patch: Partial<OrdersFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  salespeople: { id: string; name: string }[];
  showSalesperson: boolean;
  dateRangeInvalid: boolean;
}

export function OrdersFiltersBar({
  searchText,
  onSearchChange,
  filters,
  onFilterChange,
  onClear,
  hasActiveFilters,
  salespeople,
  showSalesperson,
  dateRangeInvalid,
}: OrdersFiltersBarProps) {
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
          label="Filter by order status"
          allLabel="All statuses"
          value={filters.status}
          options={STATUS_OPTIONS}
          onChange={(value) => onFilterChange({ status: value as OrderStatus | undefined })}
        />
        <FilterSelect
          label="Filter by payment status"
          allLabel="All payments"
          value={filters.paymentStatus}
          options={PAYMENT_OPTIONS}
          onChange={(value) => onFilterChange({ paymentStatus: value as PaymentStatusFilter | undefined })}
        />
        <FilterSelect
          label="Filter by order source"
          allLabel="All order sources"
          value={filters.source}
          options={SOURCE_OPTIONS}
          onChange={(value) => onFilterChange({ source: value as OrderSource | undefined })}
        />
        {showSalesperson ? (
          <FilterSelect
            label="Filter by salesperson"
            allLabel="All salespeople"
            value={filters.salespersonId}
            options={salespeople.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(value) => onFilterChange({ salespersonId: value })}
          />
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="orders-date-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="orders-date-from"
            type="date"
            value={filters.dateFrom ?? ""}
            max={filters.dateTo || undefined}
            onChange={(e) => onFilterChange({ dateFrom: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="orders-date-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="orders-date-to"
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
