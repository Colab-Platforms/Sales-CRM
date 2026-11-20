"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-client/client";
import { reportAutomationApi } from "@/lib/api-client/endpoints/report-automation.api";
import { cn } from "@/lib/utils";
import { formatInZone, STATUS_LABEL } from "./report-automation-form";
import { rangeText } from "./report-automation-schedule";
import { compareSnapshots, formatDelta, formatMetric, metricByKey, SECTION_SHORT, SNAPSHOT_METRICS } from "./report-snapshots";

// The summary columns of the list: the Shopify Orders Summary figures. A snapshot taken before them shows "-" (its other figures are in the details and the comparison).
const LIST_COLUMNS = [["sh_total", "Shopify orders"], ["sh_website", "Website"], ["sh_telecaller", "Telecaller"], ["sh_revenue", "Total revenue"]] as const;

const PAGE_SIZE = 10;

/** Previously generated reports: the figures each initial message carried, frozen when it was generated. Collapsed by default; loads only when opened. Pick two to compare them side by side. */
export function ReportSnapshotsPanel() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const q = useQuery({ queryKey: ["report-automation", "snapshots", page], queryFn: () => reportAutomationApi.snapshots(page, PAGE_SIZE), enabled: open, placeholderData: (prev) => prev });
  const items = q.data?.items ?? [];
  const pagination = q.data?.pagination;
  const chosen = picked.map((id) => items.find((i) => i.id === id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
  // earlier generation first, so the difference reads "what changed since"
  const [left, right] = [...chosen].sort((x, y) => Date.parse(x.generatedAt) - Date.parse(y.generatedAt));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1]!, id] : [...p, id]));

  return (
    <details className="group rounded-lg border bg-card" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="snapshots-section">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
        <span>Report snapshots</span>
        <span className="text-xs font-normal text-muted-foreground group-open:hidden">The exact figures each daily message carried</span>
      </summary>
      <div className="space-y-3 border-t px-4 py-3">
        <p className="text-xs text-muted-foreground">Each snapshot is frozen the moment the 09:00 message is generated and never changes, even when orders, cancellations or conversions change later. Tick two to compare them.</p>
        {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {q.error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(q.error, "Could not load the snapshots.")}</p> : null}
        {q.data && items.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="snapshots-empty">No report has been generated yet. The first snapshot is saved when the next daily message is built.</p> : null}

        {items.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <Table data-testid="snapshots-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"><span className="sr-only">Compare</span></TableHead>
                  <TableHead>Data date</TableHead>
                  <TableHead>Generated</TableHead>
                  {LIST_COLUMNS.map(([key, label]) => <TableHead key={key} className="text-right">{label}</TableHead>)}
                  <TableHead className="w-8"><span className="sr-only">Details</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => {
                  const isOpen = expanded === s.id;
                  return (
                    <Fragment key={s.id}>
                      <TableRow data-testid="snapshot-row" className={cn(isOpen && "bg-muted/40")}>
                        <TableCell><input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} aria-label={`Compare the report for ${s.reportDate}`} /></TableCell>
                        <TableCell className="whitespace-nowrap font-medium">{rangeText({ from: s.reportFrom, to: s.reportDate })}{s.kind === "TEST" ? <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">Test</span> : null}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{formatInZone(s.generatedAt, s.timezone)}</TableCell>
                        {LIST_COLUMNS.map(([key]) => { const m = metricByKey(key); return <TableCell key={key} className="text-right tabular-nums">{formatMetric(m.read(s), m.money, m.exact)}</TableCell>; })}
                        <TableCell><Button type="button" variant="ghost" size="icon-xs" aria-label={isOpen ? "Hide details" : "Show details"} aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : s.id)}>{isOpen ? <ChevronDown /> : <ChevronRight />}</Button></TableCell>
                      </TableRow>
                      {isOpen ? (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/30 p-3" data-testid="snapshot-detail">
                            <div className="grid gap-3 text-xs sm:grid-cols-2">
                              <div>
                                <p className="mb-1 font-medium">Figures as sent</p>
                                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
                                  {SNAPSHOT_METRICS.map((m) => <Fragment key={m.key}><dt className="text-muted-foreground">{SECTION_SHORT[m.section]} · {m.label}</dt><dd className="text-right tabular-nums">{formatMetric(m.read(s), m.money, m.exact)}</dd></Fragment>)}
                                </dl>
                              </div>
                              <div>
                                <p className="mb-1 font-medium">Delivery <span className="font-normal text-muted-foreground">(current status; the figures above never change)</span></p>
                                {s.deliveries.length === 0 ? <p className="text-muted-foreground">No recipients.</p> : (
                                  <ul className="space-y-1">
                                    {s.deliveries.map((d, i) => (
                                      <li key={i}>
                                        <span className="font-medium">{d.name || "Unnamed"}</span> <span className="font-mono text-muted-foreground">{d.phone}</span> · {STATUS_LABEL[d.status] ?? d.status}
                                        {d.providerMessageId ? <span className="block break-all text-[11px] text-muted-foreground">Message id {d.providerMessageId}</span> : null}
                                        {d.error ? <span className="block text-destructive">{d.error}</span> : null}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {left && right ? (
          <div className="rounded-md border" data-testid="snapshot-compare">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Figure</TableHead>
                  <TableHead className="text-right">{rangeText({ from: left.reportFrom, to: left.reportDate })} · {formatInZone(left.generatedAt, left.timezone)}</TableHead>
                  <TableHead className="text-right">{rangeText({ from: right.reportFrom, to: right.reportDate })} · {formatInZone(right.generatedAt, right.timezone)}</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {compareSnapshots(left, right).map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>{SECTION_SHORT[r.section]} · {r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMetric(r.left, r.money, r.exact)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMetric(r.right, r.money, r.exact)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", r.delta !== null && r.delta !== 0 && "font-medium")}>{formatDelta(r.delta, r.money, r.exact)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : picked.length === 1 ? <p className="text-xs text-muted-foreground">Tick one more report to compare.</p> : null}

        {pagination && pagination.totalItems > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{pagination.totalItems} reports · page {pagination.page} of {pagination.totalPages}</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => { setPage(page - 1); setPicked([]); setExpanded(null); }}>Previous</Button>
              <Button type="button" size="sm" variant="outline" disabled={page >= pagination.totalPages} onClick={() => { setPage(page + 1); setPicked([]); setExpanded(null); }}>Next</Button>
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
