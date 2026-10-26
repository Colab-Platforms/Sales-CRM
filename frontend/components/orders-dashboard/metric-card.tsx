import type { ComponentType } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { CardComparison, Coverage } from "@/lib/api-client/types/orders-dashboard.types";

export interface MetricCardProps {
  label: string;
  /** The number to show (already formatted). Ignored when `coverage` is NONE. */
  value: string;
  icon: ComponentType<{ className?: string }>;
  hint?: string;
  selected: boolean;
  onClick: () => void;
  testId: string;
  /** NONE = the CRM has no data for the period: the card says "No data", not 0. PARTIAL = the number counts only what has arrived. */
  coverage: Coverage;
  /** Shown only when real, fully covered history exists for both periods. */
  comparison?: CardComparison | null;
  comparisonLabel?: string;
}

/** One clickable summary card: white, bordered, rounded, green icon chip, big number, and a clear selected state. A real <button>, so it works from the keyboard. */
export function MetricCard({ label, value, icon: Icon, hint, selected, onClick, testId, coverage, comparison, comparisonLabel }: MetricCardProps) {
  const none = coverage === "NONE";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      data-testid={`card-${testId}`}
      className={`group flex min-h-[6.25rem] flex-col gap-1 rounded-xl border bg-card p-4 text-left shadow-sm outline-none transition hover:border-emerald-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-emerald-500 ${selected ? "border-emerald-500 bg-emerald-50/60 ring-2 ring-emerald-500 dark:bg-emerald-950/30" : ""}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="flex size-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><Icon className="size-4" /></span>
      </span>
      {none ? (
        <span className="text-lg font-semibold text-muted-foreground" data-testid={`card-value-${testId}`} title="The CRM holds no data for this period yet - this is not a real zero.">No data</span>
      ) : (
        <span className="text-2xl font-semibold tracking-tight" data-testid={`card-value-${testId}`}>{value}</span>
      )}
      {none ? (
        <span className="text-[11px] text-amber-700">Not received for this period</span>
      ) : comparison ? (
        <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${comparison.changePct === null ? "text-muted-foreground" : comparison.changePct >= 0 ? "text-emerald-700" : "text-rose-600"}`} data-testid={`card-compare-${testId}`}>
          {comparison.changePct === null ? null : comparison.changePct >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
          {comparison.changePct === null ? `was ${comparison.previous} ${comparisonLabel ?? ""}` : `${Math.abs(comparison.changePct)}% ${comparisonLabel ?? ""}`}
        </span>
      ) : coverage === "PARTIAL" ? (
        <span className="text-[11px] text-amber-700">Partial - data incomplete</span>
      ) : hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </button>
  );
}
