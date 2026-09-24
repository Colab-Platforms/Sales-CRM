import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerSegmentBadge } from "./customer-segment-badge";
import { formatDate, formatMoney } from "@/lib/order-status";
import type { CustomerSegmentInfo } from "@/lib/api-client/types/customers.types";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function CustomerSegmentCard({ segment, currency }: { segment: CustomerSegmentInfo; currency: string }) {
  const { metrics } = segment;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>Customer Segment</CardTitle>
          <CustomerSegmentBadge segment={segment.segment} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{segment.reason}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Orders" value={String(metrics.orderCount)} />
          <Stat label="Successful orders" value={String(metrics.successfulOrderCount)} />
          <Stat label="Total paid" value={formatMoney(metrics.totalPaid, currency)} />
          <Stat
            label="Last order"
            value={metrics.latestOrderAt ? `${formatDate(metrics.latestOrderAt)} (${metrics.daysSinceLastOrder}d ago)` : "Never"}
          />
        </div>
      </CardContent>
    </Card>
  );
}
