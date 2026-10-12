import { AlertTriangle, ArrowUpRight, Info } from "lucide-react";
import { buildInsights, type Insight } from "@/lib/manager-analytics";
import type { ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { cn } from "@/lib/utils";
import { Panel } from "./panel";

const ICON = { positive: ArrowUpRight, neutral: Info, warning: AlertTriangle } as const;
const COLOR: Record<Insight["tone"], string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  neutral: "text-primary",
  warning: "text-amber-600 dark:text-amber-400",
};

/** Observations derived from the loaded metrics (see buildInsights); nothing here is hardcoded copy. */
export function PerformanceInsights({ data, periodLabel }: { data: ManagerAnalytics; periodLabel: string }) {
  const insights = buildInsights(data, periodLabel);
  return (
    <Panel title="Performance Insights" description="Calculated from the metrics above for the selected filters.">
      {insights.length === 0 ? (
        <p className="text-sm text-muted-foreground">Not enough activity to compare salespeople for this selection.</p>
      ) : (
        <ul className="space-y-2.5">
          {insights.map((i) => {
            const Icon = ICON[i.tone];
            return (
              <li key={i.text} className="flex items-start gap-2.5 text-sm">
                <Icon className={cn("mt-0.5 size-4 shrink-0", COLOR[i.tone])} aria-hidden="true" />
                <span>{i.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
