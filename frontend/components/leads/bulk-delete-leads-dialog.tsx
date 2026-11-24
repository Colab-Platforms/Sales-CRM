"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { leadApi } from "@/lib/api-client/endpoints/lead.api";
import { leadKeys } from "@/lib/api-client/queries/lead.queries";
import { segmentKeys } from "@/lib/api-client/queries/segment.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { BulkDeletePreview, LeadIdFilter } from "@/lib/api-client/types/lead.types";

export type BulkDeleteMode = "PAGE" | "MATCHING" | "ALL";

/** The phrase an Admin must type before ALL leads can be deleted. The server checks it too. */
export const DELETE_ALL_PHRASE = "DELETE ALL";
export const deleteAllConfirmed = (typed: string): boolean => typed === DELETE_ALL_PHRASE;

const n = (v: number) => v.toLocaleString("en-IN");

/** The wording of each option, kept here so the two are never mixed up. */
export function bulkDeleteCopy(mode: BulkDeleteMode, count: number) {
  if (mode === "ALL") return { title: "Delete ALL leads", scope: `Every lead in the CRM, across all pages and page sizes, with no filter, will be deleted (${n(count)} in total). Leads that have orders are skipped.`, button: "Delete all leads" };
  return mode === "PAGE"
    ? { title: "Delete current page data", scope: `Only the ${n(count)} lead${count === 1 ? "" : "s"} selected on this page will be deleted. Matching leads on other pages are NOT touched.`, button: "Delete current page" }
    : { title: "Delete all selected / full matching data", scope: `Every lead matching your current filters and search, across ALL pages, will be deleted (${n(count)} in total).`, button: "Delete all matching leads" };
}

/**
 * Two clearly different deletions: the leads of the current page, or every lead matching the current filters. The exact number is fetched from the server first and shown before anything can be confirmed,
 * and the server refuses if that number has changed by the time the user confirms. Leads that have orders are never deleted.
 */
function BulkDeleteLeadsDialogInner({
  open,
  onOpenChange,
  mode,
  leadIds,
  filter,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: BulkDeleteMode;
  /** The leads on the current page (mode PAGE). */
  leadIds: string[];
  /** The active filters (mode MATCHING). */
  filter: LeadIdFilter | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<BulkDeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleted, setDeleted] = useState(0);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<{ deleted: number; skipped: number } | null>(null);

  // The dialog body is mounted fresh every time it opens (see BulkDeleteLeadsDialog), so its state always starts clean and only the count has to be fetched here.
  useEffect(() => {
    let cancelled = false;
    leadApi
      .previewBulkDelete(mode === "PAGE" ? { leadIds } : mode === "ALL" ? { all: true } : { filter: filter! })
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setError(getErrorMessage(e, "Could not count the leads.")));
    return () => {
      cancelled = true;
    };
    // the selection is fixed while the dialog is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirm() {
    if (!preview) return;
    setRunning(true);
    setError(null);
    try {
      let total = 0;
      let skipped = 0;
      let first = true;
      for (;;) {
        const r = await leadApi.bulkDeleteLeads({ ...(mode === "PAGE" ? { leadIds } : mode === "ALL" ? { all: true as const, confirmText: typed } : { filter: filter! }), expectedCount: preview.deletable, confirm: true as const, ...(first ? {} : { continuation: true }) });
        first = false;
        total += r.deleted;
        setDeleted(total);
        if (r.done || r.deleted === 0) {
          skipped = r.skippedWithOrders;
          break;
        }
      }
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
      queryClient.invalidateQueries({ queryKey: segmentKeys.all });
      if (mode === "ALL") {
        // the full result stays on screen: how many went, and how many were kept and why
        setResult({ deleted: total, skipped });
      } else {
        toast.success(`${n(total)} lead${total === 1 ? "" : "s"} deleted.`);
        onDone();
      }
    } catch (e) {
      setError(getErrorMessage(e, "Failed to delete leads."));
      queryClient.invalidateQueries({ queryKey: leadKeys.all });
    } finally {
      setRunning(false);
    }
  }

  const copy = bulkDeleteCopy(mode, preview?.deletable ?? (mode === "PAGE" ? leadIds.length : 0));
  const needsAck = mode === "MATCHING";
  const canConfirm = Boolean(preview && preview.deletable > 0 && (!needsAck || understood) && (mode !== "ALL" || deleteAllConfirmed(typed)) && !running);

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      {open ? (
        <DialogContent className="sm:max-w-[480px]" data-testid="bulk-delete-dialog">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{preview ? copy.scope : "Counting the leads…"}</DialogDescription>
          </DialogHeader>

          {preview ? (
            <div className="space-y-3 text-sm">
              <div className="sketch-outline bg-destructive/10 p-3 text-center" data-testid="bulk-delete-count">
                <div className="text-3xl font-bold tabular-nums text-destructive">{n(preview.deletable)}</div>
                <div className="text-xs text-muted-foreground">lead{preview.deletable === 1 ? "" : "s"} will be permanently deleted</div>
              </div>
              {preview.skippedWithOrders > 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="bulk-delete-skipped">
                  {n(preview.skippedWithOrders)} lead{preview.skippedWithOrders === 1 ? "" : "s"} with orders will be kept: orders and their customers are never deleted here.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">This cannot be undone. Their calls, notes, tasks and messages are deleted with them.</p>
              {needsAck ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={running} />
                  <span>
                    I understand that <strong>{n(preview.deletable)}</strong> leads across all pages will be deleted.
                  </span>
                </label>
              ) : null}
              {mode === "ALL" && !result ? (
                <div className="space-y-1.5">
                  <label htmlFor="delete-all-confirm" className="text-sm">
                    Type <strong className="font-mono">{DELETE_ALL_PHRASE}</strong> to confirm:
                  </label>
                  <input id="delete-all-confirm" data-testid="delete-all-confirm" className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={running} />
                </div>
              ) : null}
              {running ? (
                <div role="status" className="space-y-1 text-sm" data-testid="delete-progress">
                  <div className="flex justify-between">
                    <span>Deleting in batches… keep this window open.</span>
                    <span className="tabular-nums">{n(deleted)} / {n(preview.deletable)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={preview.deletable ? Math.floor((deleted / preview.deletable) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full bg-destructive transition-all" style={{ width: `${preview.deletable ? Math.min(100, (deleted / preview.deletable) * 100) : 0}%` }} />
                  </div>
                </div>
              ) : null}
              {result ? (
                <div className="sketch-outline space-y-1 bg-muted/40 p-3 text-sm" data-testid="delete-result">
                  <p className="font-semibold">{n(result.deleted)} lead{result.deleted === 1 ? "" : "s"} deleted.</p>
                  <p className="text-muted-foreground">
                    {result.skipped > 0 ? `${n(result.skipped)} lead${result.skipped === 1 ? " was" : "s were"} skipped because ${result.skipped === 1 ? "it has" : "they have"} orders: orders, payments, shipments and their customers are never deleted here.` : "No lead was skipped."}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {result ? (
              <Button type="button" onClick={onDone}>Close</Button>
            ) : (
              <>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirm} disabled={!canConfirm}>
              {running ? "Deleting…" : preview ? `${copy.button} (${n(preview.deletable)})` : copy.button}
            </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Mounts the dialog body only while open, so every opening starts with no stale count, no ticked box and no earlier error. */
export function BulkDeleteLeadsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; mode: BulkDeleteMode; leadIds: string[]; filter: LeadIdFilter | null; onDone: () => void }) {
  return props.open ? <BulkDeleteLeadsDialogInner {...props} /> : null;
}
