"use client";

import { useQuery } from "@tanstack/react-query";
import { SidebarMenuBadge } from "@/components/ui/sidebar";
import { pendingMembershipRequestCountQueryOptions } from "@/lib/api-client/queries/membership-requests.queries";

/** Sidebar badge on "Approvals": pending team requests this approver could act on. Rendered only for ADMIN/HR (the only roles whose nav has the item). */
export function PendingMembershipRequestBadge() {
  const { data } = useQuery(pendingMembershipRequestCountQueryOptions());
  if (!data || data.count <= 0) return null;
  return <SidebarMenuBadge data-testid="pending-membership-request-count">{data.count}</SidebarMenuBadge>;
}
