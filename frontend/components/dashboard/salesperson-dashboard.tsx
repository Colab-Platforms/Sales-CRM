import { Users, TrendingUp, Target, Trophy } from "lucide-react";
import { StatCard } from "./stat-card";
import { StatusBreakdown } from "./status-breakdown";
import { StatusBadge } from "./status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SalespersonDashboard } from "@/lib/api-client/types/dashboard.types";

export function SalespersonDashboardView({ data }: { data: SalespersonDashboard }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Dashboard</h1>
        <p className="text-sm text-muted-foreground">Your leads and pipeline at a glance.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Leads" value={data.totalLeads} icon={Users} />
        <StatCard label="Working" value={data.statusCounts.WORKING} icon={TrendingUp} />
        <StatCard label="Interested" value={data.statusCounts.INTERESTED} icon={Target} />
        <StatCard label="Converted" value={data.statusCounts.CONVERTED} icon={Trophy} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <StatusBreakdown counts={data.statusCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent leads</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead className="text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentLeads.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No leads yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.recentLeads.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell>
                      <div className="font-medium">
                        {lead.firstName} {lead.lastName ?? ""}
                      </div>
                      <div className="text-xs text-muted-foreground">{lead.leadNumber}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={lead.workingStatus} />
                    </TableCell>
                    <TableCell>{lead.priority}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
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
