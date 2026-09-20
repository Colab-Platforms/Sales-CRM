import { Users, LayoutGrid, Trophy, UserCog } from "lucide-react";
import { StatCard } from "./stat-card";
import { StatusBreakdown } from "./status-breakdown";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AdminDashboard } from "@/lib/api-client/types/dashboard.types";

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Admins",
  MANAGER: "Managers",
  SALESPERSON: "Salespeople",
};

export function AdminDashboardView({ data }: { data: AdminDashboard }) {
  const conversionRate =
    data.totalLeads === 0
      ? 0
      : Math.round((data.statusCounts.CONVERTED / data.totalLeads) * 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organization Dashboard"
        description="Org-wide performance snapshot across every team and lead source."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Leads" value={data.totalLeads} icon={Users} tone="primary" />
        <StatCard label="Total Groups" value={data.totalGroups} icon={LayoutGrid} />
        <StatCard
          label="Converted"
          value={data.statusCounts.CONVERTED}
          hint={`${conversionRate}% of all leads`}
          icon={Trophy}
          tone="emerald"
        />
        <StatCard
          label="Unassigned"
          value={data.statusCounts.NEW}
          hint="waiting on a manager"
          icon={UserCog}
          tone="amber"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lead status breakdown</CardTitle>
          <CardDescription>Where every lead in the organization currently sits.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBreakdown counts={data.statusCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users by role</CardTitle>
          <CardDescription>Headcount across the platform.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {data.usersByRole.map((r) => (
            <div
              key={r.role}
              className="sketch-outline flex min-w-32 flex-col gap-0.5 px-4 py-3"
            >
              <span className="text-xs font-medium text-muted-foreground">
                {ROLE_LABELS[r.role] ?? r.role}
              </span>
              <span className="text-xl leading-tight font-extrabold tabular-nums">{r.count}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
