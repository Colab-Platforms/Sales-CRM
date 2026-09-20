
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Users,
  Target,
  ShoppingCart,
  UsersRound,
  BarChart3,
  UserCog,
  Building2,
  Wallet,
  History,
  Contact,
  MessageCircle,
  FileText,
  Workflow,
  Send,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { NavUser } from "@/components/nav-user";
import type { CurrentUser } from "@/lib/api-client/types/auth.types";

interface NavItem {
  title: string;
  href?: string;
  icon: ComponentType<{ className?: string }>;
  // Only-ever-exact match: for a route that is itself a literal path-prefix of a sibling nav
  // item's href (WhatsApp Status vs. WhatsApp Templates), so viewing Templates doesn't also light
  // up Status. Every other item keeps the default prefix match, which is what lets e.g. viewing an
  // order's detail page still highlight "Orders".
  exact?: boolean;
}

const NAV_BY_ROLE: Record<CurrentUser["role"], NavItem[]> = {
  SALESPERSON: [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { title: "My Leads", href: "/dashboard/leads", icon: Users },
    { title: "Interested Leads", icon: Target },
    { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
    { title: "Customers", href: "/dashboard/customers", icon: Contact },
    { title: "Audit Trail", href: "/dashboard/audit", icon: History },
    { title: "WhatsApp Templates", href: "/dashboard/whatsapp/templates", icon: FileText },
  ],
  MANAGER: [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { title: "Team", href: "/dashboard/team", icon: UsersRound },
    { title: "Leads", icon: Users },
    { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
    { title: "Customers", href: "/dashboard/customers", icon: Contact },
    { title: "Reconciliation", href: "/dashboard/reconciliation", icon: Wallet },
    { title: "Audit Trail", href: "/dashboard/audit", icon: History },
    { title: "WhatsApp Status", href: "/dashboard/whatsapp", icon: MessageCircle, exact: true },
    { title: "WhatsApp Templates", href: "/dashboard/whatsapp/templates", icon: FileText },
    { title: "WhatsApp Campaigns", href: "/dashboard/whatsapp/campaigns", icon: Send },
    { title: "Reports", icon: BarChart3 },
  ],
  ADMIN: [
    { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { title: "Users", href: "/dashboard/users", icon: UserCog },
    { title: "Groups", icon: Building2 },
    { title: "Leads", icon: Users },
    { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
    { title: "Customers", href: "/dashboard/customers", icon: Contact },
    { title: "Reconciliation", href: "/dashboard/reconciliation", icon: Wallet },
    { title: "Audit Trail", href: "/dashboard/audit", icon: History },
    { title: "WhatsApp Status", href: "/dashboard/whatsapp", icon: MessageCircle, exact: true },
    { title: "WhatsApp Templates", href: "/dashboard/whatsapp/templates", icon: FileText },
    { title: "WhatsApp Automations", href: "/dashboard/whatsapp/automations", icon: Workflow },
    { title: "WhatsApp Campaigns", href: "/dashboard/whatsapp/campaigns", icon: Send },
    { title: "Reports", icon: BarChart3 },
  ],
};

// "/dashboard" is the root of every page here, so it only matches exactly; other items
// also stay highlighted on their nested pages (e.g. an order's detail page) unless marked exact.
function isActivePath(pathname: string, href: string, exact = false) {
  return href === "/dashboard" || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({ user }: { user: CurrentUser }) {
  const pathname = usePathname();
  const items = NAV_BY_ROLE[user.role];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
              <span className="text-sm font-semibold">Sales CRM</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  {item.href ? (
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={isActivePath(pathname, item.href, item.exact)}
                      tooltip={item.title}
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  ) : (
                    <>
                      <SidebarMenuButton disabled tooltip={`${item.title} — coming soon`}>
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge>Soon</SidebarMenuBadge>
                    </>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
