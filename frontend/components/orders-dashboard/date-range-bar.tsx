"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RANGE_LABEL, RANGE_OPTIONS, todayIn, validateCustomRange, type RangeState } from "./orders-dashboard-form";

/** The date range ALL the dashboard sections use: Today, Yesterday (default), This Week, Last 7 / 30 Days, This / Last Month, or a custom From-To. Owned by the page, so every card, chart, list and export agrees. */
export function DateRangeBar({ value, onChange }: { value: RangeState; onChange: (next: RangeState) => void }) {
  const today = todayIn();
  const [fromDraft, setFromDraft] = useState(value.from ?? "");
  const [toDraft, setToDraft] = useState(value.to ?? "");
  const customError = value.range === "custom" ? validateCustomRange(fromDraft, toDraft, today) : null;

  const pick = (range: RangeState["range"]) => {
    if (range !== "custom") return onChange({ range });
    const from = fromDraft || today;
    const to = toDraft || today;
    setFromDraft(from);
    setToDraft(to);
    onChange(validateCustomRange(from, to, today) ? { range: "custom" } : { range: "custom", from, to });
  };
  const apply = (from: string, to: string) => {
    setFromDraft(from);
    setToDraft(to);
    if (!validateCustomRange(from, to, today)) onChange({ range: "custom", from, to });
  };

  return (
    <div className="space-y-2" data-testid="range-controls">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
        <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
        {RANGE_OPTIONS.map((k) => {
          const on = value.range === k;
          return (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={on ? "default" : "outline"}
              className={on ? "bg-emerald-600 text-white hover:bg-emerald-700" : "hover:border-emerald-300 hover:bg-emerald-50"}
              onClick={() => pick(k)}
              data-testid={`range-${k}`}
              aria-pressed={on}
            >
              {RANGE_LABEL[k]}
            </Button>
          );
        })}
      </div>
      {value.range === "custom" ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="od-from">From</Label>
            <Input id="od-from" type="date" value={fromDraft} max={today} onChange={(e) => apply(e.target.value, toDraft)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="od-to">To</Label>
            <Input id="od-to" type="date" value={toDraft} max={today} onChange={(e) => apply(fromDraft, e.target.value)} />
          </div>
        </div>
      ) : null}
      {customError ? <p role="alert" className="text-xs text-destructive" data-testid="range-error">{customError}</p> : null}
    </div>
  );
}
