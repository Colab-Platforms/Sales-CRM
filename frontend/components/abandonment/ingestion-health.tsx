"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/api-client/client";
import { ingestionStatusQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { useReconcileIngestionMutation } from "@/lib/api-client/mutations/abandonment.mutations";
import type { AbandonmentDateRange, IngestionReconcileResult, IngestionStatus } from "@/lib/api-client/types/abandonment.types";
import { cn } from "@/lib/utils";

const PERIODS: { value: AbandonmentDateRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "all", label: "All" },
];

const ist = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " IST" : "never");
const sec = (n: number | null) => (n === null ? "—" : n >= 120 ? `${Math.round(n / 60)} min` : `${n} s`);
export function ago(seconds: number | null): string {
  if (seconds === null) return "no events yet";
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function Stat({ label, value, tone, testId, hint }: { label: string; value: string | number; tone?: "alert" | "ok"; testId: string; hint?: string }) {
  return (
    <div className={cn("sketch-outline bg-card/60 p-3", tone === "alert" && "border-destructive/50 bg-destructive/5")} data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-2xl font-bold tabular-nums" data-testid={`${testId}-value`}>{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** Pure view of one status answer (exported for rendering tests). Counts and times only - the API never returns customer data. */
export function IngestionHealthView({ status, canReconcile, onReconcile, reconciling, reconcileResult }: { status: IngestionStatus; canReconcile: boolean; onReconcile?: () => void; reconciling?: boolean; reconcileResult?: IngestionReconcileResult | null }) {
  const c = status.carts;
  const dead = status.failed.exhausted;
  return (
    <div className="space-y-3" data-testid="ingestion-health">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat testId="ing-events" label="Events received" value={status.received.events} />
        <Stat testId="ing-carts" label="Carts received" value={c.received} />
        <Stat testId="ing-saved" label="Saved as leads" value={c.saved} tone="ok" />
        <Stat testId="ing-notsaved" label="Received, NOT saved" value={c.notSaved} tone={c.notSaved > 0 ? "alert" : undefined} hint="failed, pending or dead" />
        <Stat testId="ing-failed" label="Failed" value={status.byStatus.failed} tone={status.byStatus.failed > 0 ? "alert" : undefined} hint={`${status.failed.retryable} retrying · ${dead} dead`} />
        <Stat testId="ing-pending" label="Pending now" value={status.backlog.pending} hint={status.backlog.oldestPendingAgeSeconds !== null ? `oldest ${sec(status.backlog.oldestPendingAgeSeconds)}` : undefined} />
        <Stat testId="ing-retried" label="Saved after retry" value={status.processedAfterRetry} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="sketch-outline bg-card/60 p-3 text-sm" data-testid="ing-lag">
          <div className="mb-1 font-medium">Delay</div>
          <div>Fastrr → CRM receipt: p50 {sec(status.latency.providerToReceipt.p50)} · p90 {sec(status.latency.providerToReceipt.p90)} · max {sec(status.latency.providerToReceipt.max)} <span className="text-xs text-muted-foreground">({status.latency.providerToReceipt.samples} events; Fastrr&apos;s own time vs when we received it)</span></div>
          <div>CRM receipt → saved: p50 {sec(status.latency.receiptToSaved.p50)} · p90 {sec(status.latency.receiptToSaved.p90)} · max {sec(status.latency.receiptToSaved.max)}</div>
          <div className="mt-1 text-xs text-muted-foreground">Last event received {ist(status.lastReceivedAt)} ({ago(status.secondsSinceLastReceived)}) · last saved {ist(status.lastProcessedAt)}</div>
        </div>
        <div className="sketch-outline bg-card/60 p-3 text-sm" data-testid="ing-process">
          <div className="mb-1 font-medium">Since this server started <span className="text-xs font-normal text-muted-foreground">({ist(status.process.since)}; resets on a restart)</span></div>
          <div>Duplicates ignored {status.process.duplicates} · rejected (authentication failed) {status.process.unauthorized} · invalid body {status.process.invalidBody} · no contact {status.process.unusableNoContact}</div>
          <div>Saved {status.process.processed} · failed attempts {status.process.failedAttempts} · gave up {status.process.exhausted} · auto-assign failed {status.process.autoAssignFailed}</div>
          <div data-testid="ing-last-reconcile">{status.lastReconcile ? `Last re-process ${ist(status.lastReconcile.at)}: ${status.lastReconcile.recovered} recovered, ${status.lastReconcile.failedAgain} failed again, ${status.lastReconcile.examined} examined` : "No re-process run since this server started."}</div>
        </div>
      </div>
      {c.notSaved > 0 || dead > 0 ? (
        <div role="alert" data-testid="ing-alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span>
            {c.notSaved} cart{c.notSaved === 1 ? " was" : "s were"} received from Fastrr but not saved as leads in this period; {dead} deliver{dead === 1 ? "y has" : "ies have"} no retries left (last 7 days).
          </span>
          {canReconcile ? (
            <Button type="button" size="sm" variant="outline" disabled={reconciling || dead === 0} onClick={onReconcile} data-testid="ing-reconcile">
              {reconciling ? "Re-processing…" : "Re-process failed deliveries"}
            </Button>
          ) : (
            <span className="text-xs">Ask an admin to re-process them.</span>
          )}
        </div>
      ) : null}
      {reconcileResult ? (
        <p className="text-sm" data-testid="ing-reconcile-result" role="status">
          Re-processed {reconcileResult.examined}: {reconcileResult.recovered} saved, {reconcileResult.failedAgain} failed again, {reconcileResult.skipped} skipped; {reconcileResult.remaining} still waiting{reconcileResult.timedOut || reconcileResult.remaining > 0 ? " — run it again to continue" : ""}. Recovered leads are not auto-assigned.
        </p>
      ) : null}
    </div>
  );
}

/** Collapsible "Ingestion health" panel for admin / manager / HR. Collapsed it still shows the one number that matters. */
export function IngestionHealthPanel({ canReconcile }: { canReconcile: boolean }) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<AbandonmentDateRange>("today");
  const [result, setResult] = useState<IngestionReconcileResult | null>(null);
  const { data, isPending, error, refetch } = useQuery(ingestionStatusQueryOptions(period));
  const reconcile = useReconcileIngestionMutation();
  const alert = Boolean(data && (data.carts.notSaved > 0 || data.failed.exhausted > 0));

  function run() {
    reconcile.mutate({}, {
      onSuccess: (r) => { setResult(r); toast.success(`${r.recovered} failed deliveries saved as leads.`); },
      onError: (e) => toast.error(getErrorMessage(e, "Could not re-process the failed deliveries.")),
    });
  }

  return (
    <section className="sketch-outline bg-card/60 p-3" data-testid="ingestion-panel">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="ingestion-toggle">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Activity className="size-4" aria-hidden /> Fastrr ingestion health
          {data ? (
            <span className={cn("rounded-full px-2 py-0.5 text-xs", alert ? "bg-destructive/10 text-destructive" : "bg-emerald-100 text-emerald-900")} data-testid="ingestion-badge">
              {alert ? `${data.carts.notSaved} not saved` : "healthy"} · last event {ago(data.secondsSinceLastReceived)}
            </span>
          ) : null}
        </span>
        {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          <div role="group" aria-label="Ingestion period" className="flex gap-2">
            {PERIODS.map((p) => (
              <Button key={p.value} type="button" size="sm" variant={p.value === period ? "default" : "outline"} aria-pressed={p.value === period} onClick={() => setPeriod(p.value)} data-testid={`ing-period-${p.value}`}>{p.label}</Button>
            ))}
          </div>
          {error ? (
            <div role="alert" data-testid="ing-error" className="text-sm text-destructive">{getErrorMessage(error, "Could not load ingestion health.")} <button type="button" className="underline" onClick={() => void refetch()}>Retry</button></div>
          ) : isPending || !data ? (
            <Skeleton className="h-32 rounded-xl" data-testid="ing-loading" />
          ) : (
            <IngestionHealthView status={data} canReconcile={canReconcile} onReconcile={run} reconciling={reconcile.isPending} reconcileResult={result} />
          )}
        </div>
      ) : null}
    </section>
  );
}
