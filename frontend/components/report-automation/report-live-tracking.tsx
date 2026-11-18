"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, CheckCheck, ChevronDown, ChevronRight, CircleX, Clock, MessageSquareReply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-client/client";
import { reportAutomationApi } from "@/lib/api-client/endpoints/report-automation.api";
import { cn } from "@/lib/utils";
import { STATUS_LABEL } from "./report-automation-form";
import { rangeText } from "./report-automation-schedule";
import { messageState, partsOf, partTick, shortTime, trackingCounts, type Tick } from "./report-tracking";

/** How often the page asks the server for new delivery callbacks and replies. The webhook writes them as they arrive; this only reads. */
export const TRACKING_POLL_MS = 8_000;

/** One tick indicator, WhatsApp-style: one grey tick = sent, two grey = delivered, two blue = read, red = failed, a clock = pending. */
export function TickIcon({ tick, className }: { tick: Tick; className?: string }) {
  const c = cn("size-4 shrink-0", className);
  switch (tick) {
    case "SENT": return <Check className={cn(c, "text-muted-foreground")} aria-hidden />;
    case "DELIVERED": return <CheckCheck className={cn(c, "text-muted-foreground")} aria-hidden />;
    case "READ": return <CheckCheck className={cn(c, "text-sky-500")} aria-hidden />;
    case "FAILED": return <CircleX className={cn(c, "text-destructive")} aria-hidden />;
    default: return <Clock className={cn(c, "text-muted-foreground/70")} aria-hidden />;
  }
}

function Card({ label, value, of, icon, tone, testId }: { label: string; value: number; of?: number; icon: React.ReactNode; tone?: string; testId: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3 py-2.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{icon}{label}</p>
      <p className={cn("mt-0.5 text-lg font-semibold leading-tight", tone)}>{value}{of !== undefined ? <span className="text-sm font-normal text-muted-foreground"> / {of}</span> : null}</p>
    </div>
  );
}

/** Live delivery and reply status of one report run: the latest by default, or any earlier run. Polls the server; every state comes from the provider's callbacks and real inbound messages. */
export function ReportLiveTracking({ timezone }: { timezone: string }) {
  const [runId, setRunId] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const tracking = useQuery({ queryKey: ["report-automation", "tracking", runId], queryFn: () => reportAutomationApi.tracking(runId || undefined), refetchInterval: TRACKING_POLL_MS, placeholderData: (prev) => prev });
  const data = tracking.data;
  const run = data?.run ?? null;
  const counts = run ? trackingCounts(run.recipients) : null;
  const now = new Date();
  const label = (r: { reportFrom: string; reportDate: string; scheduledFor: string; kind: string }) => `${shortTime(r.scheduledFor, timezone, now)} · data ${rangeText({ from: r.reportFrom, to: r.reportDate })}${r.kind === "TEST" ? " (test)" : ""}`;

  return (
    <section className="space-y-2" aria-label="Live delivery status" data-testid="live-tracking">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Live delivery status</h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="live-indicator">
            <span className={cn("size-1.5 rounded-full", tracking.isError ? "bg-destructive" : "animate-pulse bg-emerald-500")} />
            {tracking.isError ? "Not updating" : tracking.dataUpdatedAt ? `Live · updated ${shortTime(new Date(tracking.dataUpdatedAt).toISOString(), timezone, now)}` : "Connecting…"}
          </span>
        </div>
        {data && data.runs.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Report
            <NativeSelect size="sm" wrapperClassName="w-72 max-w-full" value={runId} onChange={(e) => { setRunId(e.target.value); setOpen(null); }} aria-label="Choose the report run to track" data-testid="run-selector">
              <option value="">Latest · {data.runs[0] ? label(data.runs[0]) : ""}</option>
              {data.runs.slice(1).map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
            </NativeSelect>
          </label>
        ) : null}
      </div>

      {tracking.isError && !data ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(tracking.error, "Could not load the delivery status.")}</p> : null}
      {tracking.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {data && !run ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-testid="tracking-empty">No report has been sent yet. Delivery, read and reply status will appear here as soon as the first report goes out.</p>
      ) : null}

      {run && counts ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="tracking-cards">
            <Card testId="card-total" label="Recipients" value={counts.total} icon={null} />
            <Card testId="card-sent" label="Sent" value={counts.sent} of={counts.total} icon={<Check className="size-3.5" />} />
            <Card testId="card-delivered" label="Delivered" value={counts.delivered} of={counts.total} icon={<CheckCheck className="size-3.5" />} />
            <Card testId="card-read" label="Read" value={counts.read} of={counts.total} icon={<CheckCheck className="size-3.5 text-sky-500" />} tone={counts.read > 0 ? "text-sky-600" : undefined} />
            <Card testId="card-replied" label="Replied" value={counts.replied} of={counts.total} icon={<MessageSquareReply className="size-3.5 text-emerald-600" />} tone={counts.replied > 0 ? "text-emerald-600" : undefined} />
            <Card testId="card-failed" label="Failed" value={counts.failed} icon={<CircleX className="size-3.5 text-destructive" />} tone={counts.failed > 0 ? "text-destructive" : undefined} />
          </div>

          {run.recipients.length === 0 ? <p className="text-sm text-muted-foreground">This run had no recipients.</p> : (
            <div className="overflow-x-auto rounded-md border">
              <Table data-testid="tracking-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Recipient</TableHead>
                    <TableHead className="hidden sm:table-cell">WhatsApp number</TableHead>
                    <TableHead><span className="sm:hidden">Status</span><span className="hidden sm:inline">Message status</span></TableHead>
                    <TableHead><span className="sm:hidden">Reply</span><span className="hidden sm:inline">Reply status</span></TableHead>
                    <TableHead className="hidden sm:table-cell">Last updated</TableHead>
                    <TableHead className="hidden w-8 sm:table-cell"><span className="sr-only">Details</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.recipients.map((r) => {
                    const s = messageState(r);
                    const isOpen = open === r.id;
                    return (
                      <Fragment key={r.id}>
                        <TableRow data-testid="tracking-row" className={cn("cursor-pointer", isOpen && "bg-muted/40")} onClick={() => setOpen(isOpen ? null : r.id)}>
                          <TableCell className="font-medium">{r.name || "Unnamed"}<span className="block font-mono text-[11px] font-normal text-muted-foreground sm:hidden">{r.phone}</span></TableCell>
                          <TableCell className="hidden whitespace-nowrap font-mono text-xs text-muted-foreground sm:table-cell">{r.phone}</TableCell>
                          <TableCell>
                            <span className={cn("inline-flex items-center gap-1.5 text-sm", s.tick === "READ" && "text-sky-600", s.tick === "FAILED" && "text-destructive")} data-testid="message-status" data-tick={s.tick}>
                              <TickIcon tick={s.tick} />{s.label}
                              {s.partialFailure ? <span className="ml-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">1+ failed</span> : null}
                            </span>
                          </TableCell>
                          <TableCell>
                            {r.repliedAt
                              ? <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600" data-testid="reply-status" data-replied="true"><span className="size-1.5 rounded-full bg-emerald-500" />Replied</span>
                              : <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="reply-status" data-replied="false"><span className="size-1.5 rounded-full bg-muted-foreground/40" />Not replied</span>}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{shortTime(s.updatedAt, timezone, now)}</TableCell>
                          <TableCell className="hidden text-right sm:table-cell"><Button type="button" variant="ghost" size="icon-xs" aria-label={isOpen ? "Hide details" : "Show details"} aria-expanded={isOpen}>{isOpen ? <ChevronDown /> : <ChevronRight />}</Button></TableCell>
                        </TableRow>
                        {isOpen ? (
                          <TableRow>
                            <TableCell colSpan={6} className="bg-muted/30 p-0" data-testid="tracking-detail">
                              <ul className="w-0 min-w-full space-y-2 whitespace-normal break-words p-3 text-xs">
                                {partsOf(r).map((p) => {
                                  return (
                                    <li key={p.key} className="flex flex-wrap items-start gap-x-3 gap-y-0.5">
                                      <span className="flex w-36 shrink-0 items-center gap-1.5 font-medium"><TickIcon tick={partTick(p.status)} />{p.label}</span>
                                      <span className="text-muted-foreground">{STATUS_LABEL[p.status as keyof typeof STATUS_LABEL] ?? p.status}</span>
                                      <span className="text-muted-foreground">{[p.sentAt && `sent ${shortTime(p.sentAt, timezone, now)}`, p.deliveredAt && `delivered ${shortTime(p.deliveredAt, timezone, now)}`, p.readAt && `read ${shortTime(p.readAt, timezone, now)}`].filter(Boolean).join(" · ")}</span>
                                      {p.error && (p.status === "FAILED" || p.status === "UNCERTAIN") ? <span className="basis-full text-destructive sm:pl-[9.5rem]">{p.error}</span> : null}
                                    </li>
                                  );
                                })}
                                {r.repliedAt ? <li className="text-emerald-700">Replied {shortTime(r.repliedAt, timezone, now)}</li> : <li className="text-muted-foreground">No reply received yet.</li>}
                              </ul>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
