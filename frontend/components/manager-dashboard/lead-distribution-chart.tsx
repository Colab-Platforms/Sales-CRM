"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/manager-analytics";
import type { SalespersonStats } from "@/lib/api-client/types/manager-analytics.types";
import { HorizontalBarChart } from "./charts";
import { Panel, Segmented } from "./panel";

type Metric = "leads" | "contacted" | "interested" | "converted";

const OPTIONS: { value: Metric; label: string }[] = [
  { value: "leads", label: "Total Leads" },
  { value: "contacted", label: "Contacted" },
  { value: "interested", label: "Interested" },
  { value: "converted", label: "Converted" },
];

export function LeadDistributionChart({ people, onOpen }: { people: SalespersonStats[]; onOpen: (id: string) => void }) {
  const [metric, setMetric] = useState<Metric>("leads");
  const rows = [...people]
    .sort((a, b) => b[metric] - a[metric])
    .map((p) => ({ id: p.id, label: p.name, value: p[metric], display: formatNumber(p[metric]) }));

  return (
    <Panel
      title="Lead Distribution by Salesperson"
      description="Select a bar to open that salesperson's report."
      actions={<Segmented label="Lead metric" value={metric} options={OPTIONS} onChange={setMetric} />}
    >
      <HorizontalBarChart rows={rows} onRowClick={onOpen} />
    </Panel>
  );
}
