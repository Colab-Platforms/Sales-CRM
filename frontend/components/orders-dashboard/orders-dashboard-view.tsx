"use client";

import { useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { AbandonedPanel } from "./abandoned-panel";
import { TelecallerPanel } from "./telecaller-panel";
import { DateRangeBar } from "./date-range-bar";
import { WebsiteOrdersPanel } from "./website-orders-panel";
import { DEFAULT_RANGE, type RangeState } from "./orders-dashboard-form";

export function OrdersDashboardView() {
  const role = useAuthStore((s) => s.user?.role);
  return <OrdersDashboard allowed={role === "ADMIN" || role === "MANAGER"} />;
}

/**
 * The page: ONE date range (Yesterday by default) drives everything, and the sections are stacked on the one page, each with its own cards and details:
 *   1. Website Orders  2. Abandoned Checkouts. Data only: the trend charts were removed from this page (their components and APIs remain for other uses).
 * Website orders and abandoned checkouts are separate datasets: separate counts, values, records. `allowed` = Admin or Manager (the server enforces the same rule on every request).
 */
export function OrdersDashboard({ allowed }: { allowed: boolean }) {
  const [range, setRange] = useState<RangeState>(DEFAULT_RANGE);

  if (!allowed) {
    return (
      <div role="alert" className="py-10 text-center text-sm text-muted-foreground" data-testid="orders-dashboard-forbidden">
        This dashboard is available to Admin and Manager users only.
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="orders-dashboard">
      <PageHeader title="Orders Dashboard" description="Website orders, telecaller performance and abandoned checkouts for the selected date range. Click a card to see the records behind it." />

      <Card>
        <CardContent className="py-4">
          <DateRangeBar value={range} onChange={setRange} />
        </CardContent>
      </Card>

      <WebsiteOrdersPanel range={range} />
      <TelecallerPanel range={range} />
      <AbandonedPanel range={range} />
    </div>
  );
}
