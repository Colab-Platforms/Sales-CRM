"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The live (Shopify-backed) Orders list only supports search + a date range - status, payment
// status, order source and salesperson filters aren't available on this endpoint (see
// orders.live.service.ts), so this is a deliberately smaller filter bar than OrdersFiltersBar,
// not a stripped-down copy of it.
export interface LiveOrdersFilters {
  dateFrom?: string;
  dateTo?: string;
}

interface LiveOrdersFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  filters: LiveOrdersFilters;
  onFilterChange: (patch: Partial<LiveOrdersFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  dateRangeInvalid: boolean;
}

export function LiveOrdersFiltersBar({
  searchText,
  onSearchChange,
  filters,
  onFilterChange,
  onClear,
  hasActiveFilters,
  dateRangeInvalid,
}: LiveOrdersFiltersBarProps) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by order no., customer name, mobile or email"
          aria-label="Search orders"
          maxLength={100}
          className="pl-8"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="live-orders-date-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="live-orders-date-from"
            type="date"
            value={filters.dateFrom ?? ""}
            max={filters.dateTo || undefined}
            onChange={(e) => onFilterChange({ dateFrom: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="live-orders-date-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="live-orders-date-to"
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
