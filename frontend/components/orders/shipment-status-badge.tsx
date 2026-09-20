import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SHIPMENT_STATUS_COLORS, SHIPMENT_STATUS_LABELS } from "@/lib/order-status";
import type { ShipmentStatus } from "@/lib/api-client/types/orders.types";

export function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", SHIPMENT_STATUS_COLORS[status])}>
      {SHIPMENT_STATUS_LABELS[status]}
    </Badge>
  );
}
