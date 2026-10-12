"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { managerAnalyticsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import type { ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { getErrorMessage } from "@/lib/api-client/client";
import { Skeleton } from "@/components/ui/skeleton";
import {
  callsPerProductiveHour,
  defaultFilters,
  exportCsv,
  filtersToSearch,
  formatMs,
  formatNumber,
  formatPct,
  overviewCsvRows,
  pct,
  RANGE_LABELS,
  rangeLabel,
  toQuery,
  type DashboardFilters,
} from "@/lib/manager-analytics";
import { FilterBar } from "./filters";
import { KpiCard } from "./kpi-card";
import { LeadFunnel } from "./lead-funnel";
import { LeadDistributionChart } from "./lead-distribution-chart";
import { SalespersonPerformanceTable } from "./salesperson-table";
import { DailyCallPerformance } from "./daily-calls";
import { TeamProductivityChart } from "./team-productivity";
import { ConversionPerformanceChart } from "./conversion-chart";
import { ProductivityVsResults } from "./productivity-vs-results";
import { CallOutcomesDonut, CallTrendsPanel, LeadStageDonut, SalespersonTrendLines } from "./trends";
import { PerformanceInsights } from "./performance-insights";

export function DashboardHeader({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </header>
  );
}

export function ManagerSalesDashboard() {
  const router = useRouter();
  const [filters, setFilters] = useState<DashboardFilters>(defaultFilters);
  const patch = useCallback((p: Partial<DashboardFilters>) => setFilters((f) => ({ ...f, ...p })), []);

  const query = toQuery(filters);
  const { data, isPending, error, isPlaceholderData } = useQuery(managerAnalyticsQueryOptions(query));

  const openSalesperson = (id: string) => router.push(`/dashboard/salespersons/${id}?${filtersToSearch(filters)}`);
  const period = filters.preset === "custom" ? "in this period" : RANGE_LABELS[filters.preset].toLowerCase();

  return (
    <div className="space-y-6">
      <DashboardHeader title="Sales Dashboard" subtitle="Monitor team performance, lead activity and sales productivity.">
        <FilterBar
          filters={filters}
          onChange={patch}
          people={data?.team ?? []}
          onExport={data ? () => exportCsv(`sales-report-${data.range.from}_${data.range.to}.csv`, overviewCsvRows(data)) : undefined}
        />
      </DashboardHeader>

      {isPending ? (
        <DashboardSkeleton />
      ) : error || !data ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load the sales dashboard.")}
        </div>
      ) : (
        <div className={isPlaceholderData ? "space-y-6 opacity-60 transition-opacity" : "space-y-6 transition-opacity"} aria-busy={isPlaceholderData}>
          <p className="text-xs text-muted-foreground">
            Showing {rangeLabel(data.range.from, data.range.to)} · {data.range.days} {data.range.days === 1 ? "day" : "days"}
          </p>

          <Kpis data={data} />

          <div className="grid gap-6 xl:grid-cols-2">
            <LeadFunnel
              total={data.kpis.totalLeads}
              notContacted={data.kpis.notContacted}
              contacted={data.kpis.contacted}
              interested={data.kpis.interested}
              converted={data.kpis.converted}
            />
            <LeadDistributionChart people={data.salespeople} onOpen={openSalesperson} />
          </div>

          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <CallTrendsPanel daily={data.daily} />
            <div className="grid gap-6">
              <CallOutcomesDonut kpis={data.kpis} />
            </div>
          </div>

          <SalespersonPerformanceTable
            people={data.salespeople}
            targetPercent={data.targets.conversionRatePercent}
            onOpen={openSalesperson}
          />

          <DailyCallPerformance data={data} filters={filters} onFiltersChange={patch} />
          <TeamProductivityChart data={data} />

          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            {data.salespeople.length > 1 ? <SalespersonTrendLines data={data} /> : <div />}
            <LeadStageDonut kpis={data.kpis} />
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <ConversionPerformanceChart
              people={data.salespeople}
              targetPercent={data.targets.conversionRatePercent}
              onOpen={openSalesperson}
            />
            <PerformanceInsights data={data} periodLabel={period} />
          </div>

          <ProductivityVsResults people={data.salespeople} onOpen={openSalesperson} />
        </div>
      )}
    </div>
  );
}

function Kpis({ data }: { data: ManagerAnalytics }) {
  const k = data.kpis;
  const callsSpark = data.daily.map((d) => d.calls);
  const prodSpark = data.daily.map((d) => d.productiveMs);
  const interestedSpark = data.daily.map((d) => d.interested);
  const convertedSpark = data.daily.map((d) => d.converted);
  const delta = k.previousTotalLeads > 0 ? ((k.totalLeads - k.previousTotalLeads) / k.previousTotalLeads) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
      <KpiCard
        label="Total Leads" tone="blue"
        value={formatNumber(k.totalLeads)}
        accent
        lines={[
          delta === null
            ? { text: "No previous period data" }
            : { text: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% vs previous period`, tone: delta >= 0 ? "positive" : "negative" },
          { text: "100% of total leads" },
        ]}
      />
      <KpiCard label="Not Contacted" tone="slate" value={formatNumber(k.notContacted)} lines={[{ text: `${formatPct(pct(k.notContacted, k.totalLeads))} of total leads` }]} />
      <KpiCard label="Contacted" tone="teal" value={formatNumber(k.contacted)} lines={[{ text: `${formatPct(pct(k.contacted, k.totalLeads))} of total leads` }]} />
      <KpiCard label="Interested" tone="amber" spark={interestedSpark} value={formatNumber(k.interested)} lines={[{ text: `${formatPct(pct(k.interested, k.contacted))} of contacted leads` }]} />
      <KpiCard label="Converted" tone="emerald" spark={convertedSpark} value={formatNumber(k.converted)} lines={[{ text: `${formatPct(pct(k.converted, k.totalLeads))} conversion rate` }]} />
      <KpiCard
        label="Calls Made" tone="violet"
        spark={callsSpark}
        value={formatNumber(k.callsMade)}
        lines={[
          { text: `Average ${formatNumber(Math.round(k.callsMade / Math.max(1, data.range.days)))} calls/day` },
          { text: `${formatNumber(k.uniqueLeadsContacted)} unique leads called` },
        ]}
      />
      <KpiCard
        label="Productivity" tone="blue"
        spark={prodSpark}
        value={formatMs(k.productiveMs)}
        lines={[
          { text: "Total productive time" },
          { text: `${callsPerProductiveHour(k.callsMade, k.productiveMs).toFixed(1)} calls / productive hour` },
        ]}
      />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}
