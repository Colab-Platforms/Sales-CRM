"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Ban, ChartColumnIncreasing, CircleCheck, Clock, Phone, PhoneCall, UserRound, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { managerAnalyticsQueryOptions } from "@/lib/api-client/queries/manager.queries";
import { managerAnalyticsApi } from "@/lib/api-client/endpoints/manager.api";
import type { ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { getErrorMessage } from "@/lib/api-client/client";
import { Skeleton } from "@/components/ui/skeleton";
import {
  callsPerProductiveHour,
  defaultFilters,
  filtersToSearch,
  formatMs,
  formatNumber,
  formatPct,
  pct,
  periodChange,
  formatRupees,
  RANGE_LABELS,
  rangeLabel,
  toQuery,
  type DashboardFilters,
} from "@/lib/manager-analytics";
import { exportReportXlsx } from "@/lib/report-xlsx";
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
import { RevenuePerDayPanel } from "./sales-revenue";
import { SectionHeading } from "./panel";
import { ProductSalesTable, SalesSummaryTiles, SalespersonOrdersTable } from "./sales-report";

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

/**
 * "overview" is the manager's home: headline KPIs and team-level charts.
 * "report" is the Reports page: sales, team performance and call activity in detail, built for comparing and exporting.
 */
export function ManagerSalesDashboard({
  view = "overview",
  title = "Sales Dashboard",
  subtitle = "Monitor team performance, lead activity and sales productivity.",
}: { view?: "overview" | "report"; title?: string; subtitle?: string } = {}) {
  const router = useRouter();
  const [filters, setFilters] = useState<DashboardFilters>(defaultFilters);
  const patch = useCallback((p: Partial<DashboardFilters>) => setFilters((f) => ({ ...f, ...p })), []);

  const query = toQuery(filters);
  const { data, isPending, error, isPlaceholderData, dataUpdatedAt } = useQuery(managerAnalyticsQueryOptions(query));

  const [exporting, setExporting] = useState(false);
  const runExport = async (make: () => Promise<void>) => {
    setExporting(true);
    try {
      await make();
    } catch (e) {
      toast.error(getErrorMessage(e, "The export could not be created. Please try again."));
    } finally {
      setExporting(false);
    }
  };
  const exportOptions =
    data && view === "report"
      ? [
          {
            label: "Report workbook (.xlsx)",
            hint: "Summary, salespeople, products and daily sheets",
            onSelect: () => void runExport(() => exportReportXlsx(`sales-report-${data.range.from}_${data.range.to}.xlsx`, data, filters)),
          },
          {
            label: "All orders (.csv)",
            hint: "One row per order matching the filters",
            onSelect: () =>
              void runExport(async () => {
                const url = URL.createObjectURL(await managerAnalyticsApi.salesOrdersCsv(query));
                const a = document.createElement("a");
                a.href = url;
                a.download = `sales-orders-${data.range.from}_${data.range.to}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }),
          },
        ]
      : undefined;

  const openSalesperson = (id: string) => router.push(`/dashboard/salespersons/${id}?${filtersToSearch(filters)}`);
  const period = filters.preset === "custom" || filters.preset === "single" ? "in this period" : RANGE_LABELS[filters.preset].toLowerCase();

  return (
    <div className="space-y-6">
      <DashboardHeader title={title} subtitle={subtitle}>
        <FilterBar
          filters={filters}
          onChange={patch}
          people={data?.team ?? []}
          variant={view === "report" ? "report" : "activity"}
          exportOptions={exportOptions}
          exporting={exporting}
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
            {dataUpdatedAt ? <> · updated {new Date(dataUpdatedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}, refreshes every minute</> : null}
          </p>

          {view === "overview" ? (
            <>
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

              <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
                <PerformanceInsights data={data} periodLabel={period} />
                <LeadStageDonut kpis={data.kpis} />
              </div>

              <div className="flex justify-end">
                <Link href="/dashboard/reports" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                  View detailed reports <ArrowRight className="size-4" />
                </Link>
              </div>
            </>
          ) : (
            <>
              <section className="space-y-4" aria-label="Sales">
                <SectionHeading
                  title="Sales"
                  description="Orders a telecaller confirmed in the CRM, plus orders customers placed within 7 days after a telecaller called or worked them. Payment and order-status filters apply here."
                />
                <SalesSummaryTiles data={data} />
                <RevenuePerDayPanel data={data} />
                <SalespersonOrdersTable data={data} onOpen={openSalesperson} />
                <ProductSalesTable data={data} onOpen={openSalesperson} />
              </section>

              <section className="space-y-4 pt-2" aria-label="Team performance">
                <SectionHeading title="Team Performance" description="Leads, conversion and productivity for each salesperson." />
                <SalespersonPerformanceTable
                  people={data.salespeople}
                  targetPercent={data.targets.conversionRatePercent}
                  onOpen={openSalesperson}
                />
                <div className="grid gap-6 xl:grid-cols-2">
                  <ConversionPerformanceChart
                    people={data.salespeople}
                    targetPercent={data.targets.conversionRatePercent}
                    onOpen={openSalesperson}
                  />
                  <ProductivityVsResults people={data.salespeople} onOpen={openSalesperson} />
                </div>
              </section>

              <section className="space-y-4 pt-2" aria-label="Call activity">
                <SectionHeading title="Call Activity" description="Calls and productive time day by day. The call-status filter applies here." />
                <DailyCallPerformance data={data} filters={filters} onFiltersChange={patch} />
                <div className="grid gap-6 xl:grid-cols-2">
                  <TeamProductivityChart data={data} />
                  {data.salespeople.length > 1 ? <SalespersonTrendLines data={data} /> : null}
                </div>
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Kpis({ data }: { data: ManagerAnalytics }) {
  const k = data.kpis;
  const callsSpark = data.daily.map((d) => d.calls);
  const prodSpark = data.daily.map((d) => d.productiveMs);
  const convertedSpark = data.daily.map((d) => d.converted);
  const delta = k.previousTotalLeads > 0 ? ((k.totalLeads - k.previousTotalLeads) / k.previousTotalLeads) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
      <KpiCard
        label="Total Leads" tone="blue" icon={Users}
        value={formatNumber(k.totalLeads)}
        accent
        lines={[
          delta === null
            ? { text: "No previous period data" }
            : { text: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% vs previous period`, tone: delta >= 0 ? "positive" : "negative" },
          ...(k.totalLeads > 0 ? [{ text: "100% of total leads" }] : [{ text: "No leads assigned in this period" }]),
        ]}
      />
      <KpiCard label="Not Contacted" tone="slate" icon={Ban} value={formatNumber(k.notContacted)} lines={[{ text: `${formatPct(pct(k.notContacted, k.totalLeads))} of total leads` }]} />
      <KpiCard label="Contacted" tone="teal" icon={Phone} value={formatNumber(k.contacted)} lines={[{ text: `${formatPct(pct(k.contacted, k.totalLeads))} of total leads` }]} />
      <KpiCard label="Interested" tone="amber" icon={UserRound} value={formatNumber(k.interested)} lines={[{ text: `${formatPct(pct(k.interested, k.contacted))} of contacted leads` }]} />
      <KpiCard label="Converted" tone="emerald" icon={CircleCheck} spark={convertedSpark} value={formatNumber(k.converted)} lines={[{ text: `${formatPct(pct(k.converted, k.totalLeads))} conversion rate` }]} />
      <KpiCard
        label="Calls Made" tone="violet" icon={PhoneCall}
        spark={callsSpark}
        value={formatNumber(k.callsMade)}
        lines={[
          { text: `Average ${formatNumber(Math.round(k.callsMade / Math.max(1, data.range.days)))} calls/day` },
          { text: `${formatNumber(k.uniqueLeadsContacted)} unique leads called` },
        ]}
      />
      <KpiCard
        label="Productivity" tone="blue" icon={Clock}
        spark={prodSpark}
        value={formatMs(k.productiveMs)}
        lines={[
          { text: "Total productive time" },
          { text: `${callsPerProductiveHour(k.callsMade, k.productiveMs).toFixed(1)} calls / productive hour` },
        ]}
      />
      <KpiCard
        label="Revenue" tone="blue" icon={ChartColumnIncreasing}
        value={formatRupees(k.revenue)}
        lines={[periodChange(k.revenue, k.previousRevenue)]}
      />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-[6px]" />
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
