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
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-sm text-destructive">{error ?? "Failed to load dashboard."}</p>;
  }

  return (
    <>
      {data.role === "SALESPERSON" && <SalespersonDashboardView data={data} />}
      {data.role === "MANAGER" && <ManagerDashboardView data={data} />}
      {data.role === "ADMIN" && <AdminDashboardView data={data} />}
    </>
  );
}
