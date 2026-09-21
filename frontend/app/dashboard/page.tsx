"use client";

import { useDashboard } from "@/hooks/useDashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { SalespersonDashboardView } from "@/components/dashboard/salesperson-dashboard";
import { ManagerDashboardView } from "@/components/dashboard/manager-dashboard";
import { AdminDashboardView } from "@/components/dashboard/admin-dashboard";

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
      {data.role === "SALESPERSON" && <SalespersonDashboardView data={data} />}
      {data.role === "MANAGER" && <ManagerDashboardView data={data} />}
      {data.role === "ADMIN" && <AdminDashboardView data={data} />}
    </>
  );
}
