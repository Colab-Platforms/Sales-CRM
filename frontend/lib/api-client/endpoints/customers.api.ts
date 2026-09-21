import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  Customer360,
  CustomerListResult,
  CustomerTimelineParams,
  CustomerTimelineResult,
  CustomersListParams,
} from "../types/customers.types";

export const customersApi = {
  async list(params: CustomersListParams): Promise<CustomerListResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<CustomerListResult>>("/customers", { params });
    return res.data.data;
  },

  async get(leadId: string): Promise<Customer360> {
    const res = await apiClient.get<ApiEnvelope<Customer360>>(`/customers/${leadId}`);
    return res.data.data;
  },

  async getTimeline(leadId: string, params: CustomerTimelineParams): Promise<CustomerTimelineResult> {
    const res = await apiClient.get<ApiEnvelope<CustomerTimelineResult>>(`/customers/${leadId}/timeline`, { params });
    return res.data.data;
  },
};
