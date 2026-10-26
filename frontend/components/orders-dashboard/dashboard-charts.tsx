"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/api-client/client";
import { dashboardChartsApi } from "@/lib/api-client/endpoints/orders-dashboard.api";
import type { ChartInterval, Coverage } from "@/lib/api-client/types/orders-dashboard.types";
import { ComboChart, type ComboPoint } from "./combo-chart";
import { describeRange, formatInr, validateCustomRange, type RangeState } from "./orders-dashboard-form";

const INTERVAL_LABEL: Record<ChartInterval, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

function IntervalSelector({ value, onChange }: { value: ChartInterval; onChange: (i: ChartInterval) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Chart interval">
      {(["daily", "weekly", "monthly"] as const).map((i) => (
        <Button key={i} type="button" size="sm" variant={value === i ? "default" : "outline"} className={value === i ? "bg-emerald-600 text-white hover:bg-emerald-700" : ""} aria-pressed={value === i} onClick={() => onChange(i)} data-testid={`interval-${i}`}>
          {INTERVAL_LABEL[i]}
        </Button>
      ))}
    </div>
  );
}

function CoverageNote({ coverage, what }: { coverage: Coverage; what: string }) {
  if (coverage === "FULL") return null;
  return (
    <p role="status" className="text-xs text-amber-700" data-testid="chart-coverage-note">
      {coverage === "NONE" ? `The CRM holds no ${what} for this period, so there is nothing to chart - the hatched marks are missing data, not zero.` : `The CRM holds ${what} for only part of this period: the hatched marks are periods with no data (not zero) and faded bars are incomplete.`}
    </p>
  );
}

interface ChartCardProps {
  range: RangeState;
  testId: string;
}

/** Orders & Revenue for WEBSITE orders: green bars = orders placed, dark line = order value (excluding cancelled), per day / week / month for the selected range. */
export function OrdersRevenueChart({ range, testId }: ChartCardProps) {
  const [interval, setInterval] = useState<ChartInterval>("daily");
  const invalid = range.range === "custom" && Boolean(validateCustomRange(range.from, range.to));
  const q = useQuery({
    queryKey: ["orders-dashboard", "chart", "orders", range, interval],
    queryFn: () => dashboardChartsApi.orders(range, interval),
    enabled: range.range !== "custom" || (Boolean(range.from && range.to) && !invalid),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const points: ComboPoint[] = (d?.buckets ?? []).map((b) => ({ key: b.key, from: b.from, to: b.to, bar: b.orders, line: b.revenue, available: b.available, partial: b.partial }));
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Orders &amp; Revenue</CardTitle>
          <p className="text-xs text-muted-foreground" data-testid="chart-subtitle">{d ? `Website orders, ${describeRange(d.range)} (${d.range.timezone})` : "Website orders"}</p>
        </div>
        <IntervalSelector value={interval} onChange={setInterval} />
      </CardHeader>
      <CardContent className="space-y-3">
        {q.error ? <p role="alert" className="text-sm text-destructive" data-testid="chart-error">{getErrorMessage(q.error, "Could not load the chart.")} <Button type="button" size="sm" variant="outline" onClick={() => void q.refetch()}>Retry</Button></p> : null}
        {!d && q.isLoading ? <p className="text-sm text-muted-foreground" data-testid="chart-loading">Loading chart…</p> : null}
        {d ? (
          <>
            <p className="text-sm" data-testid="chart-totals">
              <strong>{d.totals.orders}</strong> orders, <strong>{formatInr(d.totals.revenue)}</strong> order value in this period{d.coverage === "FULL" ? "" : " (data incomplete)"}
            </p>
            <CoverageNote coverage={d.coverage} what="website orders" />
            <ComboChart points={points} interval={d.interval} barLabel="Orders" lineLabel="Order value (excl. cancelled)" formatLine={formatInr} summary={`Orders and order value per ${d.interval.replace("ly", "")} for ${describeRange(d.range)}: ${d.totals.orders} orders, ${formatInr(d.totals.revenue)}`} testId="orders-chart" />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Abandoned checkouts trend: green bars = checkouts abandoned (recovered carts excluded), dark line = value of the carts still open. */
export function AbandonedTrendChart({ range, testId }: ChartCardProps) {
  const [interval, setInterval] = useState<ChartInterval>("daily");
  const invalid = range.range === "custom" && Boolean(validateCustomRange(range.from, range.to));
  const q = useQuery({
    queryKey: ["orders-dashboard", "chart", "abandoned", range, interval],
    queryFn: () => dashboardChartsApi.abandoned(range, interval),
    enabled: range.range !== "custom" || (Boolean(range.from && range.to) && !invalid),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const points: ComboPoint[] = (d?.buckets ?? []).map((b) => ({ key: b.key, from: b.from, to: b.to, bar: b.abandoned, line: b.openValue, available: b.available, partial: b.partial }));
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Abandoned Checkouts trend</CardTitle>
          <p className="text-xs text-muted-foreground">{d ? `${describeRange(d.range)} (${d.range.timezone}), by the time each checkout was detected` : "Abandoned checkouts"}</p>
        </div>
        <IntervalSelector value={interval} onChange={setInterval} />
      </CardHeader>
      <CardContent className="space-y-3">
        {q.error ? <p role="alert" className="text-sm text-destructive" data-testid="chart-error">{getErrorMessage(q.error, "Could not load the chart.")} <Button type="button" size="sm" variant="outline" onClick={() => void q.refetch()}>Retry</Button></p> : null}
        {!d && q.isLoading ? <p className="text-sm text-muted-foreground" data-testid="chart-loading">Loading chart…</p> : null}
        {d ? (
          <>
            <p className="text-sm" data-testid="chart-totals">
              <strong>{d.totals.abandoned}</strong> abandoned checkouts, <strong>{formatInr(d.totals.openValue)}</strong> still open{d.coverage === "FULL" ? "" : " (data incomplete)"}
            </p>
            <CoverageNote coverage={d.coverage} what="abandoned checkouts" />
            <ComboChart points={points} interval={d.interval} barLabel="Abandoned checkouts" lineLabel="Open cart value" formatLine={formatInr} summary={`Abandoned checkouts and open cart value for ${describeRange(d.range)}: ${d.totals.abandoned} checkouts, ${formatInr(d.totals.openValue)}`} testId="abandoned-chart" />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
