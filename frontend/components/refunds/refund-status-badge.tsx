import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { REFUND_STATUS_LABELS, REFUND_STATUS_STYLES } from "@/lib/refund-status";
import type { RefundRequestStatus } from "@/lib/api-client/types/refunds.types";

export function RefundStatusBadge({ status }: { status: RefundRequestStatus }) {
  return (
    <Badge variant="outline" className={cn("border-current/20", REFUND_STATUS_STYLES[status])} data-testid="refund-status">
      {REFUND_STATUS_LABELS[status]}
    </Badge>
  );
}
