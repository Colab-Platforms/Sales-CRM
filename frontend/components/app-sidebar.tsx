"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import {
  LayoutDashboard,
  Users,
  ShoppingCart,
  Scale,
  Ticket,
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
  Timer,
  Settings,
  AlertTriangle,
  RotateCcw,
  LifeBuoy,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
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
import { NavUser } from "@/components/nav-user";
import { PendingRefundBadge } from "@/components/refunds/pending-refund-badge";
import { OpenTicketBadge } from "@/components/tickets/open-ticket-badge";
import { PendingMembershipRequestBadge } from "@/components/membership-requests/pending-membership-request-badge";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";
import type { CurrentUser } from "@/lib/api-client/types/auth.types";

interface NavItem {
  title: string;
  href?: string;
  icon: ComponentType<{ className?: string }>;
  // Only-ever-exact match: for a route that is itself a literal path-prefix of a sibling nav
  // item's href (WhatsApp vs. its own children like WhatsApp Templates, all under
  // /dashboard/whatsapp/...), so viewing Templates doesn't also light up the WhatsApp Inbox link.
  // Every other item keeps the default prefix match, which is what lets e.g. viewing an order's
  // detail page still highlight "Orders".
  exact?: boolean;
  // A collapsible parent group (e.g. "WhatsApp") instead of a direct link - has no href of its own,
  // only children. Only one level deep; nothing here needs more than that today.
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
        { title: "My Leads", href: "/dashboard/leads", icon: Users },
        {
          title: "Abandoned Leads",
          href: "/dashboard/abandoned-leads",
          icon: AlertTriangle,
        },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Offers", href: "/dashboard/offers", icon: Ticket },
      ],
    },
    {
      label: "Communication",
      items: [
        {
          title: "WhatsApp",
          icon: MessageCircle,
          children: [
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
      ],
    },
    {
      label: "Administration",
      items: [
        { title: "Support Tickets", href: "/dashboard/tickets", icon: LifeBuoy },
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
        { title: "Attendance", href: "/dashboard/attendance", icon: Timer },
        { title: "Requests", href: "/dashboard/requests", icon: ClipboardList },
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
        { title: "Leads", href: "/dashboard/leads", icon: Users },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Offers", href: "/dashboard/offers", icon: Ticket },
        { title: "Product Weights", href: "/dashboard/products", icon: Scale },
        {
          title: "Reconciliation",
          href: "/dashboard/reconciliation",
          icon: Wallet,
        },
        {
          title: "Refund Approvals",
          href: "/dashboard/refunds",
          icon: RotateCcw,
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
          icon: MessageCircle,
          children: [
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
            {
              title: "WhatsApp Campaigns",
              href: "/dashboard/whatsapp/campaigns",
              icon: Send,
            },
          ],
        },
      ],
    },
    {
      label: "Administration",
      items: [
        { title: "Support Tickets", href: "/dashboard/tickets", icon: LifeBuoy },
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
        { title: "Groups", href: "/dashboard/groups", icon: Building2 },
        { title: "Approvals", href: "/dashboard/approvals", icon: ClipboardCheck },
        { title: "Attendance", href: "/dashboard/attendance", icon: Timer },
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
        { title: "Leads", href: "/dashboard/leads", icon: Users },
        { title: "Orders", href: "/dashboard/orders", icon: ShoppingCart },
        { title: "Offers", href: "/dashboard/offers", icon: Ticket },
        { title: "Product Weights", href: "/dashboard/products", icon: Scale },
        {
          title: "Reconciliation",
          href: "/dashboard/reconciliation",
          icon: Wallet,
        },
        {
          title: "Refund Approvals",
          href: "/dashboard/refunds",
          icon: RotateCcw,
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
          icon: MessageCircle,
          children: [
            {
              title: "WhatsApp",
              href: "/dashboard/whatsapp",
              icon: MessageCircle,
              exact: true,
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
      ],
    },
    {
      label: "Administration",
      items: [
        { title: "Support Tickets", href: "/dashboard/tickets", icon: LifeBuoy },
        { title: "Audit Trail", href: "/dashboard/audit", icon: History },
      ],
    },
  ],

  // HR only handles team/salesperson management — nothing else is exposed.
  HR: [
    {
      label: "Overview",
      items: [
        { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      ],
    },
    {
      label: "Organization",
      items: [
        { title: "Users", href: "/dashboard/staff", icon: UserCog },
        { title: "Teams", href: "/dashboard/groups", icon: Building2 },
        { title: "Approvals", href: "/dashboard/approvals", icon: ClipboardCheck },
      ],
    },
  ],
};

function isActivePath(pathname: string, href: string, exact = false) {
  return href === "/dashboard" || exact
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

/** A collapsible parent nav item (e.g. "WhatsApp"), holding its own open/closed state - expanded
 *  automatically whenever the current route is one of its children (covers both a fresh page load/
 *  refresh on a child route, and a client-side navigation into one while the sidebar stays mounted),
 *  and otherwise freely toggled by clicking the parent row. */
function CollapsibleNavItem({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const children = item.children ?? [];
  const hasActiveChild = children.some(
    (child) => child.href && isActivePath(pathname, child.href, child.exact),
  );
  const [open, setOpen] = useState(hasActiveChild);

  useEffect(() => {
    if (hasActiveChild) setOpen(true);
    // Only route changes should force this open - a manual collapse must never be immediately
    // undone by this same effect re-running for an unrelated reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => setOpen((prev) => !prev)}
        isActive={hasActiveChild}
        aria-expanded={open}
        tooltip={item.title}
      >
        <item.icon />
        <span>{item.title}</span>
        <ChevronRight
          className={cn(
            "ml-auto transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </SidebarMenuButton>
      {open ? (
        <SidebarMenuSub>
          {children.map((child) =>
            child.href ? (
              <SidebarMenuSubItem key={child.title}>
                <SidebarMenuSubButton
                  render={<Link href={child.href} />}
                  isActive={isActivePath(pathname, child.href, child.exact)}
                >
                  <child.icon />
                  <span>{child.title}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ) : null,
          )}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
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
                    <CollapsibleNavItem
                      key={item.title}
                      item={item}
                      pathname={pathname}
                    />
                  ) : (
                    <SidebarMenuItem key={item.title}>
                      {item.href ? (
                        <>
                          <SidebarMenuButton
                            render={<Link href={item.href} />}
                            isActive={pathname === item.href}
                            tooltip={item.title}
                          >
                            <item.icon />
                            <span>{item.title}</span>
                          </SidebarMenuButton>
                          {item.href === "/dashboard/refunds" ? (
                            <PendingRefundBadge />
                          ) : null}
                          {item.href === "/dashboard/tickets" ? (
                            <OpenTicketBadge />
                          ) : null}
                          {item.href === "/dashboard/approvals" ? (
                            <PendingMembershipRequestBadge />
                          ) : null}
                        </>
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
