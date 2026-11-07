"use client";

import { AdminIncentivesPage } from "@/components/incentives/admin-incentives-page";
import { useAuthStore } from "@/stores/auth-store";

// Admin only; the API refuses everyone else as well.
export default function IncentivesRoute() {
  const role = useAuthStore((s) => s.user?.role);
  if (!role) return null;
  if (role !== "ADMIN") {
    return <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">Incentives are managed by admins. Your own incentive plan is on your dashboard.</p>;
  }
  return <AdminIncentivesPage />;
}
