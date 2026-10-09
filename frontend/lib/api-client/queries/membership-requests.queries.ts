import { queryOptions } from "@tanstack/react-query";
import { membershipRequestsApi } from "../endpoints/membership-requests.api";
import type { MembershipRequestStatusFilter } from "../types/membership-requests.types";

export const membershipRequestsKeys = {
  all: ["membership-requests"] as const,
  list: (status: MembershipRequestStatusFilter) => [...membershipRequestsKeys.all, "list", status] as const,
  pendingCount: () => [...membershipRequestsKeys.all, "pending-count"] as const,
};

/** Manager: their own request history. Admin/HR: the approval queue + history. Scoped server-side by role. */
export function membershipRequestsQueryOptions(status: MembershipRequestStatusFilter = "ALL") {
  return queryOptions({
    queryKey: membershipRequestsKeys.list(status),
    queryFn: () => membershipRequestsApi.list(status),
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

/** Sidebar badge for Admin/HR: how many requests are waiting on a decision. */
export function pendingMembershipRequestCountQueryOptions() {
  return queryOptions({
    queryKey: membershipRequestsKeys.pendingCount(),
    queryFn: () => membershipRequestsApi.pendingCount(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}
