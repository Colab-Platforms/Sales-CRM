"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, Download, Phone } from "lucide-react";
import { salespersonAnalyticsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import type { ActivityItem, DailyBucket, SalespersonAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  avgCallDurationSec,
  callsPerProductiveHour,
  connectionRate,
  contactRate,
  conversionRate,
  exportCsv,
  filtersFromSearch,
  filtersToSearch,
  formatCallDuration,
  formatDay,
  formatDuration,
  formatMs,
  formatNumber,
  formatPct,
  interestRate,
  rangeLabel,
  toQuery,
  type CallMetric,
  type DashboardFilters,
} from "@/lib/manager-analytics";
import { cn } from "@/lib/utils";
import { DayBarChart } from "./charts";
import { DailyCallsChart } from "./daily-calls";
import { CallStatusSelect, DateRangeFilter } from "./filters";
import { Avatar, KpiCard, WorkStatusDot } from "./kpi-card";
import { LeadFunnel } from "./lead-funnel";
import { CallOutcomesDonut, EfficiencyTrend, LeadActivityTrend } from "./trends";
import { DashboardHeader } from "./manager-sales-dashboard";
import { EmptyState, Panel, Segmented } from "./panel";

const METRICS: CallMetric[] = ["calls", "connected", "talkTimeSec"];
const METRIC_LABELS: Record<string, string> = { calls: "Calls", connected: "Connected Calls", talkTimeSec: "Talk Time" };

export function SalespersonReport({ salespersonId }: { salespersonId: string }) {
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<DashboardFilters>(() => filtersFromSearch(searchParams));
  const patch = (p: Partial<DashboardFilters>) => setFilters((f) => ({ ...f, ...p }));
  const { data, isPending, error, isPlaceholderData } = useQuery(salespersonAnalyticsQueryOptions(salespersonId, toQuery(filters)));

  const back = (
    <Link
      href="/dashboard"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" /> Back to Dashboard
    </Link>
  );

  if (isPending) {
    return (
      <div className="space-y-6">
        {back}
        <Skeleton className="h-16 w-72 rounded-lg" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-lg" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="space-y-6">
        {back}
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load this salesperson's report.")}
        </div>
      </div>
    );
  }

  const sp = data.salesperson;

  return (
    <div className="space-y-6">
      {back}
      <DashboardHeader title={sp.name} subtitle="Sales Executive">
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeFilter filters={filters} onChange={patch} />
          <CallStatusSelect value={filters.callStatus} onChange={(callStatus) => patch({ callStatus })} />
          <Button
            variant="outline"
            onClick={() => exportCsv(`${sp.username}-report-${data.range.from}_${data.range.to}.csv`, reportCsv(data))}
          >
            <Download data-icon="inline-start" /> Export
          </Button>
        </div>
      </DashboardHeader>

      <div className="flex items-center gap-3">
        <Avatar name={sp.name} className="size-10 text-sm" />
        <div>
          <WorkStatusDot status={sp.workStatus} />
          <p className="text-xs text-muted-foreground">
            {rangeLabel(data.range.from, data.range.to)} · {data.range.days} {data.range.days === 1 ? "day" : "days"} ·{" "}
            <Link href={`/dashboard?${filtersToSearch(filters)}`} className="hover:underline">
              compare with team
            </Link>
          </p>
        </div>
      </div>

      <div className={cn("space-y-6 transition-opacity", isPlaceholderData && "opacity-60")} aria-busy={isPlaceholderData}>
        <ReportKpis data={data} />

        <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
          <DailyCallActivity daily={data.daily} />
          <LeadFunnel
            totalLabel="Assigned"
            total={sp.leads}
            contacted={sp.contacted}
            interested={sp.interested}
            converted={sp.converted}
            title="Lead Funnel"
            description={`Contact rate ${formatPct(contactRate(sp))} · Interest rate ${formatPct(interestRate(sp))}`}
          />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <LeadActivityTrend daily={data.daily} />
          <CallOutcomesDonut kpis={data.kpis} />
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <ProductivityAnalytics daily={data.daily} />
          <EfficiencyTrend daily={data.daily} />
        </div>

        <CallActivity data={data} />

        <DailyPerformanceTable daily={data.daily} />
        <RecentActivityTimeline items={data.recentActivity} />
      </div>
    </div>
  );
}

function ReportKpis({ data }: { data: SalespersonAnalytics }) {
  const s = data.salesperson;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <KpiCard label="Assigned Leads" tone="blue" value={formatNumber(s.leads)} accent />
      <KpiCard label="Contacted Leads" tone="teal" value={formatNumber(s.contacted)} lines={[{ text: `${formatPct(contactRate(s))} contact rate` }]} />
      <KpiCard label="Interested Leads" tone="amber" value={formatNumber(s.interested)} lines={[{ text: `${formatPct(interestRate(s))} of contacted` }]} />
      <KpiCard label="Converted Leads" tone="emerald" value={formatNumber(s.converted)} />
      <KpiCard
        label="Conversion Rate" tone="emerald"
        value={formatPct(conversionRate(s), 2)}
        lines={[{ text: `Team target ${data.targets.conversionRatePercent}%`, tone: conversionRate(s) >= data.targets.conversionRatePercent ? "positive" : "negative" }]}
      />
      <KpiCard label="Calls Made" tone="violet" spark={data.daily.map((d) => d.calls)} value={formatNumber(s.calls)} lines={[{ text: `${formatNumber(s.uniqueLeads)} unique leads called` }]} />
      <KpiCard label="Connected Calls" tone="teal" value={formatNumber(s.connected)} lines={[{ text: `${formatPct(connectionRate(s))} connection rate` }]} />
      <KpiCard label="Talk Time" tone="slate" value={formatDuration(s.talkTimeSec)} />
      <KpiCard label="Productivity Time" tone="blue" spark={data.daily.map((d) => d.productiveMs)} value={formatMs(s.productiveMs)} lines={[{ text: `${callsPerProductiveHour(s.calls, s.productiveMs).toFixed(1)} calls / productive hour` }]} />
    </div>
  );
}

function DailyCallActivity({ daily }: { daily: DailyBucket[] }) {
  const [metric, setMetric] = useState<CallMetric>("calls");
  return (
    <Panel
      title="Daily Call Activity"
      description="Actual call count for each day."
      actions={
        <Segmented
          label="Metric"
          value={metric}
          options={METRICS.map((m) => ({ value: m, label: METRIC_LABELS[m]! }))}
          onChange={setMetric}
        />
      }
    >
      <DailyCallsChart daily={daily} metric={metric} height={260} />
    </Panel>
  );
}

function ProductivityAnalytics({ daily }: { daily: DailyBucket[] }) {
  return (
    <Panel title="Productivity Analytics" description="Productive time per day from the CRM timer. Hover a day for calls and talk time.">
      <DayBarChart
        data={daily.map((d) => ({
          key: d.date,
          label: formatDay(d.date),
          value: d.productiveMs / 1000,
          tooltip: {
            title: formatDay(d.date, "long"),
            rows: [
              { label: "Productivity", value: formatMs(d.productiveMs) },
              { label: "Calls", value: formatNumber(d.calls) },
              { label: "Connected", value: formatNumber(d.connected) },
              { label: "Talk Time", value: formatDuration(d.talkTimeSec) },
              { label: "Calls / Productive Hr", value: callsPerProductiveHour(d.calls, d.productiveMs).toFixed(1) },
            ],
          },
        }))}
        format={formatDuration}
        barClassName="bg-teal-600 dark:bg-teal-500"
        height={220}
      />
    </Panel>
  );
}

function CallActivity({ data }: { data: SalespersonAnalytics }) {
  const s = data.salesperson;
  const rows: [string, string][] = [
    ["Total Calls", formatNumber(s.calls)],
    ["Connected", formatNumber(s.connected)],
    ["Not Connected", formatNumber(s.notConnected)],
    ["Failed", formatNumber(s.failed)],
    ["Connection Rate", formatPct(connectionRate(s))],
    ["Average Call Duration", formatCallDuration(avgCallDurationSec(s))],
    ["Total Talk Time", formatDuration(s.talkTimeSec)],
    ["Unique Leads Called", formatNumber(s.uniqueLeads)],
  ];
  return (
    <Panel title="Call Activity" description="Calls made are counted separately from unique leads contacted.">
      <dl className="grid grid-cols-2 gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="rounded-md bg-muted/50 px-3 py-2">
            <dt className="text-[11px] text-muted-foreground">{k}</dt>
            <dd className="text-lg leading-tight font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

type SortKey = "date" | "calls" | "connected" | "productiveMs" | "interested" | "converted";

function DailyPerformanceTable({ daily }: { daily: DailyBucket[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "date", dir: "desc" });
  const rows = useMemo(() => {
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...daily].sort((a, b) => (sort.key === "date" ? a.date.localeCompare(b.date) : a[sort.key] - b[sort.key]) * sign);
  }, [daily, sort]);

  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const cols: { key: SortKey | null; label: string }[] = [
    { key: "date", label: "Date" },
    { key: "calls", label: "Calls" },
    { key: "connected", label: "Connected" },
    { key: null, label: "Talk Time" },
    { key: "productiveMs", label: "Productive Time" },
    { key: null, label: "Contacted" },
    { key: "interested", label: "Interested" },
    { key: "converted", label: "Converted" },
  ];

  return (
    <Panel title="Daily Performance" description="Sort by any highlighted column. Contacted = unique leads called that day." bodyClassName="p-0 sm:p-0">
      {rows.length === 0 ? (
        <EmptyState>No days in the selected range.</EmptyState>
      ) : (
        <>
          <div className="hidden max-h-[28rem] overflow-auto md:block">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  {cols.map((c, i) => (
                    <th key={c.label} className={cn("px-3 py-2.5 font-medium whitespace-nowrap", i === 0 ? "pl-5 text-left" : "text-right")}>
                      {c.key ? (
                        <button type="button" onClick={() => toggle(c.key!)} className="inline-flex items-center gap-1 hover:text-foreground">
                          {c.label}
                          {sort.key === c.key ? (
                            sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                          ) : null}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.date} className="border-t border-border/60">
                    <td className="py-2 pr-3 pl-5 whitespace-nowrap">{formatDay(d.date)}</td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(d.calls)}</td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(d.connected)}</td>
                    <td className="px-3 text-right tabular-nums">{formatDuration(d.talkTimeSec)}</td>
                    <td className="px-3 text-right tabular-nums">{formatMs(d.productiveMs)}</td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(d.uniqueLeads)}</td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(d.interested)}</td>
                    <td className="px-3 text-right tabular-nums">{formatNumber(d.converted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border/60 md:hidden">
            {rows.map((d) => (
              <li key={d.date} className="p-4">
                <p className="mb-2 text-sm font-medium">{formatDay(d.date, "weekday")}</p>
                <dl className="grid grid-cols-4 gap-2 text-center text-xs">
                  {[
                    ["Calls", formatNumber(d.calls)],
                    ["Connected", formatNumber(d.connected)],
                    ["Talk", formatDuration(d.talkTimeSec)],
                    ["Productive", formatMs(d.productiveMs)],
                    ["Contacted", formatNumber(d.uniqueLeads)],
                    ["Interested", formatNumber(d.interested)],
                    ["Converted", formatNumber(d.converted)],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-md bg-muted/50 px-1 py-1.5">
                      <dd className="text-sm font-semibold tabular-nums">{v}</dd>
                      <dt className="text-muted-foreground">{k}</dt>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function RecentActivityTimeline({ items }: { items: ActivityItem[] }) {
  return (
    <Panel title="Recent Activity" description="Latest calls, lead updates and shifts.">
      {items.length === 0 ? (
        <EmptyState>No recent activity.</EmptyState>
      ) : (
        <ol className="relative ml-2 space-y-5 border-l border-border pl-6">
          {items.map((i) => {
            const at = new Date(i.at);
            return (
              <li key={i.id} className="relative">
                <span
                  className={cn(
                    "absolute top-1.5 -left-[1.9rem] flex size-3 items-center justify-center rounded-full ring-4 ring-card",
                    i.kind === "CALL" ? "bg-primary" : i.kind === "SESSION" ? "bg-teal-500" : "bg-muted-foreground/60",
                  )}
                  aria-hidden="true"
                />
                <p className="text-xs text-muted-foreground">
                  {at.toLocaleDateString("en-US", { month: "short", day: "numeric" })},{" "}
                  {at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </p>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {i.kind === "CALL" ? <Phone className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
                  {i.leadId ? (
                    <Link href={`/dashboard/leads/${i.leadId}`} className="hover:underline">
                      {i.title}
                    </Link>
                  ) : (
                    i.title
                  )}
                </p>
                {i.detail ? (
                  <p className="text-sm text-muted-foreground">
                    {i.detail}
                    {i.durationSec !== null ? ` — ${formatCallDuration(i.durationSec)}` : ""}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function reportCsv(data: SalespersonAnalytics): (string | number)[][] {
  return [
    ["Date", "Calls", "Connected", "Not Connected", "Failed", "Talk Time", "Productive Time", "Unique Leads Called", "Interested", "Converted"],
    ...data.daily.map((d) => [
      d.date, d.calls, d.connected, d.notConnected, d.failed, formatDuration(d.talkTimeSec), formatMs(d.productiveMs), d.uniqueLeads, d.interested, d.converted,
    ]),
  ];
}

