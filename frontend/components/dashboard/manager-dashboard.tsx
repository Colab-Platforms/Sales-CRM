import { Users, LayoutGrid, TrendingUp, Trophy } from "lucide-react";
import { StatCard } from "./stat-card";
import { StatusBreakdown } from "./status-breakdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ManagerDashboard } from "@/lib/api-client/types/dashboard.types";

export function ManagerDashboardView({ data }: { data: ManagerDashboard }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team Dashboard</h1>
        <p className="text-sm text-muted-foreground">Performance across your team.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Leads" value={data.totalLeads} icon={Users} />
        <StatCard label="Groups" value={data.groups.length} icon={LayoutGrid} />
        <StatCard label="Team Members" value={data.team.length} icon={TrendingUp} />
        <StatCard label="Converted" value={data.statusCounts.CONVERTED} icon={Trophy} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team status breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <StatusBreakdown counts={data.statusCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Salesperson performance</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Salesperson</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Working</TableHead>
                <TableHead className="text-right">Interested</TableHead>
                <TableHead className="text-right">Converted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.team.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    No team members yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.team.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <div className="font-medium">{member.name}</div>
                      <div className="text-xs text-muted-foreground">{member.email}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{member.totalLeads}</TableCell>
                    <TableCell className="text-right tabular-nums">{member.statusCounts.NEW}</TableCell>
                    <TableCell className="text-right tabular-nums">{member.statusCounts.WORKING}</TableCell>
                    <TableCell className="text-right tabular-nums">{member.statusCounts.INTERESTED}</TableCell>
                    <TableCell className="text-right tabular-nums">{member.statusCounts.CONVERTED}</TableCell>
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
