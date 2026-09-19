import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, STATUS_COLORS } from "@/lib/status";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";

export function StatusBadge({ status }: { status: LeadWorkingStatus }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", STATUS_COLORS[status])}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
