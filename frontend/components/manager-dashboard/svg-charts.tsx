"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/** Series colours (Tailwind text-* classes so SVG can use currentColor and dark mode works). */
export const SERIES_COLORS = [
  "text-blue-600 dark:text-blue-400",
  "text-teal-600 dark:text-teal-400",
  "text-amber-500 dark:text-amber-400",
  "text-violet-600 dark:text-violet-400",
  "text-rose-500 dark:text-rose-400",
  "text-emerald-600 dark:text-emerald-400",
] as const;

export const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length]!;
const bgOf = (cls: string) => cls.replace(/text-/g, "bg-");

function niceMax(max: number): number {
  if (max <= 0) return 4;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

export interface LineSeries {
  key: string;
  label: string;
  values: number[];
  colorClass: string;
}

/**
 * Multi-series line chart. The first series is also drawn as a soft area when `area` is set.
 * Hovering a day shows a guide line, a dot on each series and a tooltip with every value.
 */
export function LineChart({
  labels,
  series,
  format,
  height = 240,
  area = true,
  tooltipTitles,
}: {
  labels: string[];
  series: LineSeries[];
  format: (v: number) => string;
  height?: number;
  area?: boolean;
  tooltipTitles?: string[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const top = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => top * f);
  const labelEvery = n > 21 ? 3 : n > 10 ? 2 : 1;
  const W = 1000;
  const H = 100;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - (top > 0 ? (v / top) * H : 0);
  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const leftPct = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);

  if (n === 0) return null;

  return (
    <div>
      <div className="flex gap-2">
        <div className="flex shrink-0 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="leading-none">
              {format(Math.round(t * 100) / 100)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
        <div className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {ticks.map((t) => (
              <div key={t} className="border-t border-dashed border-border/80" />
            ))}
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
            {area && series[0] ? (
              <path d={`${path(series[0].values)} L${x(n - 1)},${H} L${x(0)},${H} Z`} className={series[0].colorClass} fill="currentColor" fillOpacity={0.1} />
            ) : null}
            {series.map((s) => (
              <path
                key={s.key}
                d={path(s.values)}
                className={s.colorClass}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {n <= 31
            ? series.map((s) =>
                s.values.map((v, i) => (
                  <span
                    key={`${s.key}-${i}`}
                    className={cn("pointer-events-none absolute size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full", bgOf(s.colorClass), hover === i && "size-2.5 ring-2 ring-card")}
                    style={{ left: `${leftPct(i)}%`, bottom: `${top > 0 ? (v / top) * 100 : 0}%` }}
                  />
                )),
              )
            : null}
          {hover !== null ? (
            <>
              <span className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25" style={{ left: `${leftPct(hover)}%` }} />
              <div
                className="pointer-events-none absolute top-1 z-20 w-48 rounded-md border border-border bg-popover p-2.5 text-xs shadow-md"
                style={{ left: `${leftPct(hover)}%`, transform: hover > n / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}
              >
                <p className="mb-1.5 font-semibold">{tooltipTitles?.[hover] ?? labels[hover]}</p>
                <dl className="space-y-1">
                  {series.map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-3">
                      <dt className="flex items-center gap-1.5 text-muted-foreground">
                        <span className={cn("size-2 rounded-full", bgOf(s.colorClass))} />
                        {s.label}
                      </dt>
                      <dd className="font-medium tabular-nums">{format(s.values[hover] ?? 0)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          ) : null}
          <div className="absolute inset-0 flex">
            {labels.map((l, i) => (
              <div key={l + i} className="h-full flex-1" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
            ))}
          </div>
        </div>
        <div className="relative mt-1 h-5 text-[11px] text-muted-foreground">
          {labels.map((l, i) =>
            i % labelEvery === 0 ? (
              <span key={l + i} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${leftPct(i)}%` }}>
                {l}
              </span>
            ) : null,
          )}
        </div>
        </div>
      </div>
      {series.length > 1 ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className={cn("h-0.5 w-4 rounded", bgOf(s.colorClass))} />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  colorClass: string;
}

/** Donut with a centre total and a legend showing count and share. */
export function DonutChart({
  slices,
  centerLabel,
  centerValue,
  format = (v) => v.toLocaleString("en-IN"),
}: {
  slices: DonutSlice[];
  centerLabel: string;
  centerValue: string;
  format?: (v: number) => string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div className="relative size-40 shrink-0">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" role="img" aria-label={`${centerLabel}: ${centerValue}`}>
          <circle cx="50" cy="50" r={R} fill="none" strokeWidth="12" className="stroke-muted" />
          {total > 0
            ? slices.map((s) => {
                const len = (s.value / total) * C;
                const el = (
                  <circle
                    key={s.key}
                    cx="50"
                    cy="50"
                    r={R}
                    fill="none"
                    strokeWidth="12"
                    stroke="currentColor"
                    className={s.colorClass}
                    strokeDasharray={`${Math.max(0, len - (slices.length > 1 ? 0.8 : 0))} ${C}`}
                    strokeDashoffset={-offset}
                  />
                );
                offset += len;
                return el;
              })
            : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-semibold tabular-nums">{centerValue}</span>
          <span className="text-[11px] text-muted-foreground">{centerLabel}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-2">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm">
            <span className={cn("size-2.5 shrink-0 rounded-full", bgOf(s.colorClass))} />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="font-medium tabular-nums">{format(s.value)}</span>
            <span className="w-12 text-right text-xs text-muted-foreground tabular-nums">{total > 0 ? ((s.value / total) * 100).toFixed(1) : "0.0"}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tiny trend line for KPI cards. */
export function Sparkline({ values, colorClass = "text-primary" }: { values: number[]; colorClass?: string }) {
  if (values.length < 2 || Math.max(...values) <= 0) return null;
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(26 - (v / max) * 24).toFixed(1)}`);
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cn("h-7 w-full", colorClass)} aria-hidden="true">
      <polygon points={`0,28 ${pts.join(" ")} 100,28`} fill="currentColor" fillOpacity={0.1} />
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface StackSeries {
  key: string;
  label: string;
  colorClass: string;
  values: number[];
}

/** Stacked daily columns (e.g. connected / not connected / failed per day). */
export function StackedBarChart({
  labels,
  series,
  height = 240,
  tooltipTitles,
}: {
  labels: string[];
  series: StackSeries[];
  height?: number;
  tooltipTitles?: string[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const labelEvery = labels.length > 21 ? 3 : labels.length > 10 ? 2 : 1;

  return (
    <div>
      <div className="flex gap-2">
        <div className="flex shrink-0 flex-col justify-between pb-6 text-right text-[11px] text-muted-foreground tabular-nums" style={{ height }}>
          {[1, 0.75, 0.5, 0.25, 0].map((f) => (
            <span key={f} className="leading-none">
              {Math.round(top * f)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }} onMouseLeave={() => setHover(null)}>
          <div className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between">
            {[0, 1, 2, 3, 4].map((k) => (
              <div key={k} className="border-t border-dashed border-border/80" />
            ))}
          </div>
          <div className="absolute inset-0 flex gap-1.5 px-1">
            {labels.map((l, i) => (
              <div key={l + i} className="relative flex min-w-0 flex-1 flex-col" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
                <div className="flex flex-1 flex-col-reverse pb-6">
                  <div className="flex flex-col-reverse overflow-hidden rounded-t-[3px]" style={{ height: `${(totals[i]! / top) * 100}%`, marginTop: "auto" }}>
                    {series.map((s) => (
                      <div
                        key={s.key}
                        className={cn(bgOf(s.colorClass), hover !== null && hover !== i && "opacity-50")}
                        style={{ height: `${totals[i] ? ((s.values[i] ?? 0) / totals[i]!) * 100 : 0}%` }}
                      />
                    ))}
                  </div>
                </div>
                <span className="absolute inset-x-0 bottom-0 h-6 truncate text-center text-[11px] leading-6 text-muted-foreground">{i % labelEvery === 0 ? l : ""}</span>
                {hover === i ? (
                  <div className={cn("pointer-events-none absolute top-0 z-20 w-44 rounded-md border border-border bg-popover p-2.5 text-xs shadow-md", i > labels.length / 2 ? "right-full mr-1" : "left-full ml-1")}>
                    <p className="mb-1.5 font-semibold">{tooltipTitles?.[i] ?? l}</p>
                    <dl className="space-y-1">
                      {series.map((s) => (
                        <div key={s.key} className="flex items-center justify-between gap-3">
                          <dt className="flex items-center gap-1.5 text-muted-foreground">
                            <span className={cn("size-2 rounded-full", bgOf(s.colorClass))} />
                            {s.label}
                          </dt>
                          <dd className="font-medium tabular-nums">{s.values[i] ?? 0}</dd>
                        </div>
                      ))}
                      <div className="flex justify-between gap-3 border-t border-border pt-1">
                        <dt className="text-muted-foreground">Total</dt>
                        <dd className="font-semibold tabular-nums">{totals[i]}</dd>
                      </div>
                    </dl>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-sm", bgOf(s.colorClass))} />
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
