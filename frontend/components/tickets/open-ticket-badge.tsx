"use client";

import { useQuery } from "@tanstack/react-query";
import { SidebarMenuBadge } from "@/components/ui/sidebar";
import { openTicketCountQueryOptions } from "@/lib/api-client/queries/tickets.queries";

/** Sidebar badge on "Support Tickets": tickets still open or in progress in this user's scope. */
export function OpenTicketBadge() {
  const { data } = useQuery(openTicketCountQueryOptions());
  if (!data || data.count <= 0) return null;
  return <SidebarMenuBadge data-testid="open-ticket-count">{data.count}</SidebarMenuBadge>;
}
