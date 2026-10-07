import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { CreateRefundRequestInput, RefundQueueParams, RefundQueueResult, RefundRequestView } from "../types/refunds.types";

// Refund APPROVAL workflow only - none of these moves money.
export const refundsApi = {
  async create(orderId: string, input: CreateRefundRequestInput): Promise<RefundRequestView> {
    const res = await apiClient.post<ApiEnvelope<RefundRequestView>>(`/orders/${orderId}/refund-requests`, input);
    return res.data.data;
  },
  async queue(params: RefundQueueParams): Promise<RefundQueueResult> {
    const res = await apiClient.get<ApiEnvelope<RefundQueueResult>>("/refund-requests", { params });
    return res.data.data;
  },
  async pendingCount(): Promise<{ count: number }> {
    const res = await apiClient.get<ApiEnvelope<{ count: number }>>("/refund-requests/pending-count");
    return res.data.data;
  },
  async approve(id: string, note?: string): Promise<RefundRequestView> {
    const res = await apiClient.post<ApiEnvelope<RefundRequestView>>(`/refund-requests/${id}/approve`, note ? { note } : {});
    return res.data.data;
  },
  async reject(id: string, note: string): Promise<RefundRequestView> {
    const res = await apiClient.post<ApiEnvelope<RefundRequestView>>(`/refund-requests/${id}/reject`, { note });
    return res.data.data;
  },
};
