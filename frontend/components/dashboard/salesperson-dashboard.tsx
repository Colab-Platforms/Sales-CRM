import { Users, TrendingUp, Target, Trophy } from "lucide-react";
import { StatCard } from "./stat-card";
import { StatusBreakdown } from "./status-breakdown";
import { StatusBadge } from "./status-badge";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SalespersonDashboard } from "@/lib/api-client/types/dashboard.types";

export function SalespersonDashboardView({ data }: { data: SalespersonDashboard }) {
  const conversionRate =
    data.totalLeads === 0
      ? 0
      : Math.round((data.statusCounts.CONVERTED / data.totalLeads) * 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Dashboard"
        description="Your leads and pipeline at a glance."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Leads" value={data.totalLeads} icon={Users} tone="primary" />
        <StatCard label="Follow up" value={data.statusCounts.FOLLOW_UP} icon={TrendingUp} tone="amber" />
        <StatCard label="Interested" value={data.statusCounts.INTERESTED} icon={Target} tone="teal" />
        <StatCard
          label="Converted"
          value={data.statusCounts.CONVERTED}
          hint={`${conversionRate}% conversion`}
          icon={Trophy}
          tone="emerald"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status breakdown</CardTitle>
          <CardDescription>Where your leads currently sit.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBreakdown counts={data.statusCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent leads</CardTitle>
          <CardDescription>Your most recently updated leads.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Lead</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead className="pr-5 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentLeads.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    No leads yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.recentLeads.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell className="pl-5">
                      <div className="font-semibold">
                        {lead.firstName} {lead.lastName ?? ""}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {lead.leadNumber}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={lead.workingStatus} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{lead.priority}</TableCell>
                    <TableCell className="pr-5 text-right text-muted-foreground">
                      {new Date(lead.updatedAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
