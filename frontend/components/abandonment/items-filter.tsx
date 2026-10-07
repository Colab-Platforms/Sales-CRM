"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ColumnFilter, CheckList } from "@/components/orders/column-filter";
import { itemKeyLabel, searchItemOptions, toggleKey, type ItemOption } from "@/lib/abandonment-items";

interface ItemsFilterProps {
  /** Products found in real abandoned carts (GET /abandonments/items). */
  options: ItemOption[];
  loading?: boolean;
  failed?: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
}

// "Items ▾": a searchable multi-select of the products found in abandoned checkouts. Ticking several means "any of these" (OR).
// Selected products stay listed even when the search hides them, so a selection can always be undone.
export function ItemsFilter({ options, loading, failed, selected, onChange }: ItemsFilterProps) {
  const [search, setSearch] = useState("");
  const known = new Set(options.map((o) => o.key));
  const pool: ItemOption[] = [...options, ...selected.filter((k) => !known.has(k)).map((key) => ({ key, name: itemKeyLabel(key), sku: null, count: 0 }))];
  const visible = searchItemOptions(pool, search);
  const summary = selected.map(itemKeyLabel).join(", ");

  return (
    <ColumnFilter
      label="Items"
      active={selected.length > 0}
      summary={summary}
      onClear={() => {
        setSearch("");
        onChange([]);
      }}
      renderBody={() => (
        <div className="grid gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products..." aria-label="Search products" className="h-8 pl-7 text-sm" />
          </div>
          {loading ? <p className="text-xs text-muted-foreground">Loading products…</p> : null}
          {failed ? <p role="alert" className="text-xs text-destructive">Could not load products.</p> : null}
          <CheckList
            options={visible.map((o) => ({ value: o.key, label: `${o.name}${o.sku ? ` · ${o.sku}` : ""}${o.count ? ` (${o.count})` : ""}` }))}
            selected={selected}
            onChange={(next) => {
              // CheckList reports the whole next list; keep it in the order the user ticked.
              const added = next.find((k) => !selected.includes(k));
              onChange(added ? toggleKey(selected, added) : next);
            }}
            emptyText={search ? "No matching products" : loading ? "" : "No products in abandoned checkouts yet"}
          />
        </div>
      )}
    />
  );
}
