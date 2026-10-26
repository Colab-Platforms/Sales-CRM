"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useSyncApplyMutation, useSyncPreviewMutation } from "@/lib/api-client/mutations/orders.mutations";
import type { OrderDetail, SyncActionId, SyncApplyResponse, SyncItem, SyncPreview } from "@/lib/api-client/types/orders.types";
import { useAuthStore } from "@/stores/auth-store";
import { canApply, defaultSelection, lastSyncText, manualItems, OUTCOME_TONE, syncableItems } from "./order-sync-form";

// "Sync / Update from CRM" on the order page, next to Edit Address and Change Flavour. Click -> the latest CRM order and the live Shopify order are compared -> the person ticks the differences the server allows and
// confirms -> only those are written, Shopify is re-read and the result (success, partial, blocked, failed) is shown with what still differs. Amounts, payments, shipping / discount lines, fulfilment and line items are
// shown for review and never written by this button.

const EDIT_ROLES = ["ADMIN", "MANAGER", "SALESPERSON"];
const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const TONE = { success: "border-emerald-500/40 text-emerald-700", warning: "border-amber-500/40 text-amber-700", error: "border-destructive/40 text-destructive" } as const;

function ItemRow({ item, checked, onToggle, disabled }: { item: SyncItem; checked?: boolean; onToggle?: () => void; disabled?: boolean }) {
  return (
    <div className="rounded-md border p-3 text-sm" data-testid={`sync-item-${item.key}`}>
      <div className="flex items-start gap-2">
        {item.action && onToggle ? <input type="checkbox" className="mt-1" checked={checked} onChange={onToggle} disabled={disabled} aria-label={`Sync ${item.label}`} /> : null}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-medium">{item.label} <span className="text-xs font-normal text-muted-foreground">{item.status === "SYNCED" ? "in sync" : item.status === "INFO" ? "info" : "differs"}</span></div>
          <div className="grid gap-1 text-xs sm:grid-cols-2">
            <div><span className="text-muted-foreground">CRM: </span>{item.crm ?? "-"}</div>
            <div><span className="text-muted-foreground">Shopify: </span>{item.shopify ?? "-"}</div>
          </div>
          {item.blocked ? <p className="text-xs text-amber-700" data-testid="sync-blocked">{item.blocked}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function OrderSyncButton({ order }: { order: Pick<OrderDetail, "id" | "orderNumber"> }) {
  const role = useAuthStore((s) => s.user?.role);
  const preview = useSyncPreviewMutation();
  const apply = useSyncApplyMutation();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SyncPreview | null>(null);
  const [selected, setSelected] = useState<SyncActionId[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<SyncApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false); // synchronous guard: a fast double click fires before isPending re-renders
  if (!role || !EDIT_ROLES.includes(role)) return null;
  const busy = preview.isPending || apply.isPending;

  const load = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setResult(null);
    setConfirmed(false);
    setOpen(true);
    try {
      const p = await preview.mutateAsync({ orderId: order.id });
      setData(p);
      setSelected(defaultSelection(p));
    } catch (e) {
      setData(null);
      setError(getErrorMessage(e, "The comparison could not be loaded."));
    } finally {
      busyRef.current = false;
    }
  };

  const run = async () => {
    if (busyRef.current || !data?.stateToken || !canApply(data, selected, confirmed, busy)) return;
    busyRef.current = true;
    setError(null);
    try {
      const r = await apply.mutateAsync({ orderId: order.id, stateToken: data.stateToken, actions: selected, confirm: true });
      setResult(r);
      setData(r.preview);
      setSelected(defaultSelection(r.preview));
      setConfirmed(false);
      (r.outcome === "synced" ? toast.success : toast.warning)(r.message);
    } catch (e) {
      setError(getErrorMessage(e, "The sync failed. Nothing was left half-done in the CRM."));
    } finally {
      busyRef.current = false;
    }
  };

  const toggle = (a: SyncActionId) => setSelected((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));
  const syncable = syncableItems(data);
  const manual = manualItems(data);
  const inSync = data?.items.filter((i) => i.status !== "DIFFERENT") ?? [];

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={busy} data-testid="sync-from-crm">
        <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Sync / Update from CRM
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sync from CRM - {order.orderNumber}</DialogTitle>
            <DialogDescription>
              Compares this order with the live Shopify order. Only the ticked, allowed differences are written to Shopify. Amounts, payments, shipping / discount lines, fulfilment and line items are never changed here.
            </DialogDescription>
          </DialogHeader>

          {preview.isPending && !data ? <p className="text-sm text-muted-foreground" data-testid="sync-loading">Reading the CRM order and Shopify…</p> : null}
          {error ? <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="sync-error">{error} {error.includes("changed since") ? <Button type="button" size="sm" variant="outline" onClick={() => void load()}>Refresh comparison</Button> : null}</p> : null}

          {result ? (
            <div role="status" className={`space-y-1 rounded-md border p-3 text-sm ${TONE[OUTCOME_TONE[result.outcome]]}`} data-testid={`sync-result-${result.outcome}`}>
              <div className="font-medium">{result.message}</div>
              {result.results.map((r) => <div key={r.action} className="text-xs">{r.action}: {r.status} - {r.message}</div>)}
            </div>
          ) : null}

          {data && !data.comparable ? <p className="text-sm text-muted-foreground" data-testid="sync-not-comparable">{data.note}</p> : null}

          {data?.comparable ? (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground" data-testid="sync-last">{lastSyncText(data.lastSyncedAt, fmt)} · {data.summary.differences} difference{data.summary.differences === 1 ? "" : "s"} · {data.summary.syncable} can be synced · {data.summary.manualReview} need manual review</p>
              {syncable.length > 0 ? (
                <section className="space-y-2" aria-label="Changes that can be synced">
                  <h3 className="text-sm font-semibold">Can be synced to Shopify</h3>
                  {syncable.map((i) => <ItemRow key={i.key} item={i} checked={selected.includes(i.action!)} onToggle={() => toggle(i.action!)} disabled={busy} />)}
                </section>
              ) : null}
              {manual.length > 0 ? (
                <section className="space-y-2" aria-label="Differences needing manual review">
                  <h3 className="text-sm font-semibold">Needs manual review (not changed by the sync)</h3>
                  {manual.map((i) => <ItemRow key={i.key} item={i} />)}
                </section>
              ) : null}
              {syncable.length === 0 && manual.length === 0 ? <p className="text-sm text-emerald-700" data-testid="sync-all-good">Everything compared is in sync.</p> : null}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">{inSync.length} item{inSync.length === 1 ? "" : "s"} in sync / for information</summary>
                <div className="mt-2 space-y-2">{inSync.map((i) => <ItemRow key={i.key} item={i} />)}</div>
              </details>
              {syncable.length > 0 ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} data-testid="sync-confirm" />
                  <span>I confirm these changes will be written to the Shopify order. No payment, refund, fulfilment or message is triggered.</span>
                </label>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Close</Button>
            <Button type="button" variant="outline" onClick={() => void load()} disabled={busy} data-testid="sync-refresh">Refresh comparison</Button>
            <Button type="button" onClick={() => void run()} disabled={!canApply(data, selected, confirmed, busy)} data-testid="sync-apply">
              {apply.isPending ? "Syncing and verifying…" : `Sync ${selected.length || ""} selected`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
