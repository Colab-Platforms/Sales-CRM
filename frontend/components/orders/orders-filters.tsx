"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface OrdersFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  /** How many column filters are on (shown on the Clear button). */
  activeFilterCount: number;
  dateRangeInvalid: boolean;
}

// Search stays here; the per-column filters are the funnels in the table header (orders-header-filters.tsx). "Clear filters"
// appears only while something is filtering the table.
export function OrdersFiltersBar({ searchText, onSearchChange, onClear, hasActiveFilters, activeFilterCount, dateRangeInvalid }: OrdersFiltersBarProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
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
        {hasActiveFilters ? (
          <Button variant="outline" size="sm" onClick={onClear} data-testid="clear-filters">
            <X data-icon="inline-start" />
            Clear filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </Button>
        ) : null}
      </div>
      {dateRangeInvalid ? (
        <p role="alert" className="text-sm text-destructive">
          The “From” date must not be after the “To” date.
        </p>
      ) : null}
    </div>
  );
}
