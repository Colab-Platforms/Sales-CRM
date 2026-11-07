"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { getErrorMessage } from "@/lib/api-client/client";
import { ordersDashboardApi } from "@/lib/api-client/endpoints/orders-dashboard.api";
import { TELECALLER_CARDS, describeRange, telecallerCardValue, validateCustomRange, type RangeState } from "./orders-dashboard-form";

const STATUS_OPTIONS = ["ALL", "CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const;

/**
 * TELECALLER PERFORMANCE - orders credited to telecallers with the Reports' own rules (confirmed by a telecaller in the CRM, or placed within 7 days after a telecaller called / worked the customer).
 * This is NOT the same population as Website Orders (an order can be in both), so the two sections must not be added together. Read-only; the date range is the page's.
 */
export function TelecallerPanel({ range }: { range: RangeState }) {
  const [salespersonId, setSalespersonId] = useState("");
  const [paymentMode, setPaymentMode] = useState<"ALL" | "COD" | "PREPAID">("ALL");
  const [orderStatus, setOrderStatus] = useState<string>("ALL");
  const rangeInvalid = range.range === "custom" && Boolean(validateCustomRange(range.from, range.to));
  const query = { range: range.range, from: range.range === "custom" ? range.from : undefined, to: range.range === "custom" ? range.to : undefined, salespersonId, paymentMode, orderStatus };
  const data = useQuery({ queryKey: ["orders-dashboard", "telecaller", query], queryFn: () => ordersDashboardApi.telecaller(query), enabled: !rangeInvalid, placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const r = data.data;

  return (
    <section className="space-y-4" data-testid="telecaller-panel" aria-labelledby="telecaller-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="telecaller-heading" className="text-lg font-semibold">Telecaller Performance</h2>
          <p className="text-sm text-muted-foreground" data-testid="telecaller-note">
            Orders a telecaller confirmed in the CRM, plus orders the customer placed within 7 days after a telecaller called or worked them - the same rules as Reports. Not all website orders: an order can appear here and in Website Orders, so do not add the sections together.
          </p>
          {r ? <p className="text-xs text-muted-foreground">{describeRange(r.range)} · {r.range.timezone}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <NativeSelect size="sm" aria-label="Salesperson" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
            <option value="">All salespeople</option>
            {(r?.salespeople ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Payment type" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as "ALL" | "COD" | "PREPAID")}>
            <option value="ALL">All payments</option>
            <option value="COD">COD</option>
            <option value="PREPAID">Prepaid</option>
          </NativeSelect>
          <NativeSelect size="sm" aria-label="Order status" value={orderStatus} onChange={(e) => setOrderStatus(e.target.value)}>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s === "ALL" ? "All order statuses" : s.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</option>)}
          </NativeSelect>
        </div>
      </div>

      {rangeInvalid ? <p className="text-sm text-muted-foreground">Choose a valid date range above.</p> : null}
      {data.isError ? <p role="alert" className="text-sm text-red-700" data-testid="telecaller-error">Could not load Telecaller Performance: {getErrorMessage(data.error, "please retry")}</p> : null}
      {r && r.invalidAmounts > 0 ? <p role="alert" className="text-sm text-amber-700" data-testid="telecaller-incomplete">{r.invalidAmounts} order{r.invalidAmounts === 1 ? "" : "s"} had a missing or invalid amount and {r.invalidAmounts === 1 ? "is" : "are"} left out - these figures are incomplete.</p> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="telecaller-cards">
        {!r && data.isLoading ? <p className="col-span-full text-sm text-muted-foreground">Loading...</p> : null}
        {r || data.isError
          ? TELECALLER_CARDS.map((c) => (
              <Card key={c.id} data-testid={`telecaller-card-${c.id}`}>
                <CardHeader className="pb-1"><CardTitle className="text-sm font-medium text-muted-foreground">{c.label}</CardTitle></CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold tabular-nums">{telecallerCardValue(r?.summary, c)}</div>
                  {c.hint ? <p className="mt-1 text-xs text-muted-foreground">{c.hint}</p> : null}
                </CardContent>
              </Card>
            ))
          : null}
      </div>
      {r && r.summary.totalOrders > 0 ? <p className="text-xs text-muted-foreground" data-testid="telecaller-split">{r.summary.confirmedOrders} confirmed by a telecaller in the CRM · {r.summary.assistedOrders} bought after a telecaller&apos;s call</p> : null}
      {r && r.summary.totalOrders === 0 ? <p className="text-sm text-muted-foreground" data-testid="telecaller-empty">No telecaller-credited orders for these filters.</p> : null}
    </section>
  );
}
