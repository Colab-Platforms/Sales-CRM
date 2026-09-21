"use client";

import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PROVIDER_LABELS, TEMPLATE_STATUS_LABELS, TEMPLATE_STATUS_ORDER } from "@/lib/whatsapp-template-status";
import type { WhatsAppProvider, WhatsAppTemplateStatus } from "@/lib/api-client/types/whatsapp-templates.types";

export interface TemplateFilters {
  provider?: WhatsAppProvider;
  status?: WhatsAppTemplateStatus;
  category?: string;
  language?: string;
}

const ALL = "ALL";
const PROVIDER_OPTIONS = (Object.keys(PROVIDER_LABELS) as WhatsAppProvider[]).map((value) => ({ value, label: PROVIDER_LABELS[value] }));
const STATUS_OPTIONS = TEMPLATE_STATUS_ORDER.map((value) => ({ value, label: TEMPLATE_STATUS_LABELS[value] }));

function FilterSelect({ label, allLabel, value, options, onChange }: { label: string; allLabel: string; value: string | undefined; options: { value: string; label: string }[]; onChange: (v: string | undefined) => void }) {
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

interface TemplatesFiltersBarProps {
  searchText: string;
  onSearchChange: (text: string) => void;
  filters: TemplateFilters;
  onFilterChange: (patch: Partial<TemplateFilters>) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}

export function TemplatesFiltersBar({ searchText, onSearchChange, filters, onFilterChange, onClear, hasActiveFilters }: TemplatesFiltersBarProps) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by template name or body"
          aria-label="Search templates"
          maxLength={100}
          className="pl-8"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterSelect label="Filter by provider" allLabel="All providers" value={filters.provider} options={PROVIDER_OPTIONS} onChange={(v) => onFilterChange({ provider: v as WhatsAppProvider | undefined })} />
        <FilterSelect label="Filter by status" allLabel="All statuses" value={filters.status} options={STATUS_OPTIONS} onChange={(v) => onFilterChange({ status: v as WhatsAppTemplateStatus | undefined })} />
        <Input value={filters.category ?? ""} onChange={(e) => onFilterChange({ category: e.target.value || undefined })} placeholder="Category, e.g. UTILITY" aria-label="Filter by category" maxLength={50} />
        <Input value={filters.language ?? ""} onChange={(e) => onFilterChange({ language: e.target.value || undefined })} placeholder="Language, e.g. en" aria-label="Filter by language" maxLength={10} />
      </div>

      <Button variant="outline" size="sm" onClick={onClear} disabled={!hasActiveFilters}>
        <X data-icon="inline-start" />
        Clear filters
      </Button>
    </div>
  );
}
