import { CheckCircle2, Clock, IndianRupee, RotateCcw, ShoppingBag } from "lucide-react";
import type { ComponentType } from "react";
import type { AbandonedMetric, AbandonedQuery, AbandonedSummary } from "@/lib/api-client/types/orders-dashboard.types";
import { formatInr } from "./orders-dashboard-form";

/** The abandoned-checkout cards. COD / prepaid is deliberately absent: an abandoned-checkout event carries no payment mode, so there is no true number to show. */
export const ABANDONED_CARDS: { key: AbandonedMetric; label: string; hint?: string }[] = [
  { key: "TOTAL", label: "Total Abandoned Checkouts", hint: "Excludes carts that were later bought" },
  { key: "VALUE", label: "Potential Abandoned Value", hint: "Open carts only (active or being worked)" },
  { key: "PENDING", label: "Follow-up Pending", hint: "No follow-up finished yet" },
  { key: "DONE", label: "Follow-up Completed", hint: "A call / callback / continue-order finished" },
  { key: "RECOVERED", label: "Recovered", hint: "Purchase completed - not counted as abandoned" },
];

export const abandonedCardLabel = (m: AbandonedMetric): string => ABANDONED_CARDS.find((c) => c.key === m)!.label;

export function abandonedCardValue(s: AbandonedSummary, m: AbandonedMetric): string {
  switch (m) {
    case "TOTAL": return String(s.totalAbandoned);
    case "VALUE": return formatInr(s.potentialValue);
    case "PENDING": return String(s.followUpPending);
    case "DONE": return String(s.followUpCompleted);
    case "RECOVERED": return String(s.recovered);
  }
}

export const FOLLOW_UP_LABEL = { PENDING: "Pending", DONE: "Completed", RECOVERED: "Recovered (bought)" } as const;

/** Clicking a card opens (or re-targets) the one details section; the date range and search stay, the page restarts. Nothing is selected on load. */
export const selectAbandonedCard = (q: AbandonedQuery, metric: AbandonedMetric): AbandonedQuery => ({ ...q, metric, page: 1 });
/** Back to cards only; the date range is kept. */
export const closeAbandonedDetails = (q: AbandonedQuery): AbandonedQuery => ({ range: q.range, from: q.from, to: q.to, page: 1, pageSize: q.pageSize });
export const abandonedSearch = (q: AbandonedQuery, search: string | undefined): AbandonedQuery => ({ ...q, search, page: 1 });

export const ABANDONED_ICONS: Record<AbandonedMetric, ComponentType<{ className?: string }>> = { TOTAL: ShoppingBag, VALUE: IndianRupee, PENDING: Clock, DONE: CheckCircle2, RECOVERED: RotateCcw };
