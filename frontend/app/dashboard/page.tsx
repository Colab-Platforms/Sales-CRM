"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDashboard } from "@/hooks/useDashboard";
import { useAuthStore } from "@/stores/auth-store";
import { HOME_BY_ROLE } from "@/components/app-sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { SalespersonDashboardView } from "@/components/dashboard/salesperson-dashboard";
import { ManagerSalesDashboard } from "@/components/manager-dashboard/manager-sales-dashboard";
import { AdminDashboardView } from "@/components/dashboard/admin-dashboard";
import { LeadDistributionDashboard } from "@/components/abandonment/lead-distribution-dashboard";
import { TelecallerLeadSummary } from "@/components/abandonment/telecaller-lead-summary";

export default function DashboardPage() {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const { data, isLoading, error } = useDashboard();

  // HR and recruiters have no dashboard - send them to their main page instead.
  const home = role ? HOME_BY_ROLE[role] : undefined;
  useEffect(() => {
    if (home) router.replace(home);
  }, [home, router]);

  if (home) return null;

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
    </>
  );
}
