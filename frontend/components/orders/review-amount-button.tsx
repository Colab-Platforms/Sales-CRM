"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { BadgeIndianRupee } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@/lib/api-client/client";
import { useAmountCorrectMutation, useAmountPreviewMutation } from "@/lib/api-client/mutations/orders.mutations";
import type { AmountApplyResponse, AmountPreview, OrderDetail } from "@/lib/api-client/types/orders.types";
import { useAuthStore } from "@/stores/auth-store";
import { canCorrect, changeSentence, differingRows, failedGates, reviewedText } from "./review-amount-form";

// "Review & Correct Amount" on the order page. It re-reads the CRM order, the Shopify order AND the Shiprocket (courier) order, compares every money field, and - only when the ONE supported correction (the missing COD
// shipping line) is safe on every gate - lets an Admin / Manager confirm it by ticking and typing the corrected total. It is a real financial edit: it raises what the customer owes, and it never marks anything paid, records a
// payment, refunds, changes fulfilment or changes the courier amount. Everything else that differs is shown for manual review.

const ROLES = ["ADMIN", "MANAGER", "SALESPERSON"];
const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

export function ReviewAmountButton({ order }: { order: Pick<OrderDetail, "id" | "orderNumber"> }) {
  const role = useAuthStore((s) => s.user?.role);
  const preview = useAmountPreviewMutation();
  const correct = useAmountCorrectMutation();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AmountPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<AmountApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false); // synchronous guard against a fast double click
  if (!role || !ROLES.includes(role)) return null;
  const busy = preview.isPending || correct.isPending;

  const load = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setResult(null);
    setConfirmed(false);
    setTyped("");
    setOpen(true);
    try {
      setData(await preview.mutateAsync({ orderId: order.id }));
    } catch (e) {
      setData(null);
      setError(getErrorMessage(e, "The amounts could not be loaded."));
    } finally {
      busyRef.current = false;
    }
  };

  const run = async () => {
    if (busyRef.current || !data?.stateToken || !data.proposal || !canCorrect(data, confirmed, typed, busy)) return;
    busyRef.current = true;
    setError(null);
    try {
      const r = await correct.mutateAsync({ orderId: order.id, stateToken: data.stateToken, confirmTotal: typed.trim(), confirm: true });
      setResult(r);
      setData(r.preview);
      setConfirmed(false);
      setTyped("");
      (r.outcome === "corrected" ? toast.success : toast.error)(r.message);
    } catch (e) {
      setError(getErrorMessage(e, "The correction failed. Nothing was changed."));
    } finally {
      busyRef.current = false;
    }
  };

  const gates = failedGates(data);
  const differing = differingRows(data);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={busy} data-testid="review-amount">
        <BadgeIndianRupee className="size-4" /> Review &amp; Correct Amount
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review &amp; correct amount - {order.orderNumber}</DialogTitle>
            <DialogDescription>Compares what the CRM, Shopify and the courier (Shiprocket) hold for this order. Nothing is changed until you confirm, and a correction never records a payment or changes the courier amount.</DialogDescription>
          </DialogHeader>

          {preview.isPending && !data ? <p className="text-sm text-muted-foreground" data-testid="amount-loading">Reading the CRM, Shopify and Shiprocket…</p> : null}
          {error ? <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="amount-error">{error} {error.includes("changed since") ? <Button type="button" size="sm" variant="outline" onClick={() => void load()}>Refresh</Button> : null}</p> : null}
          {result ? (
            <div role="status" className={`rounded-md border p-3 text-sm ${result.outcome === "corrected" ? "border-emerald-500/40 text-emerald-700" : "border-destructive/40 text-destructive"}`} data-testid={`amount-result-${result.outcome}`}>
              <div className="font-medium">{result.message}</div>
              {result.after ? <div className="text-xs">Before: total {result.before.total}, outstanding {result.before.outstanding}. After (re-read from Shopify): total {result.after.total}, outstanding {result.after.outstanding}.</div> : null}
            </div>
          ) : null}
          {data && !data.comparable ? <p className="text-sm text-muted-foreground" data-testid="amount-not-comparable">{data.note}</p> : null}

          {data?.comparable ? (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">{reviewedText(data.lastReviewedAt, fmt)} · {differing.length} difference{differing.length === 1 ? "" : "s"}</p>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm" data-testid="amount-table">
                  <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-2">Field</th><th className="p-2">CRM</th><th className="p-2">Shopify</th></tr></thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.key} className={r.status === "DIFFERENT" ? "bg-amber-500/10" : ""} data-testid={`amount-row-${r.key}`}>
                        <td className="p-2">{r.label}</td><td className="p-2 tabular-nums">{r.crm}</td><td className="p-2 tabular-nums">{r.shopify}</td>
                      </tr>
                    ))}
                    {data.courier ? <tr data-testid="amount-row-courier"><td className="p-2">Courier (Shiprocket) COD amount</td><td className="p-2">-</td><td className="p-2 tabular-nums">{data.courier.error ? `unavailable (${data.courier.error})` : data.courier.found ? `${data.courier.total ?? "?"} · ${data.courier.paymentMethod ?? "?"} · ${data.courier.status ?? "?"}${data.courier.hasAwb ? " · courier assigned" : ""}` : "no Shiprocket order yet"}</td></tr> : null}
                  </tbody>
                </table>
              </div>

              {data.proposal ? (
                <section className="space-y-2 rounded-md border p-3" aria-label="Proposed correction" data-testid="amount-proposal">
                  <h3 className="text-sm font-semibold">Proposed correction: add the {data.proposal.amount} shipping line</h3>
                  <p className="text-sm">{changeSentence(data)}</p>
                  <p className="text-xs text-muted-foreground">{data.proposal.reason}</p>
                  <p className="text-xs text-amber-700">Risk: {data.proposal.risk}</p>
                </section>
              ) : data.manualReason ? (
                <p className="rounded-md border border-amber-500/40 p-3 text-sm text-amber-700" data-testid="amount-manual">Manual review: {data.manualReason}</p>
              ) : <p className="text-sm text-emerald-700" data-testid="amount-all-good">The amounts agree.</p>}

              {data.proposal ? (
                <ul className="space-y-1 text-xs" aria-label="Checks" data-testid="amount-gates">
                  {data.gates.map((g) => <li key={g.key} className={g.ok ? "text-emerald-700" : "text-destructive"}>{g.ok ? "✓" : "✕"} {g.label} - {g.detail}</li>)}
                </ul>
              ) : null}
              {data.proposal && gates.length > 0 ? <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="amount-blocked">Blocked: {data.blockedReason}</p> : null}

              {data.proposal && data.canApply ? (
                <div className="space-y-2">
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} data-testid="amount-confirm" />
                    <span>I understand this changes the amount the customer owes from {data.proposal.before.outstanding} to {data.proposal.after.outstanding} on the Shopify order.</span>
                  </label>
                  <Label htmlFor="amount-typed" className="text-xs">Type the corrected total ({data.proposal.after.total}) to confirm</Label>
                  <Input id="amount-typed" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={data.proposal.after.total} disabled={busy} data-testid="amount-typed" />
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Close</Button>
            <Button type="button" variant="outline" onClick={() => void load()} disabled={busy} data-testid="amount-refresh">Refresh</Button>
            <Button type="button" onClick={() => void run()} disabled={!canCorrect(data, confirmed, typed, busy)} data-testid="amount-apply">{correct.isPending ? "Correcting and verifying…" : "Add shipping line"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
