"use client";

import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-client/client";
import type { ReportPreview } from "@/lib/api-client/types/report-automation.types";
import { excelStructure } from "./report-automation-schedule";

type Tab = "summary" | "detail" | "excel";
const TABS: [Tab, string][] = [["summary", "WhatsApp summary"], ["detail", "Detailed report"], ["excel", "Excel workbook"]];

/** Collapsed by default. The preview is only requested once the section is opened (the page owns the query so the telecaller list can share it). */
export function ReportPreviewPanel({ preview, onOpenChange, date, onDateChange, timezone, nextCovers }: { preview: UseQueryResult<ReportPreview>; onOpenChange: (open: boolean) => void; date: string; onDateChange: (d: string) => void; timezone: string; nextCovers?: string | null }) {
  const [tab, setTab] = useState<Tab>("summary");
  const d = preview.data;
  return (
    <details className="group rounded-lg border bg-card" onToggle={(e) => onOpenChange((e.currentTarget as HTMLDetailsElement).open)} data-testid="preview-section">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
        <span>Report preview</span>
        <span className="text-xs font-normal text-muted-foreground group-open:hidden">Summary, detailed report and Excel structure</span>
      </summary>
      <div className="space-y-3 border-t px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            Preview a different day (optional)
            <Input type="date" className="h-8 w-40" value={date} onChange={(e) => onDateChange(e.target.value)} />
          </label>
          <p className="pb-1 text-xs text-muted-foreground">{date ? "Showing just this day." : "Showing the saved report period."} Dates are in {timezone}.</p>
        </div>

        {preview.isLoading ? <p className="text-sm text-muted-foreground">Building preview…</p> : null}
        {preview.error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(preview.error, "Could not build the preview.")}</p> : null}

        {d ? (
          <>
            <p className="inline-flex items-center gap-2 rounded-md bg-primary/10 px-3 py-1.5 text-sm font-semibold" data-testid="preview-heading">
              Report data date: {d.periodLabel}
            </p>
            {nextCovers && !date ? <p className="text-xs text-muted-foreground" data-testid="preview-next-note">This is the report as it would be built right now. The next scheduled report covers {nextCovers}.</p> : null}
            <div className="flex gap-1 border-b" role="tablist">
              {TABS.map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{label}</button>
              ))}
            </div>

            {tab === "summary" ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">The short message sent first through the approved WhatsApp template.</p>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs" data-testid="preview-summary">{d.whatsappText}</pre>
              </div>
            ) : null}

            {tab === "detail" ? (
              <div className="space-y-3">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Telecaller</TableHead>
                        {d.options.sales ? <><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Cancelled</TableHead></> : null}
                        {d.options.leads ? <><TableHead className="text-right">Leads</TableHead><TableHead className="text-right">Converted</TableHead><TableHead className="text-right">Conv. %</TableHead></> : null}
                        {d.options.calls ? <><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Connected</TableHead></> : null}
                        {d.options.followUps ? <TableHead className="text-right">Follow-ups pending</TableHead> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...(d.options.teamSummary ? [{ id: "team", name: `Team (${d.data.team.telecallers})`, ...d.data.team }] : []), ...d.data.people].map((p) => (
                        <TableRow key={p.id} className={p.id === "team" ? "font-semibold" : undefined}>
                          <TableCell>{p.name}</TableCell>
                          {d.options.sales ? <><TableCell className="text-right">{p.orders}</TableCell><TableCell className="text-right">₹{Math.round(p.revenue).toLocaleString("en-IN")}</TableCell><TableCell className="text-right">{p.cancelledOrders}</TableCell></> : null}
                          {d.options.leads ? <><TableCell className="text-right">{p.leads}</TableCell><TableCell className="text-right">{p.converted}</TableCell><TableCell className="text-right">{p.conversionPct === null ? "-" : `${p.conversionPct}%`}</TableCell></> : null}
                          {d.options.calls ? <><TableCell className="text-right">{p.calls}</TableCell><TableCell className="text-right">{p.connected}</TableCell></> : null}
                          {d.options.followUps ? <TableCell className="text-right">{p.pendingFollowUps}</TableCell> : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs" data-testid="preview-text">{d.text}</pre>
                {d.truncated ? <p className="text-xs text-amber-600">The WhatsApp message is shortened: not every telecaller fits in one message. The Excel file has everyone.</p> : null}
                <p className="text-xs text-muted-foreground">Conversion = converted ÷ leads handed over that day. Orders follow the Sales &amp; Revenue rules (each order credited once).</p>
              </div>
            ) : null}

            {tab === "excel" ? (
              <div className="space-y-2" data-testid="preview-excel">
                <p className="text-xs text-muted-foreground">The workbook attached for {d.periodLabel}. Revenue is formatted as currency and times as h:mm:ss.</p>
                {excelStructure(d.options).map((s) => (
                  <div key={s.sheet} className="rounded-md border p-3">
                    <p className="text-sm font-medium">{s.sheet}</p>
                    <p className="mt-1 flex flex-wrap gap-1.5">{s.columns.map((c) => <span key={c} className="rounded bg-muted px-2 py-0.5 text-xs">{c}</span>)}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
