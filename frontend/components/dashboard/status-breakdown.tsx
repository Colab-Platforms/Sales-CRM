import { StatusBadge } from "./status-badge";
import { STATUS_ORDER } from "@/lib/status";
import type { StatusCounts } from "@/lib/api-client/types/dashboard.types";

export function StatusBreakdown({ counts }: { counts: StatusCounts }) {
  return (
    <div className="flex flex-wrap gap-2">
      {STATUS_ORDER.map((status) => (
        <div key={status} className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm">
          <StatusBadge status={status} />
          <span className="font-medium tabular-nums">{counts[status]}</span>
        </div>
      ))}
    </div>
  );
}
