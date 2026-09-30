import { AlertTriangle, PhoneCall, ShoppingCart, TimerOff, TrendingUp } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import type { AbandonmentSummary } from "@/lib/api-client/types/abandonment.types";

export function AbandonmentSummaryCards({ summary }: { summary: AbandonmentSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard label="Total" value={summary.total} icon={ShoppingCart} tone="primary" />
      <StatCard label="Not yet contacted" value={summary.active} icon={AlertTriangle} tone="amber" />
      <StatCard label="Being worked" value={summary.inProgress} icon={PhoneCall} tone="teal" />
      <StatCard label="Recovered" value={summary.recovered} icon={TrendingUp} tone="emerald" />
      <StatCard label="Not recovered / expired" value={summary.notRecovered + summary.expired} icon={TimerOff} tone="default" />
    </div>
  );
}
