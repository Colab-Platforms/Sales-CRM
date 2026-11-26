"use client";

import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-client/client";
import { reportAutomationApi } from "@/lib/api-client/endpoints/report-automation.api";
import type { ReportDelivery, ReportMessagePart, ReportRecipientResult } from "@/lib/api-client/types/report-automation.types";
import { formatInZone, STATUS_LABEL } from "./report-automation-form";
import { PHASE_LABEL, PHASE_TONE, rangeText, runPhase } from "./report-automation-schedule";

type StatusFilter = "" | "SENT" | "FAILED" | "PENDING" | "CANCELLED";
const PAGE_SIZE = 10;
const partTone = (s: string) => (s === "FAILED" ? "text-destructive" : s === "UNCERTAIN" || s === "WAITING_FOR_REPLY" ? "text-amber-600 dark:text-amber-400" : s === "DELIVERED" || s === "READ" || s === "SENT" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground");

/** One WhatsApp message of one recipient: its status, attempts, last attempt, the failure reason and (when it applies) Retry. */
function PartStatus({ part, timezone, retryLabel, onRetry, busy, testId }: { part: ReportMessagePart & { nextAttemptAt?: string | null }; timezone: string; retryLabel: string; onRetry: () => void; busy: boolean; testId: string }) {
  if (part.status === "SKIPPED") return <span className="text-xs text-muted-foreground" title={part.error ?? undefined} data-testid={`part-${testId}`}>{part.error ? "Not needed" : "Off"}</span>;
  return (
    <div className="space-y-0.5 text-xs" data-testid={`part-${testId}`}>
      <p className={`font-medium ${partTone(part.status)}`}>{STATUS_LABEL[part.status] ?? part.status}</p>
      <p className="text-muted-foreground">{part.attempts} attempt{part.attempts === 1 ? "" : "s"}{part.lastAttemptAt ? ` · ${formatInZone(part.lastAttemptAt, timezone)}` : ""}</p>
      {part.deliveredAt ? <p className="text-muted-foreground">Delivered {formatInZone(part.deliveredAt, timezone)}</p> : null}
      {part.readAt ? <p className="text-muted-foreground">Read {formatInZone(part.readAt, timezone)}</p> : null}
      {part.error ? <p className={part.status === "FAILED" || part.status === "UNCERTAIN" ? "text-destructive" : "text-muted-foreground"}>{part.error}</p> : null}
      {part.status === "FAILED" && part.nextAttemptAt ? <p className="text-muted-foreground">Next automatic attempt {formatInZone(part.nextAttemptAt, timezone)}</p> : null}
      {part.canRetry ? <Button type="button" size="xs" variant="outline" onClick={onRetry} disabled={busy} data-testid={`retry-${testId}`}>{retryLabel}</Button> : null}
    </div>
  );
}

function RunDetail({ run, timezone, onRetry, busy, remove }: { run: ReportDelivery; timezone: string; onRetry: (id: string, part: "TEXT" | "DETAIL" | "DOCUMENT") => void; busy: boolean; remove: { allowed: boolean; reason: string | null; pending: boolean; onRemove: () => void } | null }) {
  return (
    <div className="space-y-2 bg-muted/30 p-3" data-testid="run-detail">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Recipient</TableHead>
              <TableHead>WhatsApp summary</TableHead>
              <TableHead>Detailed report</TableHead>
              <TableHead>Excel</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.recipients.map((r: ReportRecipientResult) => (
              <TableRow key={r.id} data-testid="delivery-row">
                <TableCell className="align-top whitespace-nowrap">{r.name ? <span className="font-medium">{r.name} </span> : null}<span className="text-muted-foreground">{r.phone}</span></TableCell>
                <TableCell className="align-top"><PartStatus part={r} timezone={timezone} retryLabel="Retry" onRetry={() => onRetry(r.id, "TEXT")} busy={busy} testId="text" /></TableCell>
                <TableCell className="align-top"><PartStatus part={r.detail} timezone={timezone} retryLabel={r.detail.status === "WAITING_FOR_REPLY" ? "Send now" : "Retry"} onRetry={() => onRetry(r.id, "DETAIL")} busy={busy} testId="detail" /></TableCell>
                <TableCell className="align-top"><PartStatus part={r.document} timezone={timezone} retryLabel={r.document.status === "WAITING_FOR_REPLY" ? "Send now" : "Retry"} onRetry={() => onRetry(r.id, "DOCUMENT")} busy={busy} testId="excel" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {remove ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Button type="button" size="xs" variant="outline" disabled={!remove.allowed || remove.pending} onClick={remove.onRemove} data-testid="delete-run" title="Hides this entry; messages already sent are not recalled">Remove from history</Button>
          {!remove.allowed && remove.reason ? <span>{remove.reason}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Report history: ONE row per report run (its recipients are inside it), newest first, 10 per page, with a date search and a status filter. Details open in an expandable panel. */
export function ReportHistory({ timezone, removable, onRemove, removing }: { timezone: string; removable: Map<string, { canDelete: boolean; reason: string | null }>; onRemove: (runId: string) => void; removing: boolean }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>("");
  const [date, setDate] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ["report-automation", "deliveries", page, status, date],
    queryFn: () => reportAutomationApi.deliveries(page, PAGE_SIZE, { ...(status ? { status } : {}), ...(date ? { date } : {}) }),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const retry = useMutation({
    mutationFn: ({ id, part }: { id: string; part: "TEXT" | "DETAIL" | "DOCUMENT" }) => reportAutomationApi.retry(id, part),
    onSuccess: (r, v) => {
      const p = v.part === "DOCUMENT" ? r.document : v.part === "DETAIL" ? r.detail : r;
      if (p.status === "SENT") toast.success(v.part === "DOCUMENT" ? "Excel file accepted by WhatsApp" : v.part === "DETAIL" ? "Detailed report accepted by WhatsApp" : "WhatsApp summary accepted");
      else toast.error(p.error ?? STATUS_LABEL[p.status]);
    },
    onError: (e) => toast.error(getErrorMessage(e, "The retry could not be sent.")),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["report-automation"] }),
  });

  const items = history.data?.items ?? [];
  const pagination = history.data?.pagination;
  const filtered = Boolean(status || date);

  return (
    <div className="space-y-3" data-testid="report-history">
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Search by date
          <Input type="date" className="h-8 w-40" value={date} onChange={(e) => { setDate(e.target.value); setPage(1); setOpen(null); }} aria-label="Search history by date" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Status
          <NativeSelect size="sm" wrapperClassName="w-40" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1); setOpen(null); }} aria-label="Filter history by status">
            <option value="">All</option>
            <option value="SENT">Sent</option>
            <option value="PENDING">Scheduled / in progress</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
          </NativeSelect>
        </label>
        {filtered ? <Button type="button" size="sm" variant="ghost" onClick={() => { setDate(""); setStatus(""); setPage(1); }}>Clear</Button> : null}
      </div>

      {history.error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(history.error, "Could not load the history.")}</p> : null}
      {history.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {!history.isLoading && items.length === 0 ? <p className="text-sm text-muted-foreground">{filtered ? "No reports match these filters." : "No reports have been sent yet."}</p> : null}

      {items.length > 0 ? (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scheduled date</TableHead>
                <TableHead>Report data date</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((run) => {
                const phase = runPhase(run);
                const isOpen = open === run.id;
                const info = removable.get(run.id);
                return (
                  <Fragment key={run.id}>
                    <TableRow data-testid="history-run" className={isOpen ? "bg-muted/40" : undefined}>
                      <TableCell className="whitespace-nowrap">{formatInZone(run.scheduledFor ?? run.createdAt, timezone)}{run.kind === "TEST" ? <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">Test</span> : null}</TableCell>
                      <TableCell className="whitespace-nowrap">{rangeText({ from: run.reportFrom, to: run.reportDate })}</TableCell>
                      <TableCell>{run.recipients.length} recipient{run.recipients.length === 1 ? "" : "s"}</TableCell>
                      <TableCell><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PHASE_TONE[phase]}`} data-testid="run-status">{PHASE_LABEL[phase]}</span></TableCell>
                      <TableCell className="text-right">
                        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(isOpen ? null : run.id)} aria-expanded={isOpen} data-testid="view-run">
                          {isOpen ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
                          {isOpen ? "Hide" : "View"}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow>
                        <TableCell colSpan={5} className="p-0">
                          <RunDetail run={run} timezone={timezone} onRetry={(id, part) => retry.mutate({ id, part })} busy={retry.isPending} remove={info ? { allowed: info.canDelete, reason: info.reason, pending: removing, onRemove: () => onRemove(run.id) } : null} />
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

      {pagination && pagination.totalItems > 0 ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{pagination.totalItems} report{pagination.totalItems === 1 ? "" : "s"} · page {pagination.page} of {pagination.totalPages}</span>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => { setPage(page - 1); setOpen(null); }}>Previous</Button>
            <Button type="button" size="sm" variant="outline" disabled={page >= pagination.totalPages} onClick={() => { setPage(page + 1); setOpen(null); }}>Next</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
