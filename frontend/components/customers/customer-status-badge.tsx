import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LEAD_STATUS_COLORS, LEAD_STATUS_LABELS } from "@/lib/customer-status";
import type { LeadWorkingStatus } from "@/lib/api-client/types/customers.types";

export function CustomerStatusBadge({ status }: { status: LeadWorkingStatus }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", LEAD_STATUS_COLORS[status])}>
      {LEAD_STATUS_LABELS[status]}
    </Badge>
  );
}
