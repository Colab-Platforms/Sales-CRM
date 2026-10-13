"use client";

import { Button } from "@/components/ui/button";
import type { AbandonmentDateRange } from "@/lib/api-client/types/abandonment.types";

/** Today is the default: the daily working view. The range lives in the URL (`?range=`) so a refresh or Back from a lead returns to the same view. */
export const DEFAULT_DATE_RANGE: AbandonmentDateRange = "today";

export const DATE_RANGE_OPTIONS: { value: AbandonmentDateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "all", label: "All Leads" },
];

export const DATE_RANGE_LABEL: Record<AbandonmentDateRange, string> = { today: "Today", yesterday: "Yesterday", all: "All leads" };

export function parseDateRange(raw: string | null): AbandonmentDateRange {
  return raw === "today" || raw === "yesterday" || raw === "all" ? raw : DEFAULT_DATE_RANGE;
}

/** The leads count line shown next to the control, e.g. "12 abandoned leads · Today". */
export function dateRangeCountText(range: AbandonmentDateRange, total: number | undefined): string {
  if (total === undefined) return "Loading…";
  const noun = total === 1 ? "abandoned lead" : "abandoned leads";
  return range === "all" ? `${total} ${noun} in total` : `${total} ${noun} · ${DATE_RANGE_LABEL[range]}`;
}

export function AbandonmentDateRangeFilter({
  value,
  onChange,
  total,
  disabled,
}: {
  value: AbandonmentDateRange;
  onChange: (next: AbandonmentDateRange) => void;
  /** Number of leads matching the current range and filters; undefined while loading. */
  total: number | undefined;
  disabled?: boolean;
}) {
  return (
    <div data-testid="abandonment-date-range" className="sketch-outline flex flex-wrap items-center justify-between gap-3 bg-card/60 p-3">
      <div role="group" aria-label="Date filter" className="flex flex-wrap items-center gap-2">
        {DATE_RANGE_OPTIONS.map((option) => {
          const active = option.value === value;
          return (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              aria-pressed={active}
              disabled={disabled}
              data-testid={`date-range-${option.value}`}
              onClick={() => {
                if (!active) onChange(option.value);
              }}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      <div className="text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="date-range-count">
        {dateRangeCountText(value, total)}
        {value !== "all" ? <span className="ml-2 text-xs">(days follow India time, IST)</span> : null}
      </div>
    </div>
  );
}
