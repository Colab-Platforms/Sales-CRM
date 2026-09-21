
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
  MessageCircle,
  FileText,
  Workflow,
  Send,
  Contact,
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
import { BrandMark } from "@/components/brand-mark";
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

interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * Grouped so each role sees the same rhythm: where they are, who they work
 * with, then the pipeline itself.
 */
  // const NAV_BY_ROLE: Record<CurrentUser["role"], NavSection[]> = {
  //   SALESPERSON: [
  //     { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  //     { title: "My Leads", href: "/dashboard/leads", icon: Users },
  //     { title: "Interested Leads", icon: Target },
  //     { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
  //     { title: "Customers", href: "/dashboard/customers", icon: Contact },
  //     { title: "Audit Trail", href: "/dashboard/audit", icon: History },
  //     { title: "WhatsApp Templates", href: "/dashboard/whatsapp/templates", icon: FileText },
  //   ],
  //   MANAGER: [
  //     { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  //     { title: "Team", href: "/dashboard/team", icon: UsersRound },
  //     { title: "Leads", icon: Users },
  //     { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
  //     { title: "Customers", href: "/dashboard/customers", icon: Contact },
  //     { title: "Reconciliation", href: "/dashboard/reconciliation", icon: Wallet },
  //     { title: "Audit Trail", href: "/dashboard/audit", icon: History },
  //     { title: "WhatsApp Status", href: "/dashboard/whatsapp", icon: MessageCircle, exact: true },
  //     { title: "WhatsApp Templates", href: "/dashboard/whatsapp/templates", icon: FileText },
  //     { title: "WhatsApp Campaigns", href: "/dashboard/whatsapp/campaigns", icon: Send },
  //     { title: "Reports", icon: BarChart3 },
  //   ],
  //   ADMIN: [
  //     { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  //     { title: "Users", href: "/dashboard/users", icon: UserCog },
  //     { title: "Groups", icon: Building2 },
  //     { title: "Leads", icon: Users },
  //     { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
  //     { title: "Customers", href: "/dashboard/customers", icon: Contact },
  //     { title: "Reconciliation", href: "/dashboard/reconciliation", icon: Wallet },
  //     { title: "Audit Trail", href: "/dashboard/audit", icon: History },
  //     { title: "WhatsApp Status", href: "/dashboard/whatsapp", icon: MessageCircle, exact: true },
  //     { title: "WhatsApp Templates", href: "/dashboard/whatsapp/templates", icon: FileText },
  //     { title: "WhatsApp Automations", href: "/dashboard/whatsapp/automations", icon: Workflow },
  //     { title: "WhatsApp Campaigns", href: "/dashboard/whatsapp/campaigns", icon: Send },
  //     { title: "Reports", icon: BarChart3 },
  //     {
  //       label: "Overview",
  //       items: [
  //         { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  //       ],
  //     },
  //     {
  //       label: "Pipeline",
  //       items: [
  //         { title: "My Leads", href: "/dashboard/leads", icon: Users },
  //         { title: "Interested Leads", icon: Target },
  //         { title: "Orders", icon: ShoppingCart },
  //       ],
  //     },
  //   ],
  //   MANAGER: [
  //     {
  //       label: "Overview",
  //       items: [
  //         { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  //       ],
  //     },
  //     {
  //       label: "People",
  //       items: [
  //         { title: "Team", href: "/dashboard/team", icon: UsersRound },
  //         {
  //           title: "Salespersons",
  //           href: "/dashboard/salespersons",
  //           icon: Contact,
  //         },
  //       ],
  //     },
  //     {
  //       label: "Pipeline",
  //       items: [
  //         { title: "Leads", href: "/dashboard/leads", icon: Users },
  //         { title: "Orders", icon: ShoppingCart },
  //         { title: "Reports", icon: BarChart3 },
  //       ],
  //     },
  //   ],
  //   ADMIN: [
  //     {
  //       label: "Overview",
  //       items: [
  //         { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  //       ],
  //     },
  //     {
  //       label: "Organization",
  //       items: [
  //         { title: "Users", href: "/dashboard/users", icon: UserCog },
  //         { title: "Groups", icon: Building2 },
  //       ],
  //     },
  //     {
  //       label: "Pipeline",
  //       items: [
  //         { title: "Leads", href: "/dashboard/leads", icon: Users },
  //         { title: "Orders", icon: ShoppingCart },
  //         { title: "Reports", icon: BarChart3 },
  //       ],
  //     },
  //   ],
  // };

// "/dashboard" is the root of every page here, so it only matches exactly; other items
// also stay highlighted on their nested pages (e.g. an order's detail page) unless marked exact.

const NAV_BY_ROLE: Record<CurrentUser["role"], NavSection[]> = {
  SALESPERSON: [
    {
      label: "Overview",
      items: [
        { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      ],
    },
    {
      label: "Pipeline",
      items: [
        { title: "My Leads", href: "/dashboard/leads", icon: Users },
        { title: "Interested Leads", icon: Target },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Customers", href: "/dashboard/customers", icon: Contact },
      ],
    },
    {
      label: "Communication",
      items: [
        {
          title: "WhatsApp Templates",
          href: "/dashboard/whatsapp/templates",
          icon: FileText,
        },
      ],
    },
    {
      label: "Administration",
      items: [
        { title: "Audit Trail", href: "/dashboard/audit", icon: History },
      ],
    },
  ],

  MANAGER: [
    {
      label: "Overview",
      items: [
        { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      ],
    },
    {
      label: "People",
      items: [
        { title: "Team", href: "/dashboard/team", icon: UsersRound },
        {
          title: "Salespersons",
          href: "/dashboard/salespersons",
          icon: Contact,
        },
      ],
    },
    {
      label: "Pipeline",
      items: [
        { title: "Leads", href: "/dashboard/leads", icon: Users },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Customers", href: "/dashboard/customers", icon: Contact },
        {
          title: "Reconciliation",
          href: "/dashboard/reconciliation",
          icon: Wallet,
        },
        { title: "Reports", icon: BarChart3 },
      ],
    },
    {
      label: "Communication",
      items: [
        {
          title: "WhatsApp Status",
          href: "/dashboard/whatsapp",
          icon: MessageCircle,
          exact: true,
        },
        {
          title: "WhatsApp Templates",
          href: "/dashboard/whatsapp/templates",
          icon: FileText,
        },
        {
          title: "WhatsApp Campaigns",
          href: "/dashboard/whatsapp/campaigns",
          icon: Send,
        },
      ],
    },
    {
      label: "Administration",
      items: [
        { title: "Audit Trail", href: "/dashboard/audit", icon: History },
      ],
    },
  ],

  ADMIN: [
    {
      label: "Overview",
      items: [
        { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      ],
    },
    {
      label: "Organization",
      items: [
        { title: "Users", href: "/dashboard/users", icon: UserCog },
        { title: "Groups", icon: Building2 },
      ],
    },
    {
      label: "Pipeline",
      items: [
        { title: "Leads", href: "/dashboard/leads", icon: Users },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Customers", href: "/dashboard/customers", icon: Contact },
        {
          title: "Reconciliation",
          href: "/dashboard/reconciliation",
          icon: Wallet,
        },
        { title: "Reports", icon: BarChart3 },
      ],
    },
    {
      label: "Communication",
      items: [
        {
          title: "WhatsApp Status",
          href: "/dashboard/whatsapp",
          icon: MessageCircle,
          exact: true,
        },
        {
          title: "WhatsApp Templates",
          href: "/dashboard/whatsapp/templates",
          icon: FileText,
        },
        {
          title: "WhatsApp Automations",
          href: "/dashboard/whatsapp/automations",
          icon: Workflow,
        },
        {
          title: "WhatsApp Campaigns",
          href: "/dashboard/whatsapp/campaigns",
          icon: Send,
        },
      ],
    },
    {
      label: "Administration",
      items: [
        { title: "Audit Trail", href: "/dashboard/audit", icon: History },
      ],
    },
  ],
};

function isActivePath(pathname: string, href: string, exact = false) {
  return href === "/dashboard" || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({ user }: { user: CurrentUser }) {
  const pathname = usePathname();
  const sections = NAV_BY_ROLE[user.role];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b-[1.5px] border-sidebar-border pb-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="hover:bg-transparent"
              render={<Link href="/dashboard" />}
            >
              {/* <BrandMark className="size-8 shrink-0" /> */}
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate font-hand text-xl leading-none font-bold text-foreground">
                  Sales CRM
                </span>
                <span className="truncate text-[0.7rem] text-muted-foreground">
                  Lead workspace
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    {item.href ? (
                      <SidebarMenuButton
                        render={<Link href={item.href} />}
                        isActive={pathname === item.href}
                        tooltip={item.title}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    ) : (
                      <>
                        <SidebarMenuButton
                          disabled
                          tooltip={`${item.title} — coming soon`}
                        >
                          <item.icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge>soon</SidebarMenuBadge>
                      </>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t-[1.5px] border-sidebar-border pt-3">
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
