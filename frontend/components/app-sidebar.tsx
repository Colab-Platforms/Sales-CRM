"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import {
  LayoutDashboard,
  Users,
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
  Truck,
  Plug,
  Phone,
  Settings,
  AlertTriangle,
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { ChevronRight, PhoneIncoming, PhoneOutgoing, Radio } from "lucide-react";
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
  // Leads and IVR are the only nav items with real sub-pages rather than one page per item -
  // everything else in this sidebar stays flat on purpose. Recursive so "Leads" can nest "IVR"
  // which itself nests "Inbound" (IVR is part of the Leads feature, not a separate module).
  children?: NavItem[];
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
        {
          title: "My Leads",
          icon: Users,
          children: [
            { title: "All Leads", href: "/dashboard/leads", icon: Users, exact: true },
            {
              title: "IVR",
              icon: Radio,
              children: [
                { title: "Inbound", href: "/dashboard/leads/ivr/inbound", icon: PhoneIncoming },
                { title: "Outbound", href: "/dashboard/leads/ivr/outbound", icon: PhoneOutgoing },
              ],
            },
          ],
        },
        {
          title: "Abandoned Leads",
          href: "/dashboard/abandoned-leads",
          icon: AlertTriangle,
        },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Customers", href: "/dashboard/customers", icon: Contact },
      ],
    },
    {
      label: "Communication",
      items: [
        {
          title: "WhatsApp",
          href: "/dashboard/whatsapp",
          icon: MessageCircle,
          exact: true,
        },
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
      label: "Organization",
      items: [
        {
          title: "Virtual Numbers",
          href: "/dashboard/virtual-numbers",
          icon: Phone,
        },
      ],
    },
    {
      label: "Pipeline",
      items: [
        {
          title: "Leads",
          icon: Users,
          children: [
            { title: "All Leads", href: "/dashboard/leads", icon: Users, exact: true },
            {
              title: "IVR",
              icon: Radio,
              children: [
                { title: "Inbound", href: "/dashboard/leads/ivr/inbound", icon: PhoneIncoming },
                { title: "Outbound", href: "/dashboard/leads/ivr/outbound", icon: PhoneOutgoing },
              ],
            },
          ],
        },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Customers", href: "/dashboard/customers", icon: Contact },
        {
          title: "Reconciliation",
          href: "/dashboard/reconciliation",
          icon: Wallet,
        },
        {
          title: "Shiprocket",
          href: "/dashboard/shiprocket",
          icon: Truck,
        },
        {
          title: "Abandoned Leads",
          href: "/dashboard/abandoned-leads",
          icon: AlertTriangle,
        },
        { title: "Reports", icon: BarChart3 },
      ],
    },
    {
      label: "Communication",
      items: [
        {
          title: "WhatsApp",
          href: "/dashboard/whatsapp",
          icon: MessageCircle,
          exact: true,
        },
        {
          title: "WhatsApp Status",
          href: "/dashboard/whatsapp/status",
          icon: MessageCircle,
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
        { title: "Sources", href: "/dashboard/sources", icon: Plug },
        {
          title: "Virtual Numbers",
          href: "/dashboard/virtual-numbers",
          icon: Phone,
        },
      ],
    },
    {
      label: "Pipeline",
      items: [
        {
          title: "Leads",
          icon: Users,
          children: [
            { title: "All Leads", href: "/dashboard/leads", icon: Users, exact: true },
            {
              title: "IVR",
              icon: Radio,
              children: [
                { title: "Inbound", href: "/dashboard/leads/ivr/inbound", icon: PhoneIncoming },
                { title: "Outbound", href: "/dashboard/leads/ivr/outbound", icon: PhoneOutgoing },
              ],
            },
          ],
        },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Customers", href: "/dashboard/customers", icon: Contact },
        {
          title: "Reconciliation",
          href: "/dashboard/reconciliation",
          icon: Wallet,
        },
        {
          title: "Shiprocket",
          href: "/dashboard/shiprocket",
          icon: Truck,
        },
        {
          title: "Abandoned Leads",
          href: "/dashboard/abandoned-leads",
          icon: AlertTriangle,
        },
        { title: "Reports", icon: BarChart3 },
      ],
    },
    {
      label: "Communication",
      items: [
        {
          title: "WhatsApp",
          href: "/dashboard/whatsapp",
          icon: MessageCircle,
          exact: true,
        },
        {
          title: "WhatsApp Status",
          href: "/dashboard/whatsapp/status",
          icon: MessageCircle,
        },
        {
          title: "WhatsApp Config",
          href: "/dashboard/whatsapp/cloud-config",
          icon: Settings,
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
  return href === "/dashboard" || exact
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

function itemHasActiveDescendant(item: NavItem, pathname: string): boolean {
  if (item.href && isActivePath(pathname, item.href, item.exact)) return true;
  return item.children?.some((child) => itemHasActiveDescendant(child, pathname)) ?? false;
}

/** Every item with children (e.g. "Leads", "Leads/IVR") that must start expanded so the active
 * route's parents are already open on first paint/direct navigation - a plain prefix match on
 * href, same rule isActivePath already uses for non-exact items. */
function collectAutoExpandedIds(items: NavItem[], pathname: string, parentId = ""): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (!item.children) continue;
    const id = parentId ? `${parentId}/${item.title}` : item.title;
    if (itemHasActiveDescendant(item, pathname)) {
      ids.push(id, ...collectAutoExpandedIds(item.children, pathname, id));
    }
  }
  return ids;
}

/** Renders one child inside a SidebarMenuSub, recursing when that child itself has children
 * (e.g. Leads > IVR > Inbound/Outbound) - nesting another SidebarMenuSub inside the
 * SidebarMenuSubItem's <li>, which the primitive supports structurally. A parent with children
 * is a click-to-expand toggle, not a link - only leaves (Inbound/Outbound/All Leads) navigate. */
function SidebarSubNavItem({
  item,
  parentId,
  pathname,
  openIds,
  onToggle,
}: {
  item: NavItem;
  parentId: string;
  pathname: string;
  openIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const id = `${parentId}/${item.title}`;

  if (item.children) {
    const isOpen = openIds.has(id);
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          onClick={() => onToggle(id)}
          aria-expanded={isOpen}
          isActive={itemHasActiveDescendant(item, pathname)}
        >
          <item.icon />
          <span>{item.title}</span>
          <ChevronRight className={`ml-auto size-3.5 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        </SidebarMenuSubButton>
        {isOpen ? (
          <SidebarMenuSub>
            {item.children.map((child) => (
              <SidebarSubNavItem key={child.title} item={child} parentId={id} pathname={pathname} openIds={openIds} onToggle={onToggle} />
            ))}
          </SidebarMenuSub>
        ) : null}
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        render={<Link href={item.href!} />}
        isActive={Boolean(item.href) && isActivePath(pathname, item.href!, item.exact)}
      >
        <item.icon />
        <span>{item.title}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

export function AppSidebar({ user }: { user: CurrentUser }) {
  const pathname = usePathname();
  const sections = NAV_BY_ROLE[user.role];

  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(sections.flatMap((section) => collectAutoExpandedIds(section.items, pathname))),
  );

  // Direct navigation to a nested route (e.g. pasting /dashboard/leads/ivr/outbound) must reveal
  // it even if nothing was manually expanded yet - this only ever adds ids, it never collapses
  // something the user already toggled open or closed themselves.
  useEffect(() => {
    const needed = sections.flatMap((section) => collectAutoExpandedIds(section.items, pathname));
    setOpenIds((prev) => {
      if (needed.every((id) => prev.has(id))) return prev;
      return new Set([...prev, ...needed]);
    });
  }, [pathname, sections]);

  function toggle(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
                  AVATAR CRM
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
                {section.items.map((item) =>
                  item.children ? (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        type="button"
                        onClick={() => toggle(item.title)}
                        aria-expanded={openIds.has(item.title)}
                        isActive={itemHasActiveDescendant(item, pathname)}
                        tooltip={item.title}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                        <ChevronRight
                          className={`ml-auto size-3.5 shrink-0 transition-transform ${openIds.has(item.title) ? "rotate-90" : ""}`}
                        />
                      </SidebarMenuButton>
                      {openIds.has(item.title) ? (
                        <SidebarMenuSub>
                          {item.children.map((child) => (
                            <SidebarSubNavItem
                              key={child.title}
                              item={child}
                              parentId={item.title}
                              pathname={pathname}
                              openIds={openIds}
                              onToggle={toggle}
                            />
                          ))}
                        </SidebarMenuSub>
                      ) : null}
                    </SidebarMenuItem>
                  ) : (
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
                  ),
                )}
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
