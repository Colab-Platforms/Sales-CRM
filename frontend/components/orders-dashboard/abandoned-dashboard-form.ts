import { Banknote, CheckCircle2, Clock, CreditCard, IndianRupee, Percent, RotateCcw, ShoppingBag, Wallet } from "lucide-react";
import type { ComponentType } from "react";
import type { AbandonedMetric, AbandonedQuery, AbandonedSummary } from "@/lib/api-client/types/orders-dashboard.types";
import { formatInr } from "./orders-dashboard-form";

/** The abandoned-checkout cards. COD / prepaid is deliberately absent: an abandoned-checkout event carries no payment mode, so there is no true number to show. */
export const ABANDONED_CARDS: { key: AbandonedMetric; label: string; hint?: string }[] = [
  { key: "TOTAL", label: "Open Abandoned Checkouts", hint: "Not recovered and not yet converted into an order" },
  { key: "VALUE", label: "Potential Abandoned Value", hint: "Cart value still open - NOT revenue" },
  { key: "PENDING", label: "Follow-up Pending", hint: "No follow-up finished yet" },
  { key: "DONE", label: "Follow-up Completed", hint: "A call / callback / continue-order finished" },
  { key: "RECOVERED", label: "Recovered", hint: "Purchase completed - not counted as abandoned" },
];

const BREAKDOWN_LABEL: Partial<Record<AbandonedMetric, string>> = { DETECTED: "Total Abandoned Checkouts", CONVERTED: "Orders Converted", COD: "COD Orders", PREPAID: "Prepaid Orders" };
export const abandonedCardLabel = (m: AbandonedMetric): string => BREAKDOWN_LABEL[m] ?? ABANDONED_CARDS.find((c) => c.key === m)!.label;
/** Breakdowns whose rows are the converted checkouts: their table also shows the linked order. */
export const isOrderBreakdown = (m: AbandonedMetric): boolean => m === "CONVERTED" || m === "COD" || m === "PREPAID";

export function abandonedCardValue(s: AbandonedSummary, m: AbandonedMetric): string {
  switch (m) {
    case "TOTAL": return String(s.totalAbandoned);
    case "VALUE": return formatInr(s.potentialValue);
    case "PENDING": return String(s.followUpPending);
    case "DONE": return String(s.followUpCompleted);
    case "RECOVERED": return String(s.recovered);
    case "CONVERTED": return String(s.conversion.converted);
    case "DETECTED": return String(s.detected);
    case "COD": return String(s.conversion.cod.count);
    case "PREPAID": return String(s.conversion.prepaid.count);
  }
}

export type ConversionCardKey = "DETECTED" | "CONVERTED" | "RATE" | "REVENUE" | "PREPAID" | "COD";
/** Conversion & revenue cards: what telecallers turned into real orders. Revenue is the ACTUAL order value (COD + verified prepaid) and is never mixed with the potential cart value above. */
export const CONVERSION_CARDS: { key: ConversionCardKey; label: string; hint: string; metric?: AbandonedMetric }[] = [
  { key: "DETECTED", label: "Total Abandoned Checkouts", hint: "Every checkout detected in the period, counted once", metric: "DETECTED" },
  { key: "CONVERTED", label: "Orders Converted", hint: "Orders created from a checkout: COD, or prepaid with verified payment", metric: "CONVERTED" },
  { key: "RATE", label: "Conversion Rate", hint: "Orders converted / total abandoned checkouts" },
  { key: "REVENUE", label: "Revenue Generated", hint: "Actual order value of the converted orders", metric: "CONVERTED" },
  { key: "PREPAID", label: "Prepaid Orders", hint: "Verified online payments - count and order value", metric: "PREPAID" },
  { key: "COD", label: "COD Orders", hint: "Cash on delivery - count and order value", metric: "COD" },
];

export function conversionCardValue(s: AbandonedSummary, k: ConversionCardKey): string {
  const c = s.conversion;
  switch (k) {
    case "DETECTED": return String(s.detected);
    case "CONVERTED": return String(c.converted);
    case "RATE": return c.conversionRate === null ? "Not available" : `${c.conversionRate}%`;
    case "REVENUE": return formatInr(c.revenue);
    case "PREPAID": return `${c.prepaid.count} | ${formatInr(c.prepaid.revenue)}`;
    case "COD": return `${c.cod.count} | ${formatInr(c.cod.revenue)}`;
  }
}

export function conversionCardHint(s: AbandonedSummary, k: ConversionCardKey): string | undefined {
  const base = CONVERSION_CARDS.find((c) => c.key === k)?.hint;
  if (k === "PREPAID" && s.conversion.awaitingPayment > 0) return `${base}. ${s.conversion.awaitingPayment} prepaid order(s) awaiting payment are not counted`;
  if (k === "CONVERTED" && s.conversion.unclassified > 0) return `${base}. ${s.conversion.unclassified} order(s) with no payment mode are not counted`;
  return base;
}

export const FOLLOW_UP_LABEL = { PENDING: "Pending", DONE: "Completed", RECOVERED: "Recovered (bought)" } as const;

/** Clicking a card opens (or re-targets) the one details section; the date range and search stay, the page restarts. Nothing is selected on load. */
export const selectAbandonedCard = (q: AbandonedQuery, metric: AbandonedMetric): AbandonedQuery => ({ ...q, metric, page: 1 });
/** Back to cards only; the date range is kept. */
export const closeAbandonedDetails = (q: AbandonedQuery): AbandonedQuery => ({ range: q.range, from: q.from, to: q.to, page: 1, pageSize: q.pageSize });
export const abandonedSearch = (q: AbandonedQuery, search: string | undefined): AbandonedQuery => ({ ...q, search, page: 1 });

export const ABANDONED_ICONS: Record<AbandonedMetric, ComponentType<{ className?: string }>> = { TOTAL: ShoppingBag, VALUE: IndianRupee, PENDING: Clock, DONE: CheckCircle2, RECOVERED: RotateCcw, CONVERTED: CheckCircle2, DETECTED: ShoppingBag, COD: Banknote, PREPAID: CreditCard };
export const CONVERSION_ICONS: Record<ConversionCardKey, ComponentType<{ className?: string }>> = { DETECTED: ShoppingBag, CONVERTED: CheckCircle2, RATE: Percent, REVENUE: Wallet, PREPAID: CreditCard, COD: Banknote };
