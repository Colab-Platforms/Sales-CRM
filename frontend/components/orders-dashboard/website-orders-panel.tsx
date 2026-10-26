"use client";

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-client/client";
import { ordersDashboardApi } from "@/lib/api-client/endpoints/orders-dashboard.api";
import type { DashboardFulfilmentFilter, DashboardPaymentFilter, OrdersDashboardQuery } from "@/lib/api-client/types/orders-dashboard.types";
import { MetricCard } from "./metric-card";
import { CARDS, CARD_ICONS, compareLabel, FULFILMENT_LABEL, PAYMENT_LABEL, cardLabel, cardValue, closeDetails, describeRange, formatInr, selectCard, validateCustomRange, websiteFeedWarning, withFilters, type RangeState } from "./orders-dashboard-form";

const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const titleCase = (v: string | null) => (v ? v.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "-");

/** DASHBOARD 1 - Website Orders: orders placed on the Shopify storefront (never telecaller-created orders). Cards only until one is clicked. */
export function WebsiteOrdersPanel({ range }: { range: RangeState }) {
  // the date range comes from the page; `own` is this dashboard's clicked card, search, filters and page
  const [own, setOwn] = useState<Pick<OrdersDashboardQuery, "metric" | "search" | "paymentStatus" | "fulfilment" | "page">>({ page: 1 });
  const [searchDraft, setSearchDraft] = useState("");
  const [exporting, setExporting] = useState(false);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const query: OrdersDashboardQuery = { ...range, scope: "WEBSITE", pageSize: 25, ...own };
  const rangeInvalid = range.range === "custom" && Boolean(validateCustomRange(range.from, range.to));

  const data = useQuery({
    queryKey: ["orders-dashboard", "website", query],
    queryFn: () => ordersDashboardApi.get(query),
    enabled: range.range !== "custom" || (Boolean(range.from && range.to) && !rangeInvalid),
    placeholderData: keepPreviousData,
  });

  const opened = Boolean(own.metric);
  useEffect(() => {
    if (opened) detailsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [opened]);

  const setQuery = (next: OrdersDashboardQuery) => setOwn({ metric: next.metric, search: next.search, paymentStatus: next.paymentStatus, fulfilment: next.fulfilment, page: next.page });
  // a failed load shows the error only - never the previous range's numbers as if they were this range's
  const r = data.error ? undefined : data.data;
  const d = r?.details ?? null;
  const rangeText = r ? describeRange(r.range) : "";
  const feedWarning = r ? websiteFeedWarning(r.freshness, fmtDate, { coverage: r.coverage, verification: r.verification }) : null;

  const doExport = async () => {
    setExporting(true);
    try {
      const file = await ordersDashboardApi.export(query);
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(file.truncated ? `Exported ${file.filename} (limited to the first 20,000 orders - narrow the date range)` : `Exported ${file.filename}`);
    } catch (e) {
      toast.error(getErrorMessage(e, "The export failed."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="space-y-4" data-testid="website-panel" aria-labelledby="website-heading">
      <div>
        <h2 id="website-heading" className="text-lg font-semibold">Website Orders</h2>
        <p className="text-xs text-muted-foreground">Orders customers placed on the Shopify store.</p>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="range-summary">
        {r ? <>Website orders created <strong>{rangeText}</strong> ({r.range.timezone}). Orders created by telecallers in the CRM are not included here.</> : "Loading website orders…"}
      </p>
      {r?.live ? (
        <div className="space-y-1" data-testid="live-source">
          <p className="text-xs text-muted-foreground">
            Live from Shopify, read {fmtDate(r.live.fetchedAt)} - {r.live.websiteOrders.toLocaleString("en-IN")} website orders{r.live.telecallerExcluded > 0 ? ` (${r.live.telecallerExcluded.toLocaleString("en-IN")} telecaller-created orders left out)` : ""}. Nothing is stored in the CRM.
          </p>
          {r.live.warnings.map((w) => (
            <p key={w} role="status" className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-700" data-testid="live-warning">{w}</p>
          ))}
        </div>
      ) : null}
      {feedWarning ? <p role="status" className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-700" data-testid="freshness-warning">{feedWarning}</p> : null}

      {data.error ? (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="dashboard-error">
          {getErrorMessage(data.error, "Could not load the dashboard.")}
          <Button type="button" size="sm" variant="outline" onClick={() => void data.refetch()}>Retry</Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="summary-cards">
        {!r && data.isLoading ? <p className="col-span-full text-sm text-muted-foreground">Loading…</p> : null}
        {r
          ? CARDS.map((c) => (
              <MetricCard
                key={c.key}
                testId={c.key.toLowerCase()}
                label={c.label}
                icon={CARD_ICONS[c.key]}
                value={cardValue(r.summary, c.key)}
                hint={c.key === "CANCELLED" && r.summary.cancelled > 0 ? `${formatInr(r.summary.cancelledValue)} value` : c.hint}
                selected={own.metric === c.key}
                onClick={() => setQuery(selectCard(query, c.key))}
                coverage={r.coverage}
                comparison={c.key === "TOTAL" ? r.comparison?.totalOrders : c.key === "VALUE" ? r.comparison?.totalValue : null}
                comparisonLabel={compareLabel(r.range.days)}
              />
            ))
          : null}
      </div>

      {own.metric ? (
        <div ref={detailsRef} className="scroll-mt-4" data-testid="order-details">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle data-testid="details-title">Website orders - {cardLabel(own.metric)} - {rangeText || "selected range"}</CardTitle>
                <Button type="button" size="sm" variant="ghost" onClick={() => { setSearchDraft(""); setQuery(closeDetails(query)); }} data-testid="close-details">
                  <X data-icon="inline-start" />
                  Close details
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  setQuery(withFilters(query, { search: searchDraft.trim() || undefined }));
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="od-search">Search order ID or customer</Label>
                  <Input id="od-search" className="w-64 max-w-full" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="#1234, name or phone" />
                </div>
                <Button type="submit" size="sm" variant="outline">Search</Button>
                {own.search ? <Button type="button" size="sm" variant="ghost" onClick={() => { setSearchDraft(""); setQuery(withFilters(query, { search: undefined })); }}>Clear</Button> : null}
                <div className="space-y-1">
                  <Label htmlFor="od-pay">Payment status</Label>
                  <NativeSelect id="od-pay" value={own.paymentStatus ?? ""} onChange={(e) => setQuery(withFilters(query, { paymentStatus: (e.target.value || undefined) as DashboardPaymentFilter | undefined }))}>
                    <option value="">All</option>
                    {(Object.keys(PAYMENT_LABEL) as DashboardPaymentFilter[]).map((k) => <option key={k} value={k}>{PAYMENT_LABEL[k]}</option>)}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="od-ful">Fulfilment</Label>
                  <NativeSelect id="od-ful" value={own.fulfilment ?? ""} onChange={(e) => setQuery(withFilters(query, { fulfilment: (e.target.value || undefined) as DashboardFulfilmentFilter | undefined }))}>
                    <option value="">All</option>
                    {(Object.keys(FULFILMENT_LABEL) as DashboardFulfilmentFilter[]).map((k) => <option key={k} value={k}>{FULFILMENT_LABEL[k]}</option>)}
                  </NativeSelect>
                </div>
                <Button type="button" size="sm" onClick={() => void doExport()} disabled={exporting || Boolean(data.error) || rangeInvalid} data-testid="export-orders">
                  <Download data-icon="inline-start" />
                  {exporting ? "Preparing…" : "Export to Excel"}
                </Button>
              </form>

              {!d && data.isFetching ? <p className="text-sm text-muted-foreground" data-testid="details-loading">Loading orders…</p> : null}
              {d && data.isFetching ? <p className="text-xs text-muted-foreground">Updating…</p> : null}
              {d && d.items.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-state">No website orders match {cardLabel(own.metric)} for this date range and these filters.</p> : null}
              {d && d.items.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order ID</TableHead><TableHead>Order date</TableHead><TableHead>Customer</TableHead><TableHead>Phone</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Payment</TableHead><TableHead>Payment status</TableHead><TableHead>Fulfilment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.items.map((o) => (
                        <TableRow key={o.id} data-testid="order-row">
                          <TableCell className="font-medium">{o.orderId}</TableCell>
                          <TableCell>{fmtDate(o.orderDate)}</TableCell>
                          <TableCell>{o.customerName}</TableCell>
                          <TableCell>{o.phone ?? "-"}</TableCell>
                          <TableCell className="text-right">{formatInr(o.totalAmount)}</TableCell>
                          <TableCell>{o.paymentMethod ?? "-"}</TableCell>
                          <TableCell>{titleCase(o.paymentStatus ?? "NO_PAYMENT")}</TableCell>
                          <TableCell>{titleCase(o.fulfilmentStatus)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
              {d && d.pagination.totalItems > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="pagination">
                  <span className="text-muted-foreground">
                    {(d.pagination.page - 1) * d.pagination.pageSize + 1}-{Math.min(d.pagination.page * d.pagination.pageSize, d.pagination.totalItems)} of {d.pagination.totalItems}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={d.pagination.page <= 1} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Previous</Button>
                    <span>Page {d.pagination.page} of {d.pagination.totalPages}</span>
                    <Button type="button" size="sm" variant="outline" disabled={d.pagination.page >= d.pagination.totalPages} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Next</Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </section>
  );
}
