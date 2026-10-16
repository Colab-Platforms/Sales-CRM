import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, STATUS_FILLS } from "@/lib/status";
import type { LeadWorkingStatus } from "@/lib/api-client/types/dashboard.types";

export function StatusBadge({
  status,
  className,
}: {
  status: LeadWorkingStatus;
  className?: string;
}) {
  return (
    <Badge variant="secondary" className={cn("font-medium text-foreground/80", className)}>
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", STATUS_FILLS[status])}
      />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
