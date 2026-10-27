"use client";

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, ExternalLink, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonedDashboardApi } from "@/lib/api-client/endpoints/orders-dashboard.api";
import type { AbandonedQuery } from "@/lib/api-client/types/orders-dashboard.types";
import { ABANDONED_CARDS, ABANDONED_ICONS, CONVERSION_CARDS, CONVERSION_ICONS, FOLLOW_UP_LABEL, abandonedCardLabel, isOrderBreakdown, conversionCardHint, conversionCardValue, abandonedCardValue, abandonedSearch, closeAbandonedDetails, selectAbandonedCard } from "./abandoned-dashboard-form";
import { MetricCard } from "./metric-card";
import { compareLabel, describeRange, formatInr, validateCustomRange, type RangeState } from "./orders-dashboard-form";

const titleCase = (v: string) => v.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

/** DASHBOARD 2 - Abandoned Checkouts: customers who started checkout and did not buy, from the CRM's saved abandon-cart events (Shiprocket Checkout / Fastrr). Cards only until one is clicked. */
export function AbandonedPanel({ range }: { range: RangeState }) {
  const [own, setOwn] = useState<Pick<AbandonedQuery, "metric" | "search" | "page">>({ page: 1 });
  const [searchDraft, setSearchDraft] = useState("");
  const [exporting, setExporting] = useState(false);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const query: AbandonedQuery = { ...range, pageSize: 25, ...own };
  const rangeInvalid = range.range === "custom" && Boolean(validateCustomRange(range.from, range.to));

  const data = useQuery({
    queryKey: ["orders-dashboard", "abandoned", query],
    queryFn: () => abandonedDashboardApi.get(query),
    enabled: range.range !== "custom" || (Boolean(range.from && range.to) && !rangeInvalid),
    placeholderData: keepPreviousData,
  });

  const opened = Boolean(own.metric);
  useEffect(() => {
    if (opened) detailsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [opened]);

  const setQuery = (next: AbandonedQuery) => setOwn({ metric: next.metric, search: next.search, page: next.page });
  const r = data.data;
  const d = r?.details ?? null;
  const rangeText = r ? describeRange(r.range) : "";

  const doExport = async () => {
    setExporting(true);
    try {
      const file = await abandonedDashboardApi.export(query);
      const url = URL.createObjectURL(file.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(file.truncated ? `Exported ${file.filename} (limited to the first 20,000 - narrow the date range)` : `Exported ${file.filename}`);
    } catch (e) {
      toast.error(getErrorMessage(e, "The export failed."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="space-y-4" data-testid="abandoned-panel" aria-labelledby="abandoned-heading">
      <div>
        <h2 id="abandoned-heading" className="text-lg font-semibold">Abandoned Checkouts</h2>
        <p className="text-xs text-muted-foreground">Customers who started checkout and did not buy.</p>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="range-summary">
        {r ? <>Checkouts abandoned <strong>{rangeText}</strong> ({r.range.timezone}), by the time the checkout was detected.</> : "Loading abandoned checkouts…"}
      </p>
      {r ? (
        <p className="text-xs text-muted-foreground" data-testid="abandoned-source">
          Source: {r.source.name}. {r.source.paymentModeAvailable ? "" : "These events do not say whether the customer chose COD or prepaid, so there is no COD / prepaid card."} A cart that was later bought is shown as Recovered and is not counted as abandoned. A Manager sees the checkouts assigned to them.
        </p>
      ) : null}

      {r && r.coverage !== "FULL" ? (
        <p role="status" className="rounded-md border border-amber-500/40 p-3 text-xs text-amber-700" data-testid="coverage-warning">
          {r.coverage === "NONE" ? "The CRM holds no abandoned checkouts for this period (they are recorded only from the first one it received), so these cards show no data rather than zero." : "The CRM holds abandoned checkouts for only part of this period, so these numbers are incomplete."}
        </p>
      ) : null}

      {data.error ? (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="dashboard-error">
          {getErrorMessage(data.error, "Could not load the abandoned checkouts.")}
          <Button type="button" size="sm" variant="outline" onClick={() => void data.refetch()}>Retry</Button>
        </div>
      ) : null}

      <p className="text-sm font-medium" data-testid="conversion-heading">Conversion and revenue (actual orders from checkouts, not cart value)</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6" data-testid="conversion-cards">
        {r
          ? CONVERSION_CARDS.map((c) => (
              <MetricCard
                key={c.key}
                testId={`conv-${c.key.toLowerCase()}`}
                label={c.label}
                icon={CONVERSION_ICONS[c.key]}
                value={conversionCardValue(r.summary, c.key)}
                hint={conversionCardHint(r.summary, c.key)}
                selected={c.metric !== undefined && own.metric === c.metric}
                onClick={() => (c.metric ? setQuery(selectAbandonedCard(query, c.metric)) : undefined)}
                coverage={r.coverage}
              />
            ))
          : null}
      </div>

      <p className="text-sm font-medium" data-testid="open-heading">Still-open checkouts (potential, not yet won)</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="summary-cards">
        {!r && data.isLoading ? <p className="col-span-full text-sm text-muted-foreground">Loading…</p> : null}
        {r
          ? ABANDONED_CARDS.map((c) => (
              <MetricCard
                key={c.key}
                testId={c.key.toLowerCase()}
                label={c.label}
                icon={ABANDONED_ICONS[c.key]}
                value={abandonedCardValue(r.summary, c.key)}
                hint={c.key === "VALUE" && (r.summary.openWithoutValue > 0 || r.summary.openOtherCurrency > 0) ? `${c.hint}. ${r.summary.openWithoutValue} without a value, ${r.summary.openOtherCurrency} non-INR not summed` : c.hint}
                selected={own.metric === c.key}
                onClick={() => setQuery(selectAbandonedCard(query, c.key))}
                coverage={r.coverage}
                comparison={c.key === "TOTAL" ? r.comparison?.totalAbandoned : null}
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
                <CardTitle data-testid="details-title">Abandoned checkouts - {abandonedCardLabel(own.metric)} - {rangeText || "selected range"}</CardTitle>
                <Button type="button" size="sm" variant="ghost" onClick={() => { setSearchDraft(""); setQuery(closeAbandonedDetails(query)); }} data-testid="close-details">
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
                  setQuery(abandonedSearch(query, searchDraft.trim() || undefined));
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="ab-search">Search customer, phone or email</Label>
                  <Input id="ab-search" className="w-64 max-w-full" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} />
                </div>
                <Button type="submit" size="sm" variant="outline">Search</Button>
                {own.search ? <Button type="button" size="sm" variant="ghost" onClick={() => { setSearchDraft(""); setQuery(abandonedSearch(query, undefined)); }}>Clear</Button> : null}
                <Button type="button" size="sm" onClick={() => void doExport()} disabled={exporting || Boolean(data.error) || rangeInvalid} data-testid="export-orders">
                  <Download data-icon="inline-start" />
                  {exporting ? "Preparing…" : "Export to Excel"}
                </Button>
              </form>

              {!d && data.isFetching ? <p className="text-sm text-muted-foreground" data-testid="details-loading">Loading checkouts…</p> : null}
              {d && data.isFetching ? <p className="text-xs text-muted-foreground">Updating…</p> : null}
              {d && d.items.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-state">No abandoned checkouts match {abandonedCardLabel(own.metric)} for this date range{own.search ? " and search" : ""}.</p> : null}
              {d && d.items.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Checkout date</TableHead><TableHead>Customer</TableHead><TableHead>Contact</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Items</TableHead><TableHead>Checkout link</TableHead><TableHead>Follow-up</TableHead><TableHead>Assigned to</TableHead>{own.metric && isOrderBreakdown(own.metric) ? <><TableHead>Order</TableHead><TableHead>Payment</TableHead><TableHead>Order status</TableHead><TableHead className="text-right">Order value</TableHead><TableHead>Telecaller</TableHead></> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.items.map((o) => (
                        <TableRow key={o.id} data-testid="order-row">
                          <TableCell>{fmtDate(o.checkoutDate)}</TableCell>
                          <TableCell className="font-medium">{o.customerName}</TableCell>
                          <TableCell className="text-xs">{o.phone ?? "-"}{o.email ? <><br />{o.email}</> : null}</TableCell>
                          <TableCell className="text-right">{o.amount === null ? "-" : o.currency && o.currency.toUpperCase() !== "INR" ? `${o.currency} ${o.amount}` : formatInr(o.amount)}</TableCell>
                          <TableCell className="max-w-[14rem] whitespace-normal text-xs">{o.items.length > 0 ? o.items.join(", ") : "-"}{o.itemCount && o.itemCount > o.items.length ? ` +${o.itemCount - o.items.length}` : ""}</TableCell>
                          <TableCell>{o.checkoutLink ? <a className="inline-flex items-center gap-1 text-primary underline" href={o.checkoutLink} target="_blank" rel="noreferrer noopener">Open<ExternalLink className="size-3" /></a> : "-"}</TableCell>
                          <TableCell className="text-xs">
                            <span className={o.followUp === "PENDING" ? "text-amber-600" : o.followUp === "DONE" ? "text-emerald-600" : ""}>{FOLLOW_UP_LABEL[o.followUp]}</span>
                            {o.lastAction ? <><br />{o.lastAction.type.toLowerCase()} - {o.lastAction.status.toLowerCase()}</> : null}
                          </TableCell>
                          <TableCell>{o.assignedTo ?? "-"}</TableCell>
                          {own.metric && isOrderBreakdown(own.metric) ? (
                            <>
                              <TableCell className="font-medium" data-testid="linked-order">{o.order?.orderNumber ?? "-"}</TableCell>
                              <TableCell className="text-xs">{o.order ? `${o.order.mode === "COD" ? "COD" : "Prepaid"} - ${o.order.paymentStatus ? titleCase(o.order.paymentStatus) : "no payment"}` : "-"}</TableCell>
                              <TableCell>{o.order ? titleCase(o.order.status) : "-"}</TableCell>
                              <TableCell className="text-right">{o.order ? formatInr(o.order.amount) : "-"}</TableCell>
                              <TableCell>{o.order?.telecaller ?? "-"}</TableCell>
                            </>
                          ) : null}
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
