"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AuthGuard } from "@/components/auth-guard";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
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
      <SidebarInset>
        <SiteHeader title={title} />
        <div className="flex flex-1 flex-col gap-6 p-6">{children}</div>
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
