import { Users, LayoutGrid, UsersRound, Trophy } from "lucide-react";
import { StatCard } from "./stat-card";
import { StatusBreakdown } from "./status-breakdown";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ManagerDashboard } from "@/lib/api-client/types/dashboard.types";

export function ManagerDashboardView({ data }: { data: ManagerDashboard }) {
  const conversionRate =
    data.totalLeads === 0
      ? 0
      : Math.round((data.statusCounts.CONVERTED / data.totalLeads) * 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team Dashboard"
        description="Performance across your groups and the salespeople working your leads."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Leads" value={data.totalLeads} icon={Users} tone="primary" />
        <StatCard label="Groups" value={data.groups.length} icon={LayoutGrid} />
        <StatCard label="Team Members" value={data.team.length} icon={UsersRound} tone="teal" />
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
          <CardTitle>Team status breakdown</CardTitle>
          <CardDescription>How your team&apos;s pipeline is distributed.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBreakdown counts={data.statusCounts} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Salesperson performance</CardTitle>
          <CardDescription>Lead volume and stage mix per team member.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Salesperson</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Follow up</TableHead>
                <TableHead className="text-right">Interested</TableHead>
                <TableHead className="pr-5 text-right">Converted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.team.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No team members yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.team.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell className="pl-5">
                      <div className="font-semibold">{member.name}</div>
                      <div className="text-xs text-muted-foreground">{member.email}</div>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {member.totalLeads}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {member.statusCounts.NEW}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {member.statusCounts.FOLLOW_UP}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {member.statusCounts.INTERESTED}
                    </TableCell>
                    <TableCell className="pr-5 text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                      {member.statusCounts.CONVERTED}
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
