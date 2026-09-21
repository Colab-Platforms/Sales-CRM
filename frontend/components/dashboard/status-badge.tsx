import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, STATUS_COLORS, STATUS_FILLS } from "@/lib/status";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";

export function StatusBadge({
  status,
  className,
}: {
  status: LeadWorkingStatus;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(STATUS_COLORS[status], className)}>
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", STATUS_FILLS[status])}
      />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
