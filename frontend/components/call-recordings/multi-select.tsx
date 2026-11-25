"use client";

import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/** A labelled drop-down of checkboxes: ticking several means "any of these". Searchable for long lists; "Clear" empties it. */
export function MultiSelect({ label, options, selected, onChange, loading, emptyText = "No options", searchable = true }: { label: string; options: MultiSelectOption[]; selected: string[]; onChange: (next: string[]) => void; loading?: boolean; emptyText?: string; searchable?: boolean }) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  // A selected value stays listed even when the search hides it or its option is gone, so a selection can always be undone.
  const known = new Set(options.map((o) => o.value));
  const pool = [...options, ...selected.filter((v) => !known.has(v)).map((value) => ({ value, label: value }))];
  const visible = needle ? pool.filter((o) => o.label.toLowerCase().includes(needle) || selected.includes(o.value)) : pool;
  const names = selected.map((v) => pool.find((o) => o.value === v)?.label ?? v);
  const summary = selected.length === 0 ? "All" : selected.length === 1 ? names[0]! : `${selected.length} selected`;

  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Popover>
        <PopoverTrigger
          className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-background px-3 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", selected.length > 0 && "border-primary/50")}
          aria-label={`${label}: ${summary}`}
          title={names.join(", ") || undefined}
        >
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="grid gap-2">
            {searchable ? (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} aria-label={`Search ${label}`} className="h-8 pl-7 text-sm" />
              </div>
            ) : null}
            {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
            {!loading && visible.length === 0 ? <p className="text-xs text-muted-foreground">{search ? "No matches" : emptyText}</p> : null}
            <div className="grid max-h-56 gap-0.5 overflow-y-auto">
              {visible.map((o) => {
                const checked = selected.includes(o.value);
                return (
                  <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
                    <input type="checkbox" className="size-3.5 accent-primary" checked={checked} onChange={() => onChange(checked ? selected.filter((v) => v !== o.value) : [...selected, o.value])} />
                    <span className="min-w-0 truncate" title={o.label}>{o.label}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end border-t pt-2">
              <Button type="button" variant="ghost" size="sm" disabled={selected.length === 0} onClick={() => onChange([])}>
                Clear
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
