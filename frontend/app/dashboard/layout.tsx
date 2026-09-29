"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AuthGuard } from "@/components/auth-guard";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { FollowUpReminders } from "@/components/follow-ups/follow-up-reminders";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useAuthStore } from "@/stores/auth-store";

function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname();
  if (!user) return null;

  const title = pathname.startsWith("/dashboard/orders")
    ? "Orders"
    : pathname.startsWith("/dashboard/customers")
      ? "Customers"
      : pathname.startsWith("/dashboard/reconciliation")
        ? "Reconciliation"
        : pathname.startsWith("/dashboard/audit")
          ? "Audit Trail"
          : pathname.startsWith("/dashboard/whatsapp/templates")
            ? "WhatsApp Templates"
            : pathname.startsWith("/dashboard/whatsapp")
              ? "WhatsApp"
              : "Dashboard";

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      {/* <SidebarInset> */}
        {/* <div className="flex flex-1 flex-col gap-6 p-6">{children}</div> */}
      {/* Transparent so the paper dot-grid painted on <body> shows in the gutters. */}
      <SidebarInset className="bg-transparent">
        <SiteHeader />
        {/* Global: call back / follow-up reminders fire on any dashboard page. */}
        <FollowUpReminders />
        <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
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
