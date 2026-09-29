import { Users, LayoutGrid, UsersRound } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import { ProfileHeaderCard } from "./profile-header-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ManagerProfile } from "@/lib/api-client/types/auth.types";

export function ManagerProfileView({ profile }: { profile: ManagerProfile }) {
  return (
    <div className="space-y-6">
      <ProfileHeaderCard profile={profile} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Groups" value={profile.groups.length} icon={LayoutGrid} tone="primary" />
        <StatCard label="Team Members" value={profile.teamMemberCount} icon={UsersRound} tone="teal" />
        <StatCard label="Leads Assigned" value={profile.stats.totalLeads} icon={Users} tone="amber" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Groups You Manage</CardTitle>
          <CardDescription>Your teams and how many people are in each.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Group</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-5 text-right">Members</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profile.groups.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    You haven&apos;t created any groups yet.
                  </TableCell>
                </TableRow>
              ) : (
                profile.groups.map((group) => (
                  <TableRow key={group.id}>
                    <TableCell className="pl-5 font-semibold">{group.name}</TableCell>
                    <TableCell>
                      <Badge variant={group.status === "ACTIVE" ? "default" : "secondary"}>{group.status}</Badge>
                    </TableCell>
                    <TableCell className="pr-5 text-right tabular-nums text-muted-foreground">
                      {group.memberCount}
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
