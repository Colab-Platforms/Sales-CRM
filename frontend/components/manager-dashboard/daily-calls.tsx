"use client";

import { useMemo, useState } from "react";
import {
  CALL_METRIC_LABELS,
  formatCallMetric,
  formatDay,
  formatDuration,
  formatNumber,
  rangeLabel,
  type CallMetric,
  type DashboardFilters,
} from "@/lib/manager-analytics";
import type { DailyBucket, ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { cn } from "@/lib/utils";
import { DayBarChart } from "./charts";
import { CallStatusSelect, DateRangeFilter, SalespersonFilter } from "./filters";
import { EmptyState, Panel, Segmented } from "./panel";

const METRIC_OPTIONS = (Object.keys(CALL_METRIC_LABELS) as CallMetric[]).map((m) => ({ value: m, label: CALL_METRIC_LABELS[m] }));

/** Reusable day-by-day call chart (manager dashboard, salesperson report, future admin dashboard). */
export function DailyCallsChart({ daily, metric, height }: { daily: DailyBucket[]; metric: CallMetric; height?: number }) {
  const bars = daily.map((d) => ({
    key: d.date,
    label: formatDay(d.date),
    value: d[metric],
    tooltip: {
      title: formatDay(d.date, "long"),
      rows: [
        { label: "Total Calls", value: formatNumber(d.calls) },
        { label: "Connected", value: formatNumber(d.connected) },
        { label: "Not Connected", value: formatNumber(d.notConnected) },
        { label: "Failed", value: formatNumber(d.failed) },
        { label: "Total Talk Time", value: formatDuration(d.talkTimeSec) },
        { label: "Unique Leads Contacted", value: formatNumber(d.uniqueLeads) },
      ],
    },
  }));
  if (bars.length === 0) return <EmptyState>No days in the selected range.</EmptyState>;
  return <DayBarChart data={bars} format={(v) => formatCallMetric(metric, v)} height={height} />;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg leading-tight font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function DailyCallPerformance({
  data,
  filters,
  onFiltersChange,
}: {
  data: ManagerAnalytics;
  filters: DashboardFilters;
  onFiltersChange: (patch: Partial<DashboardFilters>) => void;
}) {
  const [metric, setMetric] = useState<CallMetric>("calls");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const { kpis, salespeople, daily } = data;
  const allSelected = !filters.salespersonId;
  const visible = salespeople.filter((p) => !hidden.has(p.id));

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // With deselected salespeople the chart reflects only the chosen ones.
  const chartDaily = useMemo<DailyBucket[]>(() => {
    if (hidden.size === 0) return daily;
    return daily.map((d) => {
      const sum = { calls: 0, connected: 0, notConnected: 0, failed: 0, talkTimeSec: 0, uniqueLeads: 0 };
      for (const p of visible) {
        const c = d.bySalesperson[p.id];
        if (!c) continue;
        sum.calls += c.calls;
        sum.connected += c.connected;
        sum.notConnected += c.notConnected;
        sum.failed += c.failed;
        sum.talkTimeSec += c.talkTimeSec;
        sum.uniqueLeads += c.uniqueLeads; // a lead called by two people on one day counts once per person
      }
      return { ...d, ...sum };
    });
  }, [daily, hidden, visible]);

  const summary = useMemo(() => {
    const total = (k: CallMetric) => chartDaily.reduce((a, d) => a + d[k], 0);
    return {
      calls: total("calls"),
      connected: total("connected"),
      talk: total("talkTimeSec"),
      peak: chartDaily.reduce((best, d) => (d.calls > (best?.calls ?? -1) ? d : best), chartDaily[0]),
    };
  }, [chartDaily]);

  return (
    <Panel
      title="Daily Call Performance"
      description={`Actual calls made on each day · ${rangeLabel(data.range.from, data.range.to)}`}
      actions={<Segmented label="Call metric" value={metric} options={METRIC_OPTIONS} onChange={setMetric} />}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DateRangeFilter filters={filters} onChange={onFiltersChange} />
        <SalespersonFilter value={filters.salespersonId} people={data.team} onChange={(id) => onFiltersChange({ salespersonId: id })} />
        <CallStatusSelect value={filters.callStatus} onChange={(callStatus) => onFiltersChange({ callStatus })} />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-2 lg:grid-cols-5">
        <Stat label="Calls Made" value={formatNumber(summary.calls)} hint={`${formatNumber(kpis.uniqueLeadsContacted)} unique leads`} />
        <Stat label="Unique Leads Contacted" value={formatNumber(kpis.uniqueLeadsContacted)} hint="Calls ≠ leads" />
        <Stat label="Connected" value={formatNumber(summary.connected)} />
        <Stat label="Talk Time" value={formatDuration(summary.talk)} />
        <Stat
          label="Busiest Day"
          value={summary.peak && summary.peak.calls > 0 ? formatDay(summary.peak.date) : "—"}
          hint={summary.peak && summary.peak.calls > 0 ? `${formatNumber(summary.peak.calls)} calls` : undefined}
        />
      </div>

      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{CALL_METRIC_LABELS[metric]} by day</h3>
      <DailyCallsChart daily={chartDaily} metric={metric} />

      {allSelected && salespeople.length > 1 ? (
        <div className="mt-6 border-t border-border/70 pt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="mr-2 text-sm font-semibold">Team Daily Comparison</h3>
            {salespeople.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={!hidden.has(p.id)}
                onClick={() => toggle(p.id)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  hidden.has(p.id) ? "border-border text-muted-foreground line-through" : "border-primary/40 bg-primary/10 text-primary",
                )}
              >
                {p.name.split(" ")[0]}
              </button>
            ))}
          </div>
          <div className="max-h-96 overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  {visible.map((p) => (
                    <th key={p.id} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {p.name.split(" ")[0]}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Team Total</th>
                </tr>
              </thead>
              <tbody>
                {chartDaily.map((d) => (
                  <tr key={d.date} className="border-t border-border/60">
                    <td className="px-3 py-1.5 whitespace-nowrap">{formatDay(d.date)}</td>
                    {visible.map((p) => (
                      <td key={p.id} className="px-3 py-1.5 text-right tabular-nums">
                        {formatCallMetric(metric, d.bySalesperson[p.id]?.[metric] ?? 0)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{formatCallMetric(metric, d[metric])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
