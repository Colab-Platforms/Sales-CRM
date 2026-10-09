"use client";

import { useState } from "react";
import {
  callsPerProductiveHour,
  formatDay,
  formatDuration,
  formatNumber,
  formatPct,
  pct,
} from "@/lib/manager-analytics";
import type { AnalyticsKpis, DailyBucket, ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { DonutChart, LineChart, seriesColor, StackedBarChart } from "./svg-charts";
import { Panel, Segmented } from "./panel";

const dayLabels = (daily: DailyBucket[]) => daily.map((d) => formatDay(d.date));
const dayTitles = (daily: DailyBucket[]) => daily.map((d) => formatDay(d.date, "weekday"));

/** Calls over time: trend lines (calls, connected, unique leads) or stacked outcomes per day. */
export function CallTrendsPanel({ daily }: { daily: DailyBucket[] }) {
  const [view, setView] = useState<"trend" | "outcomes">("trend");
  return (
    <Panel
      title="Call Trends"
      description="Calls made vs connected vs unique leads reached, day by day."
      actions={
        <Segmented
          label="Chart view"
          value={view}
          onChange={setView}
          options={[
            { value: "trend", label: "Trend" },
            { value: "outcomes", label: "Outcomes" },
          ]}
        />
      }
    >
      {view === "trend" ? (
        <LineChart
          labels={dayLabels(daily)}
          tooltipTitles={dayTitles(daily)}
          format={formatNumber}
          series={[
            { key: "calls", label: "Calls made", values: daily.map((d) => d.calls), colorClass: seriesColor(0) },
            { key: "connected", label: "Connected", values: daily.map((d) => d.connected), colorClass: seriesColor(1) },
            { key: "unique", label: "Unique leads", values: daily.map((d) => d.uniqueLeads), colorClass: seriesColor(2) },
          ]}
        />
      ) : (
        <StackedBarChart
          labels={dayLabels(daily)}
          tooltipTitles={dayTitles(daily)}
          series={[
            { key: "connected", label: "Connected", values: daily.map((d) => d.connected), colorClass: "text-emerald-500" },
            { key: "notConnected", label: "Not connected", values: daily.map((d) => d.notConnected), colorClass: "text-amber-400" },
            { key: "failed", label: "Failed", values: daily.map((d) => d.failed), colorClass: "text-red-500" },
          ]}
        />
      )}
    </Panel>
  );
}

export function CallOutcomesDonut({ kpis }: { kpis: AnalyticsKpis }) {
  return (
    <Panel title="Call Outcomes" description={`${formatPct(pct(kpis.connectedCalls, kpis.callsMade))} connection rate`}>
      <DonutChart
        centerLabel="calls"
        centerValue={formatNumber(kpis.callsMade)}
        slices={[
          { key: "c", label: "Connected", value: kpis.connectedCalls, colorClass: "text-emerald-500" },
          { key: "n", label: "Not connected", value: kpis.notConnectedCalls, colorClass: "text-amber-400" },
          { key: "f", label: "Failed", value: kpis.failedCalls, colorClass: "text-red-500" },
        ]}
      />
    </Panel>
  );
}

export function LeadStageDonut({ kpis }: { kpis: AnalyticsKpis }) {
  return (
    <Panel title="Lead Status Mix" description="Where every lead in this selection currently sits.">
      <DonutChart
        centerLabel="leads"
        centerValue={formatNumber(kpis.totalLeads)}
        slices={[
          { key: "nc", label: "Not contacted", value: kpis.notContacted, colorClass: "text-slate-400" },
          { key: "c", label: "Contacted", value: Math.max(0, kpis.contacted - kpis.interested), colorClass: "text-blue-500" },
          { key: "i", label: "Interested", value: Math.max(0, kpis.interested - kpis.converted), colorClass: "text-amber-400" },
          { key: "v", label: "Converted", value: kpis.converted, colorClass: "text-emerald-500" },
        ]}
      />
    </Panel>
  );
}

/** One line per salesperson so the manager can see who is ahead on any given day. */
export function SalespersonTrendLines({ data }: { data: ManagerAnalytics }) {
  const [metric, setMetric] = useState<"calls" | "connected" | "productive">("calls");
  const people = data.salespeople.slice(0, 6);
  const value = (d: DailyBucket, id: string) => {
    const c = d.bySalesperson[id];
    if (!c) return 0;
    return metric === "calls" ? c.calls : metric === "connected" ? c.connected : c.productiveMs / 3_600_000;
  };
  return (
    <Panel
      title="Salesperson Trends"
      description="Daily activity per salesperson."
      actions={
        <Segmented
          label="Trend metric"
          value={metric}
          onChange={setMetric}
          options={[
            { value: "calls", label: "Calls" },
            { value: "connected", label: "Connected" },
            { value: "productive", label: "Productive hrs" },
          ]}
        />
      }
    >
      <LineChart
        area={false}
        labels={dayLabels(data.daily)}
        tooltipTitles={dayTitles(data.daily)}
        format={(v) => (metric === "productive" ? `${v.toFixed(1)}h` : formatNumber(Math.round(v)))}
        series={people.map((p, i) => ({
          key: p.id,
          label: p.name.split(" ")[0]!,
          values: data.daily.map((d) => value(d, p.id)),
          colorClass: seriesColor(i),
        }))}
      />
    </Panel>
  );
}

/** Individual report: activity and lead outcomes over time. */
export function LeadActivityTrend({ daily }: { daily: DailyBucket[] }) {
  return (
    <Panel title="Activity & Results Trend" description="Calls, leads reached and lead outcomes per day.">
      <LineChart
        labels={dayLabels(daily)}
        tooltipTitles={dayTitles(daily)}
        format={formatNumber}
        series={[
          { key: "calls", label: "Calls", values: daily.map((d) => d.calls), colorClass: seriesColor(0) },
          { key: "unique", label: "Leads called", values: daily.map((d) => d.uniqueLeads), colorClass: seriesColor(1) },
          { key: "interested", label: "Interested", values: daily.map((d) => d.interested), colorClass: seriesColor(2) },
          { key: "converted", label: "Converted", values: daily.map((d) => d.converted), colorClass: seriesColor(5) },
        ]}
      />
    </Panel>
  );
}

/** Individual report: efficiency (calls per productive hour) next to productive hours. */
export function EfficiencyTrend({ daily }: { daily: DailyBucket[] }) {
  return (
    <Panel title="Calls per Productive Hour" description="How efficiently productive time turns into calls.">
      <LineChart
        labels={dayLabels(daily)}
        tooltipTitles={dayTitles(daily)}
        format={(v) => v.toFixed(1)}
        series={[
          {
            key: "cph",
            label: "Calls / productive hr",
            values: daily.map((d) => callsPerProductiveHour(d.calls, d.productiveMs)),
            colorClass: seriesColor(3),
          },
        ]}
        height={200}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Average talk time per day:{" "}
        {formatDuration(daily.length ? daily.reduce((a, d) => a + d.talkTimeSec, 0) / daily.length : 0)}
      </p>
    </Panel>
  );
}
