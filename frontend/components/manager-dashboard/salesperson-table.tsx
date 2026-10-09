"use client";

import { ChevronRight } from "lucide-react";
import {
  callsPerProductiveHour,
  conversionRate,
  formatMs,
  formatNumber,
  formatPct,
  performanceLevels,
  PERFORMANCE_LABELS,
  type PerformanceLevel,
} from "@/lib/manager-analytics";
import type { SalespersonStats } from "@/lib/api-client/types/manager-analytics.types";
import { cn } from "@/lib/utils";
import { Avatar, WorkStatusDot } from "./kpi-card";
import { EmptyState, Panel } from "./panel";

const LEVEL_STYLES: Record<PerformanceLevel, string> = {
  top: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30",
  above: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/30",
  on: "bg-muted text-muted-foreground ring-border",
  attention: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30",
};

export function PerformanceBadge({ level }: { level: PerformanceLevel }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", LEVEL_STYLES[level])}>
      {PERFORMANCE_LABELS[level]}
    </span>
  );
}

export function SalespersonPerformanceTable({
  people,
  targetPercent,
  onOpen,
}: {
  people: SalespersonStats[];
  targetPercent: number;
  onOpen: (id: string) => void;
}) {
  const levels = performanceLevels(people, targetPercent);
  const sorted = [...people].sort((a, b) => conversionRate(b) - conversionRate(a) || b.calls - a.calls);

  return (
    <Panel
      title="Salesperson Performance"
      description="Everyone reporting to you. Select a row for the full individual report."
      bodyClassName="p-0 sm:p-0"
    >
      {sorted.length === 0 ? (
        <EmptyState>No salespeople report to you yet.</EmptyState>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2.5 pr-3 pl-5 text-left font-medium">Salesperson</th>
                  {["Leads", "Contacted", "Interested", "Converted", "Conversion", "Calls", "Productivity"].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-right font-medium">
                      {h}
                    </th>
                  ))}
                  <th className="w-8 pr-4" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr
                    key={p.id}
                    tabIndex={0}
                    onClick={() => onOpen(p.id)}
                    onKeyDown={(e) => (e.key === "Enter" ? onOpen(p.id) : undefined)}
                    className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                  >
                    <td className="py-3 pr-3 pl-5">
                      <div className="flex items-center gap-3">
                        <Avatar name={p.name} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{p.name}</p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <WorkStatusDot status={p.workStatus} />
                            <PerformanceBadge level={levels.get(p.id) ?? "on"} />
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(p.leads)}</td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(p.contacted)}</td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(p.interested)}</td>
                    <td className="px-3 text-right font-medium tabular-nums">{formatNumber(p.converted)}</td>
                    <td className="px-3 text-right font-medium tabular-nums">{formatPct(conversionRate(p))}</td>
                    <td className="px-3 text-right tabular-nums">
                      {formatNumber(p.calls)}
                      <span className="block text-[11px] text-muted-foreground">{formatNumber(p.uniqueLeads)} leads</span>
                    </td>
                    <td className="px-3 text-right tabular-nums">
                      {formatMs(p.productiveMs)}
                      <span className="block text-[11px] text-muted-foreground">
                        {callsPerProductiveHour(p.calls, p.productiveMs).toFixed(1)} calls/h
                      </span>
                    </td>
                    <td className="pr-4 text-muted-foreground">
                      <ChevronRight className="size-4" aria-hidden="true" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="divide-y divide-border/60 md:hidden">
            {sorted.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onOpen(p.id)} className="w-full space-y-3 p-4 text-left active:bg-muted/50">
                  <div className="flex items-center gap-3">
                    <Avatar name={p.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.name}</p>
                      <WorkStatusDot status={p.workStatus} />
                    </div>
                    <PerformanceBadge level={levels.get(p.id) ?? "on"} />
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <dl className="grid grid-cols-4 gap-2 text-center text-xs">
                    {[
                      ["Leads", formatNumber(p.leads)],
                      ["Contacted", formatNumber(p.contacted)],
                      ["Interested", formatNumber(p.interested)],
                      ["Converted", formatNumber(p.converted)],
                      ["Conversion", formatPct(conversionRate(p))],
                      ["Calls", formatNumber(p.calls)],
                      ["Productive", formatMs(p.productiveMs)],
                      ["Calls/h", callsPerProductiveHour(p.calls, p.productiveMs).toFixed(1)],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-md bg-muted/50 px-1 py-1.5">
                        <dd className="text-sm font-semibold tabular-nums">{v}</dd>
                        <dt className="text-muted-foreground">{k}</dt>
                      </div>
                    ))}
                  </dl>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
