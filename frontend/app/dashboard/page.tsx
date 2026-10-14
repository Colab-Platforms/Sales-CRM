"use client";

import { useDashboard } from "@/hooks/useDashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { SalespersonDashboardView } from "@/components/dashboard/salesperson-dashboard";
import { ManagerSalesDashboard } from "@/components/manager-dashboard/manager-sales-dashboard";
import { AdminDashboardView } from "@/components/dashboard/admin-dashboard";
import { LeadDistributionDashboard } from "@/components/abandonment/lead-distribution-dashboard";
import { TelecallerLeadSummary } from "@/components/abandonment/telecaller-lead-summary";

export default function DashboardPage() {
  const { data, isLoading, error } = useDashboard();
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {error ?? "Failed to load dashboard."}
      </div>
    );
  }

  return (
    <>
      {data.role === "SALESPERSON" && (
        <div className="space-y-8">
          <TelecallerLeadSummary />
          <SalespersonDashboardView data={data} />
        </div>
      )}
      {data.role === "MANAGER" && (
        <div className="space-y-8">
          <ManagerSalesDashboard />
          <LeadDistributionDashboard />
        </div>
      )}
      {data.role === "ADMIN" && (
        <div className="space-y-8">
          <AdminDashboardView data={data} />
          <LeadDistributionDashboard />
        </div>
      )}
      {/* HR distributes abandoned leads but cannot open them (no lead pages) - so the breakdown has no "View details" into lead records beyond the filtered list. */}
      {data.role === "HR" && (
        <div className="space-y-6">
          <div className="space-y-1">
            <h1 className="font-heading text-2xl font-extrabold">Lead distribution</h1>
            <p className="text-sm text-muted-foreground">How many abandoned leads there are, who holds them, and what is still waiting for a telecaller.</p>
          </div>
          <LeadDistributionDashboard title="Telecaller breakdown" />
        </div>
      )}
    </>
  );
}
