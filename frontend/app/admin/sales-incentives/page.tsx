"use client";

import { AdminIncentivesPage } from "@/components/incentives/admin-incentives-page";
import { useAuthStore } from "@/stores/auth-store";

// Admin only. The incentive APIs refuse every other role as well, so hiding the page is not the protection.
export default function SalesIncentivesRoute() {
  const role = useAuthStore((s) => s.user?.role);
  if (!role) return null;
  if (role !== "ADMIN") {
    return <p className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">Sales incentives are managed by admins. Your own incentive plan is on your dashboard.</p>;
  }
  return <AdminIncentivesPage />;
}
