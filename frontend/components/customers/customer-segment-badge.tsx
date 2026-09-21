import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CUSTOMER_SEGMENT_COLORS, CUSTOMER_SEGMENT_LABELS } from "@/lib/customer-segment";
import type { CustomerSegment } from "@/lib/api-client/types/customers.types";

export function CustomerSegmentBadge({ segment }: { segment: CustomerSegment }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", CUSTOMER_SEGMENT_COLORS[segment])}>
      {CUSTOMER_SEGMENT_LABELS[segment]}
    </Badge>
  );
}
