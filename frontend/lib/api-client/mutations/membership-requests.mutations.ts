import { useMutation, useQueryClient } from "@tanstack/react-query";
import { membershipRequestsApi } from "../endpoints/membership-requests.api";
import { membershipRequestsKeys } from "../queries/membership-requests.queries";
import { managerKeys } from "../queries/manager.queries";
import { adminKeys } from "../queries/admin.queries";
import type { CreateMembershipRequestInput, MembershipRequestView } from "../types/membership-requests.types";

export function useCreateMembershipRequestMutation() {
  const queryClient = useQueryClient();

  return useMutation<MembershipRequestView, unknown, CreateMembershipRequestInput>({
    mutationFn: (input) => membershipRequestsApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membershipRequestsKeys.all });
    },
  });
}

// Deciding a request changes group membership itself, so every place that shows
// groups/salespersons (manager's read-only view, admin/HR's team management) needs
// to refresh too, whichever role is looking at it right now.
function useRefreshAfterDecision() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: membershipRequestsKeys.all });
    queryClient.invalidateQueries({ queryKey: managerKeys.groups() });
    queryClient.invalidateQueries({ queryKey: managerKeys.mySalespersons() });
    queryClient.invalidateQueries({ queryKey: adminKeys.groups() });
    queryClient.invalidateQueries({ queryKey: adminKeys.salespersons() });
  };
}

export function useApproveMembershipRequestMutation() {
  const refresh = useRefreshAfterDecision();
  return useMutation<MembershipRequestView, unknown, { id: string; note?: string }>({
    mutationFn: ({ id, note }) => membershipRequestsApi.approve(id, note),
    onSuccess: refresh,
  });
}

export function useRejectMembershipRequestMutation() {
  const refresh = useRefreshAfterDecision();
  return useMutation<MembershipRequestView, unknown, { id: string; note: string }>({
    mutationFn: ({ id, note }) => membershipRequestsApi.reject(id, note),
    onSuccess: refresh,
  });
}
