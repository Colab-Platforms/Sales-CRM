import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ResolveCashfreeResult, CreateRefundRequestInput, RefundQueueParams, RefundQueueResult, RefundRequestView } from "../types/refunds.types";

// Refund APPROVAL workflow only - none of these moves money.
export const refundsApi = {
  async create(orderId: string, input: CreateRefundRequestInput): Promise<RefundRequestView> {
    const res = await apiClient.post<ApiEnvelope<RefundRequestView>>(`/orders/${orderId}/refund-requests`, input);
    return res.data.data;
  },
  /** Looks up and verifies the Cashfree references of a Shopify-synced Cashfree payment (read-only toward Shopify/Cashfree). */
  async resolveCashfree(orderId: string, paymentId: string): Promise<ResolveCashfreeResult> {
    const res = await apiClient.post<ApiEnvelope<ResolveCashfreeResult>>(`/orders/${orderId}/payments/${paymentId}/resolve-cashfree`);
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
  /** Sends an APPROVED request to Cashfree (idempotent: a processing/completed one is returned, never sent twice). */
  async execute(id: string): Promise<RefundRequestView> {
    const res = await apiClient.post<ApiEnvelope<RefundRequestView>>(`/refund-requests/${id}/execute`);
    return res.data.data;
  },
  /** Reads the refund's status from Cashfree and applies it (this is what completes a processing refund). */
  async refreshExecution(id: string): Promise<RefundRequestView> {
    const res = await apiClient.post<ApiEnvelope<RefundRequestView>>(`/refund-requests/${id}/refresh-execution`);
    return res.data.data;
  },
  async reject(id: string, note: string): Promise<RefundRequestView> {
    const res = await apiClient.post<ApiEnvelope<RefundRequestView>>(`/refund-requests/${id}/reject`, { note });
    return res.data.data;
  },
};
