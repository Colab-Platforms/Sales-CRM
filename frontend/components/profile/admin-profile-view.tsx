import { UserCog, Users, LayoutGrid, Target } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import { ProfileHeaderCard } from "./profile-header-card";
import type { AdminProfile } from "@/lib/api-client/types/auth.types";

export function AdminProfileView({ profile }: { profile: AdminProfile }) {
  return (
    <div className="space-y-6">
      <ProfileHeaderCard profile={profile} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Managers" value={profile.orgOverview.totalManagers} icon={UserCog} tone="primary" />
        <StatCard label="Salespersons" value={profile.orgOverview.totalSalespersons} icon={Users} tone="teal" />
        <StatCard label="Groups" value={profile.orgOverview.totalGroups} icon={LayoutGrid} tone="amber" />
        <StatCard label="Total Leads" value={profile.orgOverview.totalLeads} icon={Target} tone="emerald" />
      </div>
    </div>
  );
}
