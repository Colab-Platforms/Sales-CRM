import { UserCog, Users, LayoutGrid } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import { ProfileHeaderCard } from "./profile-header-card";
import type { HrProfile } from "@/lib/api-client/types/auth.types";

export function HrProfileView({ profile }: { profile: HrProfile }) {
  return (
    <div className="space-y-6">
      <ProfileHeaderCard profile={profile} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Managers" value={profile.orgOverview.totalManagers} icon={UserCog} tone="primary" />
        <StatCard label="Salespersons" value={profile.orgOverview.totalSalespersons} icon={Users} tone="teal" />
        <StatCard label="Groups" value={profile.orgOverview.totalGroups} icon={LayoutGrid} tone="amber" />
      </div>
    </div>
  );
}
