import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  AbandonmentDetail,
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

  async logRecoveryAction(id: string, input: CreateRecoveryActionInput): Promise<void> {
    await apiClient.post<ApiEnvelope<unknown>>(`/abandonments/${id}/recovery-actions`, input);
  },
};
