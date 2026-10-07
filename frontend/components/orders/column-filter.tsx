"use client";

import { useState, type ReactNode } from "react";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// A funnel button that sits beside a column title and opens a compact popover straight under it. `active` makes the funnel
// filled/coloured so it is obvious at a glance that this column is filtering the table. `renderBody` receives `close` so a
// single-choice filter can close after a pick, while a multi-select filter stays open for several ticks.
export function ColumnFilter({ label, active, summary, renderBody, onClear }: { label: string; active: boolean; summary?: string; renderBody: (close: () => void) => ReactNode; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={active ? `Filter ${label} (active${summary ? `: ${summary}` : ""})` : `Filter ${label}`}
        data-active={active ? "true" : "false"}
        title={active && summary ? `${label}: ${summary}` : `Filter ${label}`}
        className={cn(
          "relative ml-1 inline-flex size-6 items-center justify-center rounded-md align-middle transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          active ? "bg-primary/10 text-primary" : "text-muted-foreground",
        )}
      >
        <Filter className={cn("size-3.5", active && "fill-current")} aria-hidden />
        {active ? <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" aria-hidden /> : null}
      </PopoverTrigger>
      <PopoverContent>
        <div className="grid gap-2 font-normal normal-case">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
          {renderBody(() => setOpen(false))}
          <div className="flex justify-end border-t pt-2">
            <Button type="button" variant="ghost" size="sm" disabled={!active} onClick={() => { onClear(); setOpen(false); }}>
              Clear
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface Option<T extends string = string> { value: T; label: string }

/** Multi-select: ticking several values means "any of these" (OR). */
export function CheckList<T extends string>({ title, options, selected, onChange, emptyText }: { title?: string; options: Option<T>[]; selected: T[]; onChange: (next: T[]) => void; emptyText?: string }) {
  return (
    <fieldset className="grid gap-1">
      {title ? <legend className="mb-0.5 text-xs font-medium text-muted-foreground">{title}</legend> : null}
      {options.length === 0 ? <p className="text-xs text-muted-foreground">{emptyText ?? "No options"}</p> : null}
      <div className="grid max-h-56 gap-0.5 overflow-y-auto">
        {options.map((o) => {
          const checked = selected.includes(o.value);
          return (
            <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
              <input type="checkbox" className="size-3.5 accent-primary" checked={checked} onChange={() => onChange(checked ? selected.filter((v) => v !== o.value) : [...selected, o.value])} />
              <span className="min-w-0 truncate">{o.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Single choice with an "All" row; picking closes the popover. */
export function RadioList({ name, options, value, onPick }: { name: string; options: Option[]; value: string | null; onPick: (value: string | null) => void }) {
  const rows: Option[] = [{ value: "__all", label: "All" }, ...options];
  return (
    <div role="radiogroup" aria-label={name} className="grid gap-0.5">
      {rows.map((o) => {
        const checked = (o.value === "__all" && value === null) || o.value === value;
        return (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted">
            <input type="radio" name={name} className="size-3.5 accent-primary" checked={checked} onChange={() => onPick(o.value === "__all" ? null : o.value)} />
            {o.label}
          </label>
        );
      })}
    </div>
  );
}

/** Custom from/to (dates or numbers) with an Apply button; shows its own validation message. */
export function RangeInputs({ fromLabel, toLabel, type, initialFrom, initialTo, validate, onApply }: { fromLabel: string; toLabel: string; type: "date" | "number"; initialFrom?: string; initialTo?: string; validate: (from: string, to: string) => string | null; onApply: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");
  const error = from || to ? validate(from, to) : null;
  return (
    <div className="grid gap-2 border-t pt-2">
      <p className="text-xs font-medium text-muted-foreground">Custom</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          {fromLabel}
          <Input type={type} inputMode={type === "number" ? "decimal" : undefined} min={type === "number" ? 0 : undefined} value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 px-2 text-sm text-foreground" aria-invalid={error ? true : undefined} />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          {toLabel}
          <Input type={type} inputMode={type === "number" ? "decimal" : undefined} min={type === "number" ? 0 : undefined} value={to} onChange={(e) => setTo(e.target.value)} className="h-8 px-2 text-sm text-foreground" aria-invalid={error ? true : undefined} />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" size="sm" disabled={(!from && !to) || Boolean(error)} onClick={() => onApply(from, to)}>
        Apply
      </Button>
    </div>
  );
}
