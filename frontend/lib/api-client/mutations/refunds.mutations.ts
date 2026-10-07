import { useMutation, useQueryClient } from "@tanstack/react-query";
import { refundsApi } from "../endpoints/refunds.api";
import { refundsKeys } from "../queries/refunds.queries";
import { ordersKeys } from "../queries/orders.queries";
import { customersKeys } from "../queries/customers.queries";
import { auditKeys } from "../queries/audit.queries";
import type { CreateRefundRequestInput, RefundRequestView } from "../types/refunds.types";

// A request or a decision changes: the order's refund section, the approval queue + badge, the audit trail and the customer timeline.
function useRefreshAfterChange() {
  const queryClient = useQueryClient();
  return (orderId: string, leadId?: string) => {
    queryClient.invalidateQueries({ queryKey: refundsKeys.all });
    queryClient.invalidateQueries({ queryKey: ordersKeys.detail(orderId) });
    queryClient.invalidateQueries({ queryKey: ordersKeys.statusHistory(orderId) });
    queryClient.invalidateQueries({ queryKey: auditKeys.all });
    if (leadId) queryClient.invalidateQueries({ queryKey: [...customersKeys.all, "timeline", leadId] });
  };
}

export function useCreateRefundRequestMutation() {
  const refresh = useRefreshAfterChange();
  return useMutation<RefundRequestView, unknown, { orderId: string } & CreateRefundRequestInput>({
    mutationFn: ({ orderId, ...input }) => refundsApi.create(orderId, input),
    onSuccess: (r) => refresh(r.orderId, r.customer.leadId),
  });
}

export function useApproveRefundMutation() {
  const refresh = useRefreshAfterChange();
  return useMutation<RefundRequestView, unknown, { id: string; note?: string }>({
    mutationFn: ({ id, note }) => refundsApi.approve(id, note),
    onSuccess: (r) => refresh(r.orderId, r.customer.leadId),
  });
}

export function useRejectRefundMutation() {
  const refresh = useRefreshAfterChange();
  return useMutation<RefundRequestView, unknown, { id: string; note: string }>({
    mutationFn: ({ id, note }) => refundsApi.reject(id, note),
    onSuccess: (r) => refresh(r.orderId, r.customer.leadId),
  });
}
