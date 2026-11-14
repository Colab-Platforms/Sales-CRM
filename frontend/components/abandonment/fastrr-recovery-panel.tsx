"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Download, Loader2, RotateCcw, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fastrrRecoveryApi, type RecoveryPreview, type RecoveryRun } from "@/lib/api-client/endpoints/fastrr-recovery.api";
import { describeRequestError, saveBlob } from "@/lib/api-client/endpoints/abandonment.recordings.api";
import { istDay } from "@/components/abandonment/export-shared";

const RUNS_KEY = ["fastrr-recovery-runs"] as const;
const STATUS_TEXT: Record<RecoveryRun["status"], string> = { RUNNING: "Importing", COMPLETED: "Completed", PARTIAL: "Partly failed", FAILED: "Failed" };

function Stat({ label, value, tone, testId }: { label: string; value: number; tone?: "alert" | "ok"; testId: string }) {
  return (
    <div className={`rounded-md border bg-card/60 p-2 ${tone === "alert" ? "border-destructive/50" : ""}`} data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${tone === "ok" ? "text-emerald-600" : ""}`}>{value}</div>
    </div>
  );
}

function RunCard({ run, onRetry, retrying }: { run: RecoveryRun; onRetry: () => void; retrying: boolean }) {
  const target = run.missing;
  const handled = run.imported + run.merged + run.skippedExisting + run.failed;
  const percent = run.status === "RUNNING" ? (target > 0 ? Math.min(99, Math.round((handled / target) * 100)) : 0) : 100;
  const canRetry = run.status === "PARTIAL" || run.status === "FAILED";
  return (
    <div className="space-y-2 rounded-md border bg-background/60 p-3 text-sm" data-testid="recovery-run" data-status={run.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {run.fromDay === run.toDay ? run.fromDay : `${run.fromDay} → ${run.toDay}`}{" "}
          <span className={run.status === "FAILED" || run.status === "PARTIAL" ? "text-destructive" : run.status === "COMPLETED" ? "text-emerald-600" : ""} data-testid="recovery-run-status">{STATUS_TEXT[run.status]}</span>
        </span>
        <span className="text-xs text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Import progress">
        <div className={`h-full ${run.status === "FAILED" ? "bg-destructive" : "bg-primary"}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="text-xs text-muted-foreground" data-testid="recovery-run-counts">
        Fetched {run.fetched} · already in CRM {run.existing} · to import {run.missing} · imported <b>{run.imported}</b> · matched an open cart {run.merged} · already saved {run.skippedExisting} · failed <b>{run.failed}</b>
      </div>
      {run.errors && run.errors.length > 0 ? (
        <details className="text-xs" data-testid="recovery-run-errors">
          <summary className="cursor-pointer text-destructive">{run.errors.length} error{run.errors.length === 1 ? "" : "s"} - details</summary>
          <ul className="mt-1 max-h-40 overflow-auto">
            {run.errors.map((e, i) => (
              <li key={`${e.cartId}-${i}`}><span className="font-mono">{e.cartId}</span>: {e.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {canRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Admin / Manager: fetch Fastrr's abandoned carts for a date range, preview what the CRM is missing, then import it after an explicit confirmation. */
export function FastrrRecoveryPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(istDay(0));
  const [to, setTo] = useState(istDay(0));
  const [includeConverted, setIncludeConverted] = useState(false);
  const [preview, setPreview] = useState<RecoveryPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const range = { from, to, includeConverted };

  const status = useQuery({ queryKey: ["fastrr-recovery-status"], queryFn: () => fastrrRecoveryApi.status(), enabled: open, staleTime: 60_000 });
  const runs = useQuery({
    queryKey: RUNS_KEY,
    queryFn: () => fastrrRecoveryApi.runs(),
    enabled: open,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "RUNNING") ? 2000 : false),
  });
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["abandonments"] });
  };

  const fetchPreview = useMutation({
    mutationFn: () => fastrrRecoveryApi.preview(range),
    onSuccess: (p) => { setPreview(p); setConfirming(false); setError(null); },
    onError: (e) => { setPreview(null); setError(describeRequestError(e, "Could not fetch abandoned carts.")); },
  });
  const startImport = useMutation({
    mutationFn: () => fastrrRecoveryApi.startImport({ ...range, expectedMissing: preview!.counts.missing }),
    onSuccess: () => { setConfirming(false); setPreview(null); setError(null); refreshAll(); },
    onError: (e) => { setConfirming(false); setError(describeRequestError(e, "Could not start the import.")); },
  });
  const retry = useMutation({
    mutationFn: (id: string) => fastrrRecoveryApi.retry(id),
    onSuccess: () => { setError(null); refreshAll(); },
    onError: (e) => setError(describeRequestError(e, "Could not retry the import.")),
  });
  const download = useMutation({
    mutationFn: async () => saveBlob(await fastrrRecoveryApi.exportExcel(range)),
    onSuccess: () => setError(null),
    onError: (e) => setError(e instanceof Error ? e.message : "Could not create the Excel file."),
  });

  const importing = runs.data?.some((r) => r.status === "RUNNING") ?? false;
  const datesOk = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const canImport = Boolean(preview && preview.complete && preview.counts.missing > 0 && !importing);

  return (
    <div className="sketch-outline bg-card/60 p-3" data-testid="fastrr-recovery">
      <button type="button" className="flex w-full items-center justify-between text-left text-sm font-medium" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="flex items-center gap-2"><SearchCheck className="size-4" aria-hidden /> Fastrr cart recovery</span>
        {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">Fetches abandoned carts from Fastrr for the dates below and shows which ones the CRM is missing (for example after the server was down). Nothing is imported until you confirm.</p>
          {status.data && !status.data.configured ? <p className="text-sm text-destructive" data-testid="recovery-not-configured">Fastrr credentials are not configured on the server (FASTRR_REPORTING_AUTH_TOKEN / FASTRR_REPORTING_AUTH_INFO).</p> : null}
          <div className="flex flex-wrap items-end gap-3">
            <div><Label htmlFor="fr-from">From date</Label><Input id="fr-from" type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} /></div>
            <div><Label htmlFor="fr-to">To date</Label><Input id="fr-to" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPreview(null); }} /></div>
            <label className="flex items-center gap-2 pb-2 text-xs"><input type="checkbox" checked={includeConverted} onChange={(e) => { setIncludeConverted(e.target.checked); setPreview(null); }} /> Include carts that became orders</label>
            <Button onClick={() => fetchPreview.mutate()} disabled={!datesOk || fetchPreview.isPending}>{fetchPreview.isPending ? <Loader2 className="animate-spin" /> : null} Fetch abandoned carts</Button>
            <Button variant="outline" onClick={() => download.mutate()} disabled={!datesOk || download.isPending}>{download.isPending ? <Loader2 className="animate-spin" /> : <Download />} Excel</Button>
          </div>
          {error ? <p className="text-sm text-destructive" role="alert" data-testid="recovery-error">{error}</p> : null}

          {preview ? (
            <div className="space-y-3" data-testid="recovery-preview">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                <Stat testId="rec-fetched" label="Fetched" value={preview.counts.fetched} />
                <Stat testId="rec-existing" label="Already in CRM" value={preview.counts.existing} />
                <Stat testId="rec-missing" label="Missing" value={preview.counts.missing} tone={preview.counts.missing > 0 ? "alert" : "ok"} />
                <Stat testId="rec-duplicates" label="Duplicates" value={preview.counts.duplicates} />
                <Stat testId="rec-invalid" label="Invalid" value={preview.counts.invalid} />
                <Stat testId="rec-converted" label="Became orders" value={preview.counts.converted} />
              </div>
              {preview.warnings.map((w) => <p key={w} className="text-xs text-destructive">{w}</p>)}
              {preview.sampleMissing.length > 0 ? (
                <div className="max-h-48 overflow-auto rounded border text-xs">
                  <table className="w-full"><thead className="bg-muted/50 text-left"><tr><th className="p-1">Cart</th><th>Customer</th><th>Phone</th><th>Items</th><th>Value</th><th>Address</th></tr></thead>
                    <tbody>{preview.sampleMissing.map((s) => <tr key={s.cartId} className="border-t"><td className="p-1 font-mono">{s.cartId}</td><td>{s.customerName}</td><td>{s.phone}</td><td>{s.items}</td><td>{s.cartValue ?? ""}</td><td>{s.hasAddress ? "yes" : "-"}</td></tr>)}</tbody></table>
                </div>
              ) : null}
              {preview.sampleInvalid.length > 0 ? <p className="text-xs text-muted-foreground">Invalid examples: {preview.sampleInvalid.slice(0, 5).map((s) => `${s.cartId ?? "(no id)"}: ${s.reason}`).join(" · ")}</p> : null}
              {confirming ? (
                <div className="flex flex-wrap items-center gap-2 rounded border border-destructive/40 p-2 text-sm" data-testid="recovery-confirm">
                  <span>Import {preview.counts.missing} missing cart{preview.counts.missing === 1 ? "" : "s"} as abandoned leads? They will not be auto-assigned.</span>
                  <Button size="sm" onClick={() => startImport.mutate()} disabled={startImport.isPending}>{startImport.isPending ? <Loader2 className="animate-spin" /> : null} Yes, import</Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
                </div>
              ) : (
                <Button onClick={() => setConfirming(true)} disabled={!canImport} data-testid="recovery-import">Import {preview.counts.missing} missing carts</Button>
              )}
            </div>
          ) : null}

          <div className="space-y-2" data-testid="recovery-history">
            <div className="text-xs font-medium text-muted-foreground">Import history</div>
            {runs.data && runs.data.length === 0 ? <p className="text-xs text-muted-foreground">No imports yet.</p> : null}
            {(runs.data ?? []).map((r) => <RunCard key={r.id} run={r} onRetry={() => retry.mutate(r.id)} retrying={retry.isPending && retry.variables === r.id} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
