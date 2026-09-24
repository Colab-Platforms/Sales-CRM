"use client";

import { useQuery } from "@tanstack/react-query";
import { profileQueryOptions } from "@/lib/api-client/queries/auth.queries";
import { getErrorMessage } from "@/lib/api-client/client";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { SalespersonProfileView } from "@/components/profile/salesperson-profile-view";
import { ManagerProfileView } from "@/components/profile/manager-profile-view";
import { AdminProfileView } from "@/components/profile/admin-profile-view";

export default function ProfilePage() {
  const { data: profile, isPending, error } = useQuery(profileQueryOptions());

  return (
    <div className="space-y-6">
      <PageHeader title="My Profile" description="Your account details and where you fit in the organization." />

      {isPending ? (
        <div className="space-y-6">
          <Skeleton className="h-40 rounded-xl" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : error || !profile ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load profile.")}
        </div>
      ) : (
        <>
          {profile.role === "SALESPERSON" && <SalespersonProfileView profile={profile} />}
          {profile.role === "MANAGER" && <ManagerProfileView profile={profile} />}
          {profile.role === "ADMIN" && <AdminProfileView profile={profile} />}
        </>
      )}
    </div>
  );
}
