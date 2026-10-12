"use client";

import { useState } from "react";
import {
  callsPerProductiveHour,
  formatDay,
  formatDuration,
  formatMs,
  formatNumber,
} from "@/lib/manager-analytics";
import type { ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { DayBarChart } from "./charts";
import { Panel, Segmented } from "./panel";

type Metric = "calls" | "connected" | "talk" | "productive";

const OPTIONS: { value: Metric; label: string }[] = [
  { value: "calls", label: "Calls Made" },
  { value: "connected", label: "Connected Calls" },
  { value: "talk", label: "Talk Time" },
  { value: "productive", label: "Productivity Time" },
];

export function TeamProductivityChart({ data }: { data: ManagerAnalytics }) {
  const [metric, setMetric] = useState<Metric>("calls");
  const { daily, kpis } = data;

  const value = (d: (typeof daily)[number]) =>
    metric === "calls" ? d.calls : metric === "connected" ? d.connected : metric === "talk" ? d.talkTimeSec : d.productiveMs / 1000;
  const isTime = metric === "talk" || metric === "productive";
  const fmt = (v: number) => (isTime ? formatDuration(v) : formatNumber(v));

  const workedDays = daily.filter((d) => d.productiveMs > 0 || d.calls > 0).length;
  const productiveDays = daily.filter((d) => d.productiveMs > 0).length;
  const avgProductive = productiveDays ? kpis.productiveMs / productiveDays : 0;
  const avgCalls = workedDays ? kpis.callsMade / workedDays : 0;

  return (
    <Panel
      title="Team Productivity"
      description="Output per day, from calls and the CRM productivity timer."
      actions={<Segmented label="Productivity metric" value={metric} options={OPTIONS} onChange={setMetric} />}
    >
      <div className="mb-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[
          ["Total Productive Time", formatMs(kpis.productiveMs)],
          ["Avg Daily Productivity", formatMs(avgProductive)],
          ["Avg Calls / Day", formatNumber(Math.round(avgCalls))],
          ["Calls / Productive Hour", callsPerProductiveHour(kpis.callsMade, kpis.productiveMs).toFixed(1)],
        ].map(([label, v]) => (
          <div key={label} className="rounded-md bg-muted/50 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className="text-lg leading-tight font-semibold tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      <DayBarChart
        data={daily.map((d) => ({
          key: d.date,
          label: daily.length <= 7 ? formatDay(d.date, "weekday") : formatDay(d.date),
          value: value(d),
          tooltip: {
            title: formatDay(d.date, "weekday"),
            rows: [
              { label: "Calls", value: formatNumber(d.calls) },
              { label: "Connected", value: formatNumber(d.connected) },
              { label: "Talk time", value: formatDuration(d.talkTimeSec) },
              { label: "Productive", value: formatMs(d.productiveMs) },
              { label: "Calls / prod. hour", value: callsPerProductiveHour(d.calls, d.productiveMs).toFixed(1) },
            ],
          },
        }))}
        format={fmt}
        barClassName="bg-teal-600 dark:bg-teal-500"
      />
    </Panel>
  );
}
