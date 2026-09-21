import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { RECONCILIATION_STATUS_COLORS, RECONCILIATION_STATUS_LABELS } from "@/lib/reconciliation-status";
import type { ReconciliationStatus } from "@/lib/api-client/types/reconciliation.types";

export function ReconciliationStatusBadge({ status }: { status: ReconciliationStatus }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", RECONCILIATION_STATUS_COLORS[status])}>
      {RECONCILIATION_STATUS_LABELS[status]}
    </Badge>
  );
}
