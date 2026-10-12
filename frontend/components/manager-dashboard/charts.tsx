"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TooltipContent {
  title: string;
  rows: { label: string; value: string }[];
}

function niceMax(max: number): number {
  if (max <= 0) return 4;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const frac = max / exp;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * exp;
}

export interface DayBar {
  key: string;
  label: string;
  value: number;
  tooltip: TooltipContent;
}

const LABEL_H = 24; // px reserved under the plot for x-axis labels

/**
 * Vertical bar chart with one bar per day. Hovering/tapping a bar shows its tooltip. Many bars
 * (e.g. 30 days) scroll horizontally instead of squeezing the labels.
 */
export function DayBarChart({
  data,
  format,
  height = 240,
  barClassName = "bg-primary",
}: {
  data: DayBar[];
  format: (v: number) => string;
  height?: number;
  barClassName?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => top * f);
  const labelEvery = data.length > 21 ? 3 : data.length > 10 ? 2 : 1;
  const plotH = height - LABEL_H;

  return (
    <div className="flex gap-2">
      <div
        className="flex shrink-0 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums"
        style={{ height: plotH }}
      >
        {ticks.map((t) => (
          <span key={t} className="leading-none">
            {format(Math.round(t * 100) / 100)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 pointer-events-none -mt-24 overflow-x-auto pt-24">
        <div className="pointer-events-auto relative" style={{ height, minWidth: data.length * 30 }}>
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between" style={{ height: plotH }}>
            {ticks.map((t) => (
              <div key={t} className="border-t border-dashed border-border/80" />
            ))}
          </div>
          <div className="absolute inset-0 flex items-stretch gap-1.5 px-1">
            {data.map((d, i) => {
              const h = top > 0 ? (d.value / top) * 100 : 0;
              const isActive = active === d.key;
              return (
                <div
                  key={d.key}
                  className="relative flex min-w-0 flex-1 flex-col"
                  onMouseEnter={() => setActive(d.key)}
                  onMouseLeave={() => setActive((c) => (c === d.key ? null : c))}
                  onClick={() => setActive((c) => (c === d.key ? null : d.key))}
                >
                  <div className="flex items-end" style={{ height: plotH }}>
                    <div
                      className={cn("w-full rounded-t-[3px] transition-opacity", barClassName, active && !isActive && "opacity-50")}
                      style={{ height: `${Math.max(h, d.value > 0 ? 1.5 : 0)}%` }}
                      role="img"
                      aria-label={`${d.label}: ${format(d.value)}`}
                    />
                  </div>
                  <span className="truncate text-center text-[11px] text-muted-foreground" style={{ height: LABEL_H, lineHeight: `${LABEL_H}px` }}>
                    {i % labelEvery === 0 ? d.label : ""}
                  </span>
                  {isActive ? (
                    <div
                      className={cn(
                        "pointer-events-none absolute z-20 w-48 rounded-md border border-border bg-popover p-2.5 text-xs shadow-md",
                        i > data.length / 2 ? "right-0" : "left-0",
                      )}
                      style={{ bottom: Math.min(plotH - 8, (h / 100) * plotH + LABEL_H + 6) }}
                    >
                      <p className="mb-1.5 font-semibold">{d.tooltip.title}</p>
                      <dl className="space-y-1">
                        {d.tooltip.rows.map((r) => (
                          <div key={r.label} className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">{r.label}</dt>
                            <dd className="font-medium tabular-nums">{r.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface HBarRow {
  id: string;
  label: string;
  value: number;
  display: string;
  tone?: "default" | "good" | "bad";
}

/** Horizontal ranking bars; rows are clickable when onRowClick is given. Optional reference line. */
export function HorizontalBarChart({
  rows,
  target,
  onRowClick,
  emptyLabel = "No data for the selected filters.",
}: {
  rows: HBarRow[];
  target?: { value: number; label: string };
  onRowClick?: (id: string) => void;
  emptyLabel?: ReactNode;
}) {
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  const scale = niceMax(Math.max(target?.value ?? 0, ...rows.map((r) => r.value)) * 1.05);
  const targetLeft = target ? (target.value / scale) * 100 : 0;

  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="w-28 shrink-0 truncate text-left text-sm sm:w-36">{r.label}</span>
            <span className="relative h-5 min-w-0 flex-1 rounded-sm bg-muted/60">
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-sm",
                  r.tone === "good" ? "bg-emerald-500" : r.tone === "bad" ? "bg-amber-500" : "bg-primary",
                )}
                style={{ width: `${Math.min(100, (r.value / scale) * 100)}%` }}
              />
              {target ? (
                <span className="absolute -inset-y-[3px] w-px bg-foreground/60" style={{ left: `${targetLeft}%` }} aria-hidden="true" />
              ) : null}
            </span>
            <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">{r.display}</span>
          </>
        );
        return onRowClick ? (
          <button
            key={r.id}
            type="button"
            onClick={() => onRowClick(r.id)}
            title={`Open ${r.label} report`}
            className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {inner}
          </button>
        ) : (
          <div key={r.id} className="flex items-center gap-3 px-1 py-0.5">
            {inner}
          </div>
        );
      })}
      {target ? (
        <p className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span className="inline-block h-3 w-px bg-foreground/60" aria-hidden="true" />
          {target.label}
        </p>
      ) : null}
    </div>
  );
}
