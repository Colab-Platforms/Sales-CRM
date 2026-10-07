import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { refundDisplay } from "@/lib/refund-status";
import type { RefundExecutionStatus, RefundRequestStatus } from "@/lib/api-client/types/refunds.types";

export function RefundStatusBadge({ status, executionStatus }: { status: RefundRequestStatus; executionStatus?: RefundExecutionStatus | null }) {
  const d = refundDisplay({ status, executionStatus });
  return (
    <Badge variant="outline" className={cn("border-current/20", d.style)} data-testid="refund-status">
      {d.label}
    </Badge>
  );
}
