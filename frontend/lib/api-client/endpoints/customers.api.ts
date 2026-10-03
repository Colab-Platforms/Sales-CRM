import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  Customer360,
  CustomerDeactivationImpact,
  CustomerListResult,
  CustomerTimelineParams,
  CustomerTimelineResult,
  CustomersListParams,
  LiveCustomerListResult,
  LiveCustomersListParams,
} from "../types/customers.types";

export const customersApi = {
  async list(params: CustomersListParams): Promise<CustomerListResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<CustomerListResult>>("/customers", { params });
    return res.data.data;
  },

  /** Live from Shopify, cursor-paginated. See GET /customers above (kept, unchanged) for the
   *  original CRM-DB-backed list still used by the main Customers page. */
  async listLive(params: LiveCustomersListParams): Promise<LiveCustomerListResult> {
    const res = await apiClient.get<ApiEnvelope<LiveCustomerListResult>>("/customers/live", { params });
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

  async getDeactivationImpact(leadId: string): Promise<CustomerDeactivationImpact> {
    const res = await apiClient.get<ApiEnvelope<CustomerDeactivationImpact>>(`/customers/${leadId}/deactivation-impact`);
    return res.data.data;
  },

  async deactivate(leadId: string): Promise<{ leadId: string; workingStatus: string }> {
    const res = await apiClient.post<ApiEnvelope<{ leadId: string; workingStatus: string }>>(`/customers/${leadId}/deactivate`);
    return res.data.data;
  },
};
