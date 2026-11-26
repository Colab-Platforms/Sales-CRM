"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthGuard } from "@/components/auth-guard";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { FollowUpReminders } from "@/components/follow-ups/follow-up-reminders";
import { AttendanceProvider } from "@/components/attendance/attendance-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useAuthStore } from "@/stores/auth-store";
import { isPathBlocked } from "@/lib/module-access";

function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname();
  const router = useRouter();
  // A module this user is restricted from: its URL (typed, bookmarked or linked) sends them to the dashboard. The server refuses the module's API as well.
  const blocked = isPathBlocked(pathname, user?.blockedModules);
  useEffect(() => {
    if (blocked) router.replace("/dashboard");
  }, [blocked, router]);
  if (!user || blocked) return null;

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      {/* <SidebarInset> */}
      {/* <div className="flex flex-1 flex-col gap-6 p-6">{children}</div> */}
      {/* Transparent so the paper dot-grid painted on <body> shows in the gutters. */}
      {/* min-w-0: a flex child otherwise grows to its widest content, so one wide table would stretch the whole
          page and slide it sideways under the sidebar. With it, wide tables scroll inside their own container. */}
      <SidebarInset className="min-w-0 bg-transparent">
        <SiteHeader showFollowUps={user.role !== "HR" && user.role !== "RECRUITER"} />
        {/* Global: call back / follow-up reminders fire on any dashboard page -
            except HR, who has no leads and isn't allowed to hit this endpoint. */}
        {user.role !== "HR" && user.role !== "RECRUITER" ? <FollowUpReminders /> : null}
        {/* Global: starts the salesperson's shift and holds their presence stream open on any page. */}
        <AttendanceProvider />
        <div className="mx-auto flex w-full max-w-[1600px] min-w-0 flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <DashboardShell>{children}</DashboardShell>
    </AuthGuard>
  );
}
