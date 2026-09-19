import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { Customer360, CustomerTimelineParams, CustomerTimelineResult } from "../types/customers.types";

export const customersApi = {
  async get(leadId: string): Promise<Customer360> {
    const res = await apiClient.get<ApiEnvelope<Customer360>>(`/customers/${leadId}`);
    return res.data.data;
  },

  async getTimeline(leadId: string, params: CustomerTimelineParams): Promise<CustomerTimelineResult> {
    const res = await apiClient.get<ApiEnvelope<CustomerTimelineResult>>(`/customers/${leadId}/timeline`, { params });
    return res.data.data;
  },
};
