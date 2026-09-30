import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  AbandonmentDetail,
  AutoAssignConfig,
  BulkAssignManagerPayload,
  BulkAssignSalespersonPayload,
  CreateRecoveryActionInput,
  ListAbandonmentsParams,
  ListAbandonmentsResult,
} from "../types/abandonment.types";

export const abandonmentApi = {
  async list(params: ListAbandonmentsParams): Promise<ListAbandonmentsResult> {
    // axios drops undefined params, so unset filters never reach the URL.
    const res = await apiClient.get<ApiEnvelope<ListAbandonmentsResult>>("/abandonments", { params });
    return res.data.data;
  },

  async get(id: string): Promise<AbandonmentDetail> {
    const res = await apiClient.get<ApiEnvelope<AbandonmentDetail>>(`/abandonments/${id}`);
    return res.data.data;
  },

  async getByLead(leadId: string): Promise<AbandonmentDetail | null> {
    const res = await apiClient.get<ApiEnvelope<AbandonmentDetail | null>>(`/abandonments/by-lead/${leadId}`);
    return res.data.data;
  },

  async logRecoveryAction(id: string, input: CreateRecoveryActionInput): Promise<void> {
    await apiClient.post<ApiEnvelope<unknown>>(`/abandonments/${id}/recovery-actions`, input);
  },

  async bulkAssignManager(payload: BulkAssignManagerPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>("/abandonments/bulk/assign-manager", payload);
    return res.data.data;
  },

  async bulkAssignSalesperson(payload: BulkAssignSalespersonPayload): Promise<{ assignedCount: number }> {
    const res = await apiClient.post<ApiEnvelope<{ assignedCount: number }>>("/abandonments/bulk/assign-salesperson", payload);
    return res.data.data;
  },

  async getManagerAutoAssignConfig(): Promise<AutoAssignConfig> {
    const res = await apiClient.get<ApiEnvelope<AutoAssignConfig>>("/abandonments/auto-assign/manager-config");
    return res.data.data;
  },

  async setManagerAutoAssignConfig(enabled: boolean): Promise<AutoAssignConfig> {
    const res = await apiClient.patch<ApiEnvelope<AutoAssignConfig>>("/abandonments/auto-assign/manager-config", { enabled });
    return res.data.data;
  },

  async getSalespersonAutoAssignConfig(): Promise<AutoAssignConfig> {
    const res = await apiClient.get<ApiEnvelope<AutoAssignConfig>>("/abandonments/auto-assign/salesperson-config");
    return res.data.data;
  },

  async setSalespersonAutoAssignConfig(enabled: boolean): Promise<AutoAssignConfig> {
    const res = await apiClient.patch<ApiEnvelope<AutoAssignConfig>>("/abandonments/auto-assign/salesperson-config", { enabled });
    return res.data.data;
  },
};
