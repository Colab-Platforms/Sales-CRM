"use client";

import { formatDay, formatNumber, formatRupees, formatRupeesCompact } from "@/lib/manager-analytics";
import type { ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { GroupedBarChart, seriesColor } from "./svg-charts";
import { EmptyState, Panel } from "./panel";

/** Order value per day for the report's Sales section. Hover a day for its exact value and order count. */
export function RevenuePerDayPanel({ data }: { data: ManagerAnalytics }) {
  return (
    <Panel title="Revenue per Day" description="Order value net of refunds, by the day the order was confirmed (India time).">
      {data.kpis.orders === 0 ? (
        <EmptyState>No orders were closed in this period. Try a longer date range.</EmptyState>
      ) : (
        <GroupedBarChart
          labels={data.daily.map((d) => formatDay(d.date))}
          tooltipTitles={data.daily.map((d) => `${formatDay(d.date, "weekday")} · ${formatNumber(d.orders)} ${d.orders === 1 ? "order" : "orders"}`)}
          format={formatRupees}
          axisFormat={formatRupeesCompact}
          height={220}
          series={[{ key: "revenue", label: "Revenue", values: data.daily.map((d) => d.revenue), colorClass: seriesColor(5) }]}
        />
      )}
    </Panel>
  );
}
