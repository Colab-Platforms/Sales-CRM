import { formatNumber, formatPct, pct } from "@/lib/manager-analytics";
import { Panel } from "./panel";
import { cn } from "@/lib/utils";

interface Stage {
  label: string;
  value: number;
}

/**
 * Lead pipeline. Each stage shows its count, its share of total, and the step conversion from the
 * previous stage (the drop-off the manager cares about). `variant="team"` includes the Not Contacted
 * branch; the individual report uses the plain Assigned → Contacted → Interested → Converted chain.
 */
export function LeadFunnel({
  totalLabel = "Total Leads",
  total,
  notContacted,
  contacted,
  interested,
  converted,
  title = "Lead Pipeline",
  description = "Where leads are dropping off between stages.",
}: {
  totalLabel?: string;
  total: number;
  notContacted?: number;
  contacted: number;
  interested: number;
  converted: number;
  title?: string;
  description?: string;
}) {
  const stages: (Stage & { tone?: "muted" })[] = [
    { label: totalLabel, value: total },
    ...(notContacted !== undefined ? [{ label: "Not Contacted", value: notContacted, tone: "muted" as const }] : []),
    { label: "Contacted", value: contacted },
    { label: "Interested", value: interested },
    { label: "Converted", value: converted },
  ];
  const STAGE_COLORS = ["bg-blue-500", "bg-teal-500", "bg-amber-400", "bg-emerald-500"];
  const chain = stages.filter((s) => s.label !== "Not Contacted");

  return (
    <Panel title={title} description={description}>
      <ol className="space-y-3">
        {stages.map((s) => {
          const prev = s.tone === "muted" ? stages[0]! : chain[chain.indexOf(s) - 1];
          const share = pct(s.value, total);
          const step = prev && s !== stages[0] ? pct(s.value, prev.value) : null;
          return (
            <li key={s.label} className="grid grid-cols-[6.5rem_1fr] items-center gap-3 sm:grid-cols-[8rem_1fr_10rem]">
              <span className="text-sm font-medium">{s.label}<span className="block text-base font-semibold tabular-nums">{formatNumber(s.value)}</span></span>
              <div className="relative h-8 overflow-hidden rounded-md bg-muted/60">
                <div
                  className={cn("h-full rounded-md", s.tone === "muted" ? "bg-slate-300 dark:bg-slate-600" : STAGE_COLORS[chain.indexOf(s)] ?? "bg-primary")}
                  style={{ width: `${Math.max(share, s.value > 0 ? 2 : 0)}%` }}
                />
              </div>
              <div className="col-span-2 flex justify-between text-xs text-muted-foreground tabular-nums sm:col-span-1 sm:block sm:text-right">
                <span>{formatPct(share)} of total</span>
                {step !== null ? (
                  <span className="sm:block">
                    {formatPct(step)} {s.tone === "muted" ? "of total" : `of ${prev!.label.toLowerCase()}`}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 border-t border-border/70 pt-3 text-xs text-muted-foreground">
        Conversion rate (converted ÷ {totalLabel.toLowerCase()}):{" "}
        <span className="font-semibold text-foreground">{formatPct(pct(converted, total), 2)}</span>
      </p>
    </Panel>
  );
}
