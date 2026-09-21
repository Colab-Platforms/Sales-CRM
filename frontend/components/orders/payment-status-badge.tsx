import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  NO_PAYMENT_COLOR,
  NO_PAYMENT_LABEL,
  PAYMENT_STATUS_COLORS,
  PAYMENT_STATUS_LABELS,
} from "@/lib/order-status";
import type { PaymentStatus } from "@/lib/api-client/types/orders.types";

// `null` means the order has no payment record yet.
export function PaymentStatusBadge({ status }: { status: PaymentStatus | null }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent", status ? PAYMENT_STATUS_COLORS[status] : NO_PAYMENT_COLOR)}
    >
      {status ? PAYMENT_STATUS_LABELS[status] : NO_PAYMENT_LABEL}
    </Badge>
  );
}
