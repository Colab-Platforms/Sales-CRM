import { Clock, Navigation, Package, PackageCheck, RotateCcw, Truck } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import type { ShipmentSummary } from "@/lib/api-client/types/shiprocket.types";

// Real ShipmentStatus counts grouped for display - see shiprocket.list.filters.ts (backend) for exactly which
// statuses each group covers. Cancelled shipments are counted in "Total" and still visible via the status filter,
// but do not get their own headline card.
export function ShiprocketSummaryCards({ summary }: { summary: ShipmentSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total shipments" value={summary.total} icon={Package} tone="primary" />
      <StatCard label="Pending" value={summary.pending} icon={Clock} tone="amber" />
      <StatCard label="In transit" value={summary.inTransit} icon={Truck} tone="teal" />
      <StatCard label="Out for delivery" value={summary.outForDelivery} icon={Navigation} tone="teal" />
      <StatCard label="Delivered" value={summary.delivered} icon={PackageCheck} tone="emerald" />
      <StatCard label="RTO / Returned" value={summary.returned} icon={RotateCcw} tone="amber" />
    </div>
  );
}
