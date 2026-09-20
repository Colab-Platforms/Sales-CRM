"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CUSTOMER_SEGMENT_LABELS, CUSTOMER_SEGMENT_ORDER } from "@/lib/customer-segment";
import { NBA_ACTION_LABELS, NBA_ACTION_ORDER, NBA_PRIORITY_LABELS, NBA_PRIORITY_ORDER } from "@/lib/nba-status";
import { NO_PAYMENT_LABEL, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_ORDER, SHIPMENT_STATUS_LABELS } from "@/lib/order-status";
import type { PaymentStatusFilter, ShipmentStatus } from "@/lib/api-client/types/orders.types";
import type { CustomerSegment, NbaAction, NbaPriority } from "@/lib/api-client/types/customers.types";

// Dates are plain YYYY-MM-DD strings, as produced by <input type="date">.
export interface CustomersFilters {
  segment?: CustomerSegment;
  ownerId?: string;
  hasOrders?: "true" | "false";
  paymentStatus?: PaymentStatusFilter;
  shipmentStatus?: ShipmentStatus;
  nbaAction?: NbaAction;
  nbaPriority?: NbaPriority;
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

const SEGMENT_OPTIONS = CUSTOMER_SEGMENT_ORDER.map((value) => ({ value, label: CUSTOMER_SEGMENT_LABELS[value] }));
const HAS_ORDERS_OPTIONS = [
  { value: "true", label: "Has orders" },
  { value: "false", label: "No orders yet" },
];
const PAYMENT_OPTIONS = [
  ...PAYMENT_STATUS_ORDER.map((value) => ({ value, label: PAYMENT_STATUS_LABELS[value] })),
  { value: "NONE", label: NO_PAYMENT_LABEL },
];
const SHIPMENT_OPTIONS = (Object.keys(SHIPMENT_STATUS_LABELS) as ShipmentStatus[]).map((value) => ({
  value,
  label: SHIPMENT_STATUS_LABELS[value],
}));
const NBA_ACTION_OPTIONS = NBA_ACTION_ORDER.map((value) => ({ value, label: NBA_ACTION_LABELS[value] }));
const NBA_PRIORITY_OPTIONS = NBA_PRIORITY_ORDER.map((value) => ({ value, label: NBA_PRIORITY_LABELS[value] }));

interface CustomersFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  filters: CustomersFilters;
  onFilterChange: (patch: Partial<CustomersFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
  owners: { id: string; name: string }[];
  showOwner: boolean;
  dateRangeInvalid: boolean;
}

export function CustomersFiltersBar({
  searchText,
  onSearchChange,
  filters,
  onFilterChange,
  onClear,
  hasActiveFilters,
  owners,
  showOwner,
  dateRangeInvalid,
}: CustomersFiltersBarProps) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by name, mobile, email or customer number"
          aria-label="Search customers"
          maxLength={100}
          className="pl-8"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <FilterSelect
          label="Filter by segment"
          allLabel="All segments"
          value={filters.segment}
          options={SEGMENT_OPTIONS}
          onChange={(value) => onFilterChange({ segment: value as CustomerSegment | undefined })}
        />
        {showOwner ? (
          <FilterSelect
            label="Filter by owner"
            allLabel="All owners"
            value={filters.ownerId}
            options={owners.map((o) => ({ value: o.id, label: o.name }))}
            onChange={(value) => onFilterChange({ ownerId: value })}
          />
        ) : null}
        <FilterSelect
          label="Filter by order history"
          allLabel="All customers"
          value={filters.hasOrders}
          options={HAS_ORDERS_OPTIONS}
          onChange={(value) => onFilterChange({ hasOrders: value as "true" | "false" | undefined })}
        />
        <FilterSelect
          label="Filter by current payment status"
          allLabel="All payment states"
          value={filters.paymentStatus}
          options={PAYMENT_OPTIONS}
          onChange={(value) => onFilterChange({ paymentStatus: value as PaymentStatusFilter | undefined })}
        />
        <FilterSelect
          label="Filter by current shipment status"
          allLabel="All shipment states"
          value={filters.shipmentStatus}
          options={SHIPMENT_OPTIONS}
          onChange={(value) => onFilterChange({ shipmentStatus: value as ShipmentStatus | undefined })}
        />
        <FilterSelect
          label="Filter by next best action"
          allLabel="All next actions"
          value={filters.nbaAction}
          options={NBA_ACTION_OPTIONS}
          onChange={(value) => onFilterChange({ nbaAction: value as NbaAction | undefined })}
        />
        <FilterSelect
          label="Filter by action priority"
          allLabel="All priorities"
          value={filters.nbaPriority}
          options={NBA_PRIORITY_OPTIONS}
          onChange={(value) => onFilterChange({ nbaPriority: value as NbaPriority | undefined })}
        />
        <div className="space-y-1">
          <Label htmlFor="customers-date-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="customers-date-from"
            type="date"
            value={filters.dateFrom ?? ""}
            max={filters.dateTo || undefined}
            onChange={(e) => onFilterChange({ dateFrom: e.target.value || undefined })}
            aria-invalid={dateRangeInvalid || undefined}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="customers-date-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="customers-date-to"
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
