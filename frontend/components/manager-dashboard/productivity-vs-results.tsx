"use client";

import {
  callsPerProductiveHour,
  classifyQuadrants,
  conversionRate,
  formatMs,
  formatNumber,
  formatPct,
  QUADRANT_INFO,
  type Quadrant,
} from "@/lib/manager-analytics";
import type { SalespersonStats } from "@/lib/api-client/types/manager-analytics.types";
import { cn } from "@/lib/utils";
import { Avatar } from "./kpi-card";
import { EmptyState, Panel } from "./panel";

const QUADRANT_STYLE: Record<Quadrant, string> = {
  strong: "text-emerald-700 dark:text-emerald-300",
  coaching: "text-amber-700 dark:text-amber-300",
  efficient: "text-blue-700 dark:text-blue-300",
  attention: "text-red-700 dark:text-red-300",
};

const DOT_STYLE: Record<Quadrant, string> = {
  strong: "bg-emerald-500",
  coaching: "bg-amber-500",
  efficient: "bg-blue-500",
  attention: "bg-red-500",
};

/** Productivity hours (x) against conversion rate (y), split at the team averages. Labels are computed, not narrated. */
export function ProductivityVsResults({ people, onOpen }: { people: SalespersonStats[]; onOpen: (id: string) => void }) {
  const { map, avgProd, avgConv } = classifyQuadrants(people);
  const plotted = people.filter((p) => map.has(p.id));
  const maxX = Math.max(1, avgProd * 2, ...plotted.map((p) => p.productiveMs));
  const maxY = Math.max(1, avgConv * 2, ...plotted.map((p) => conversionRate(p)));

  return (
    <Panel
      title="Productivity vs Results"
      description="Each salesperson's productive time against conversion rate. Dashed lines are the team averages."
    >
      {plotted.length === 0 ? (
        <EmptyState>No productivity or lead data for the selected filters.</EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <div>
            <div className="relative aspect-[4/3] w-full rounded-md border border-border bg-muted/30">
              <div className="absolute inset-y-0 border-l border-dashed border-border" style={{ left: `${(avgProd / maxX) * 100}%` }} />
              <div className="absolute inset-x-0 border-t border-dashed border-border" style={{ bottom: `${(avgConv / maxY) * 100}%` }} />
              {plotted.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpen(p.id)}
                  title={`${p.name}: ${formatMs(p.productiveMs)}, ${formatPct(conversionRate(p))}`}
                  className={cn(
                    "absolute size-3.5 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-card transition-transform hover:scale-125",
                    DOT_STYLE[map.get(p.id)!],
                  )}
                  style={{ left: `${(p.productiveMs / maxX) * 100}%`, bottom: `${(conversionRate(p) / maxY) * 100}%` }}
                  aria-label={p.name}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>0h</span>
              <span>Productive time →</span>
              <span>{formatMs(maxX)}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">↑ Conversion rate (max {formatPct(maxY)})</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 pr-3 text-left font-medium">Salesperson</th>
                  {["Productive", "Calls", "Calls/h", "Interested", "Converted", "Conv."].map((h) => (
                    <th key={h} className="px-2 py-2 text-right font-medium">
                      {h}
                    </th>
                  ))}
                  <th className="py-2 pl-3 text-left font-medium">Reading</th>
                </tr>
              </thead>
              <tbody>
                {plotted.map((p) => {
                  const q = map.get(p.id)!;
                  return (
                    <tr key={p.id} onClick={() => onOpen(p.id)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/50">
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-2">
                          <Avatar name={p.name} className="size-6 text-[10px]" />
                          <span className="whitespace-nowrap">{p.name}</span>
                        </span>
                      </td>
                      <td className="px-2 text-right tabular-nums">{formatMs(p.productiveMs)}</td>
                      <td className="px-2 text-right tabular-nums">{formatNumber(p.calls)}</td>
                      <td className="px-2 text-right tabular-nums">{callsPerProductiveHour(p.calls, p.productiveMs).toFixed(1)}</td>
                      <td className="px-2 text-right tabular-nums">{formatNumber(p.interested)}</td>
                      <td className="px-2 text-right tabular-nums">{formatNumber(p.converted)}</td>
                      <td className="px-2 text-right tabular-nums">{formatPct(conversionRate(p))}</td>
                      <td className={cn("py-2 pl-3 text-xs font-medium whitespace-nowrap", QUADRANT_STYLE[q])}>{QUADRANT_INFO[q].label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <dl className="mt-4 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
              {(Object.keys(QUADRANT_INFO) as Quadrant[]).map((q) => (
                <div key={q} className="flex items-start gap-2">
                  <span className={cn("mt-1 size-2 shrink-0 rounded-full", DOT_STYLE[q])} aria-hidden="true" />
                  <div>
                    <dt className="font-medium">{QUADRANT_INFO[q].label}</dt>
                    <dd className="text-muted-foreground">{QUADRANT_INFO[q].description}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </Panel>
  );
}
