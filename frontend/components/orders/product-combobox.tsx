"use client";

import { useMemo } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
}

interface Item {
  value: string;
  label: string;
  sku: string | null;
}

// A searchable product picker. Unlike the app's plain Select it (a) filters as you type, (b) shows the FULL product name
// in a popup that is as wide as it needs to be rather than as wide as the trigger, and (c) renders in a portal above the
// dialog, so the list can never be clipped by - or overlap - the fields around it. Styled with the same tokens as the
// rest of the form controls (border, radius, card background, focus ring).
export function ProductCombobox({
  products,
  value,
  onChange,
  loading,
  invalid,
  id,
}: {
  products: ProductOption[];
  value: string;
  onChange: (productId: string) => void;
  loading?: boolean;
  invalid?: boolean;
  id?: string;
}) {
  const items = useMemo<Item[]>(() => products.map((p) => ({ value: p.id, label: p.name, sku: p.sku })), [products]);
  const selected = items.find((i) => i.value === value) ?? null;

  return (
    <Combobox.Root<Item>
      items={items}
      value={selected}
      onValueChange={(item) => onChange(item?.value ?? "")}
      itemToStringLabel={(item) => item.label}
      itemToStringValue={(item) => item.value}
      // Match on the name AND the SKU, so a salesperson can type either.
      filter={(item, query) => `${item.label} ${item.sku ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())}
    >
      <Combobox.InputGroup
        className={cn(
          "relative flex h-9 w-full items-center rounded-[11px_9px_12px_9px] border-[1.5px] border-input bg-card transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
          invalid && "border-destructive",
        )}
      >
        <Search className="ml-3 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Combobox.Input
          id={id}
          placeholder={loading ? "Loading products…" : "Search products…"}
          aria-label="Product"
          className="h-full min-w-0 flex-1 truncate bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Combobox.Trigger aria-label="Show all products" className="flex h-full w-9 shrink-0 items-center justify-center text-muted-foreground">
          <ChevronDown className="size-4" />
        </Combobox.Trigger>
      </Combobox.InputGroup>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} align="start" className="z-[100] outline-none">
          <Combobox.Popup className="w-[max(var(--anchor-width),min(34rem,var(--available-width)))] max-w-[var(--available-width)] origin-[var(--transform-origin)] overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
            <Combobox.Empty>
              <p className="px-3 py-4 text-sm text-muted-foreground">No products match your search.</p>
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 outline-0 data-empty:p-0">
              {(item: Item) => (
                <Combobox.Item
                  key={item.value}
                  value={item}
                  className="grid cursor-default grid-cols-[1rem_1fr] items-start gap-2 rounded-md px-2 py-2 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <Combobox.ItemIndicator className="col-start-1 mt-0.5">
                    <Check className="size-4" />
                  </Combobox.ItemIndicator>
                  <span className="col-start-2 min-w-0">
                    {/* Whole name, wrapped - never clipped. */}
                    <span className="block whitespace-normal break-words">{item.label}</span>
                    {item.sku ? <span className="block text-xs text-muted-foreground">SKU {item.sku}</span> : null}
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
