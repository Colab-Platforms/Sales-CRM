"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CheckList, ColumnFilter, type Option } from "./column-filter";

export interface TagOption {
  name: string;
  source: "SHOPIFY" | "CRM";
}

/** Options to show for a search: selected tags always stay listed; a typed tag that is not in the list can be added as-is. Pure, so testable. */
export function tagFilterOptions(available: TagOption[], selected: string[], search: string): { options: Option[]; custom: string | null } {
  const needle = search.trim().toLowerCase();
  const known = new Set(available.map((t) => t.name.toLowerCase()));
  const pool = [...available.map((t) => t.name), ...selected.filter((s) => !known.has(s.toLowerCase()))];
  const options = pool.filter((n) => !needle || n.toLowerCase().includes(needle) || selected.includes(n)).map((n) => ({ value: n, label: n }));
  const typed = search.trim();
  const canAdd = typed.length > 0 && typed.length <= 255 && !typed.includes(",") && !pool.some((n) => n.toLowerCase() === typed.toLowerCase());
  return { options, custom: canAdd ? typed : null };
}

interface TagsFilterProps {
  selected: string[];
  onChange: (next: string[]) => void;
  available: TagOption[];
  loading?: boolean;
  error?: string | null;
}

// "Tags ▾" in the Orders header: a searchable multi-select of the tags that exist on real orders (Shopify's tags and the CRM's
// "CRM Confirmed by …" tags). Ticking several means any of them (OR). Reuses the other column filters' popover and checklist.
export function OrdersTagsFilter({ selected, onChange, available, loading, error }: TagsFilterProps) {
  const [search, setSearch] = useState("");
  const { options, custom } = tagFilterOptions(available, selected, search);
  return (
    <ColumnFilter
      label="Tags"
      active={selected.length > 0}
      summary={selected.join(", ")}
      onClear={() => {
        setSearch("");
        onChange([]);
      }}
      renderBody={() => (
        <div className="grid gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tags..." aria-label="Search tags" className="h-8 pl-7 text-sm" />
          </div>
          {loading ? <p className="text-xs text-muted-foreground">Loading tags…</p> : null}
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          {custom ? (
            <button type="button" className="rounded-md px-1.5 py-1 text-left text-sm text-primary hover:bg-muted" onClick={() => { onChange([...selected, custom]); setSearch(""); }}>
              Filter by “{custom}”
            </button>
          ) : null}
          <CheckList options={options} selected={selected} onChange={onChange} emptyText={loading ? "" : search ? "No matching tags" : "No tags on orders yet"} />
        </div>
      )}
    />
  );
}
