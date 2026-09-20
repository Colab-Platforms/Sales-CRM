import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { AuditListParams, AuditListResult, EntityAuditParams } from "../types/audit.types";

export const auditApi = {
  async list(params: AuditListParams): Promise<AuditListResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<AuditListResult>>("/audit", { params });
    return res.data.data;
  },

  async listForOrder(orderId: string, params: EntityAuditParams): Promise<AuditListResult> {
    const res = await apiClient.get<ApiEnvelope<AuditListResult>>(`/orders/${orderId}/audit`, { params });
    return res.data.data;
  },

  async listForCustomer(leadId: string, params: EntityAuditParams): Promise<AuditListResult> {
    const res = await apiClient.get<ApiEnvelope<AuditListResult>>(`/customers/${leadId}/audit`, { params });
    return res.data.data;
  },
};
