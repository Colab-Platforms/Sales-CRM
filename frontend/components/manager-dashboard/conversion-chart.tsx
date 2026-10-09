"use client";

import { conversionRate, formatPct } from "@/lib/manager-analytics";
import type { SalespersonStats } from "@/lib/api-client/types/manager-analytics.types";
import { HorizontalBarChart } from "./charts";
import { Panel } from "./panel";

export function ConversionPerformanceChart({
  people,
  targetPercent,
  onOpen,
}: {
  people: SalespersonStats[];
  targetPercent: number;
  onOpen: (id: string) => void;
}) {
  const rows = [...people]
    .sort((a, b) => conversionRate(b) - conversionRate(a))
    .map((p) => ({
      id: p.id,
      label: p.name,
      value: conversionRate(p),
      display: formatPct(conversionRate(p)),
      tone: p.leads === 0 ? ("default" as const) : conversionRate(p) >= targetPercent ? ("good" as const) : ("bad" as const),
    }));

  return (
    <Panel title="Team Conversion Performance" description="Converted ÷ assigned leads. Green meets target, amber is below.">
      <HorizontalBarChart rows={rows} target={{ value: targetPercent, label: `Team target: ${targetPercent}%` }} onRowClick={onOpen} />
    </Panel>
  );
}
