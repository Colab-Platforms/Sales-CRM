import { Users, LayoutGrid, Building2 } from "lucide-react";
import { StatCard } from "./stat-card";
import { StatusBreakdown } from "./status-breakdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AdminDashboard } from "@/lib/api-client/types/dashboard.types";

export function AdminDashboardView({ data }: { data: AdminDashboard }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Organization Dashboard</h1>
        <p className="text-sm text-muted-foreground">Org-wide performance snapshot.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total Leads" value={data.totalLeads} icon={Users} />
        <StatCard label="Total Groups" value={data.totalGroups} icon={LayoutGrid} />
        <StatCard label="Converted" value={data.statusCounts.CONVERTED} icon={Building2} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lead status breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <StatusBreakdown counts={data.statusCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Users by role</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {data.usersByRole.map((r) => (
            <div key={r.role} className="rounded-lg border px-3 py-2 text-sm">
              <span className="font-medium">{r.role}</span>
              <span className="ml-2 text-muted-foreground">{r.count}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
