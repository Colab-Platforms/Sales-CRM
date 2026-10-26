import type { AmountPreview } from "@/lib/api-client/types/orders.types";

// Pure rules for the "Review & Correct Amount" dialog (tested).

/** The amount is only corrected with a current comparison, a proposal, every gate passing, an Admin / Manager, the explicit tick, the corrected total typed exactly, and nothing already running. */
export function canCorrect(p: AmountPreview | null, confirmed: boolean, typedTotal: string, busy: boolean): boolean {
  if (!p || !p.comparable || !p.proposal || !p.stateToken || !p.canApply || !p.canExecute || busy || !confirmed) return false;
  return typedTotal.trim() === p.proposal.after.total;
}

/** What the person is agreeing to, in one sentence. */
export const changeSentence = (p: AmountPreview): string | null =>
  p.proposal ? `Shopify total ${p.proposal.before.total} -> ${p.proposal.after.total} (outstanding ${p.proposal.before.outstanding} -> ${p.proposal.after.outstanding}), adding a ${p.proposal.amount} shipping line` : null;

export const failedGates = (p: AmountPreview | null) => (p ? p.gates.filter((g) => !g.ok) : []);
export const differingRows = (p: AmountPreview | null) => (p ? p.rows.filter((r) => r.status === "DIFFERENT") : []);

export function reviewedText(iso: string | null, fmt: (iso: string) => string): string {
  return iso ? `Last amount correction: ${fmt(iso)}` : "No amount correction recorded";
}
