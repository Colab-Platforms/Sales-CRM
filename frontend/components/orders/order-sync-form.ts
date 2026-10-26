import type { SyncActionId, SyncApplyResponse, SyncItem, SyncPreview } from "@/lib/api-client/types/orders.types";

// Pure rules for the "Sync / Update from CRM" dialog (kept out of the component so they are tested).

/** The differences the server says it may write - the only ones the dialog lets the person tick. */
export const syncableItems = (p: SyncPreview | null): SyncItem[] => (p ? p.items.filter((i) => i.status === "DIFFERENT" && i.action) : []);
/** Differences that can NOT be synced automatically (shown with their reason). */
export const manualItems = (p: SyncPreview | null): SyncItem[] => (p ? p.items.filter((i) => i.status === "DIFFERENT" && !i.action) : []);

/** Every syncable change ticked by default - the person can untick before confirming. */
export const defaultSelection = (p: SyncPreview | null): SyncActionId[] => syncableItems(p).map((i) => i.action!) as SyncActionId[];

/** The Apply button is enabled only with a fresh comparison, at least one ticked change that is still allowed, the explicit confirmation and nothing running. */
export function canApply(p: SyncPreview | null, selected: SyncActionId[], confirmed: boolean, busy: boolean): boolean {
  if (!p || !p.comparable || !p.stateToken || busy || !confirmed) return false;
  const allowed = new Set(syncableItems(p).map((i) => i.action));
  return selected.length > 0 && selected.every((a) => allowed.has(a));
}

export const OUTCOME_TONE: Record<SyncApplyResponse["outcome"], "success" | "warning" | "error"> = { synced: "success", partial: "warning", blocked: "warning", failed: "error" };

export function lastSyncText(iso: string | null, fmt: (iso: string) => string): string {
  return iso ? `Last successful sync: ${fmt(iso)}` : "Never synced from the CRM";
}
