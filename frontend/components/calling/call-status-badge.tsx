import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CALL_STATUS_COLORS, CALL_STATUS_LABELS } from "@/lib/call-status";
import type { CallStatus } from "@/lib/api-client/types/calls.types";

export function CallStatusBadge({ status, className }: { status: CallStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn(CALL_STATUS_COLORS[status], className)}>
      {CALL_STATUS_LABELS[status]}
    </Badge>
  );
}
