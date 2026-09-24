import { Users, UsersRound, Mail, Phone } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import { ProfileHeaderCard } from "./profile-header-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/order-status";
import type { SalespersonProfile } from "@/lib/api-client/types/auth.types";

export function SalespersonProfileView({ profile }: { profile: SalespersonProfile }) {
  return (
    <div className="space-y-6">
      <ProfileHeaderCard profile={profile} />

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Total Leads" value={profile.stats.totalLeads} icon={Users} tone="primary" />
        <StatCard label="Teams" value={profile.teams.length} icon={UsersRound} tone="teal" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reporting Manager</CardTitle>
          <CardDescription>Who you report to.</CardDescription>
        </CardHeader>
        <CardContent>
          {profile.reportingManager ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Name</p>
                <p className="text-sm font-semibold">{profile.reportingManager.name}</p>
              </div>
              <div className="flex items-start gap-2">
                <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="text-sm">{profile.reportingManager.email}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Phone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">Phone</p>
                  <p className="text-sm">{profile.reportingManager.phone ?? "—"}</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No reporting manager assigned yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Teams</CardTitle>
          <CardDescription>Groups you&apos;re currently working in.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Team</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-5 text-right">Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.teams.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    You&apos;re not in a team yet.
                  </TableCell>
                </TableRow>
              ) : (
                profile.teams.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell className="pl-5 font-semibold">{team.name}</TableCell>
                    <TableCell>
                      <Badge variant={team.status === "ACTIVE" ? "default" : "secondary"}>{team.status}</Badge>
                    </TableCell>
                    <TableCell className="pr-5 text-right text-muted-foreground">
                      {formatDate(team.joinedAt)}
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
