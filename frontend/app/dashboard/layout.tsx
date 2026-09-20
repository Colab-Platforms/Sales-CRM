"use client";

import type { ReactNode } from "react";
import { AuthGuard } from "@/components/auth-guard";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useAuthStore } from "@/stores/auth-store";

function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      {/* Transparent so the paper dot-grid painted on <body> shows in the gutters. */}
      <SidebarInset className="bg-transparent">
        <SiteHeader />
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
