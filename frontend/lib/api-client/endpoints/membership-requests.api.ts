import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  CreateMembershipRequestInput,
  MembershipRequestStatusFilter,
  MembershipRequestView,
} from "../types/membership-requests.types";

export const membershipRequestsApi = {
  async create(input: CreateMembershipRequestInput): Promise<MembershipRequestView> {
    const res = await apiClient.post<ApiEnvelope<MembershipRequestView>>("/membership-requests", input);
    return res.data.data;
  },

  async list(status: MembershipRequestStatusFilter = "ALL"): Promise<MembershipRequestView[]> {
    const res = await apiClient.get<ApiEnvelope<MembershipRequestView[]>>("/membership-requests", { params: { status } });
    return res.data.data;
  },

  async pendingCount(): Promise<{ count: number }> {
    const res = await apiClient.get<ApiEnvelope<{ count: number }>>("/membership-requests/pending-count");
    return res.data.data;
  },

  async approve(id: string, note?: string): Promise<MembershipRequestView> {
    const res = await apiClient.post<ApiEnvelope<MembershipRequestView>>(`/membership-requests/${id}/approve`, note ? { note } : {});
    return res.data.data;
  },

  async reject(id: string, note: string): Promise<MembershipRequestView> {
    const res = await apiClient.post<ApiEnvelope<MembershipRequestView>>(`/membership-requests/${id}/reject`, { note });
    return res.data.data;
  },
};
