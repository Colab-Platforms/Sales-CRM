import { ClipboardList } from "lucide-react";
import { StatCard } from "@/components/dashboard/stat-card";
import { ProfileHeaderCard } from "./profile-header-card";
import type { RecruiterProfile } from "@/lib/api-client/types/auth.types";

export function RecruiterProfileView({ profile }: { profile: RecruiterProfile }) {
  return (
    <div className="space-y-6">
      <ProfileHeaderCard profile={profile} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Assigned applications" value={profile.stats.totalApplications} icon={ClipboardList} tone="primary" />
      </div>
    </div>
  );
}
