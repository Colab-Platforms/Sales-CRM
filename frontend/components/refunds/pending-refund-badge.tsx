"use client";

import { useQuery } from "@tanstack/react-query";
import { SidebarMenuBadge } from "@/components/ui/sidebar";
import { pendingRefundCountQueryOptions } from "@/lib/api-client/queries/refunds.queries";

/** Sidebar badge on "Refund Approvals": pending requests this approver could act on. Rendered only for MANAGER/ADMIN (the only roles whose nav has the item). */
export function PendingRefundBadge() {
  const { data } = useQuery(pendingRefundCountQueryOptions());
  if (!data || data.count <= 0) return null;
  return <SidebarMenuBadge data-testid="pending-refund-count">{data.count}</SidebarMenuBadge>;
}
