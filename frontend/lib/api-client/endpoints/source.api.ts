import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  Source,
  CreateSourcePayload,
  UpdateSourcePayload,
  WebhookEventSummary,
} from "../types/source.types";

export const sourceApi = {
  async listSources(): Promise<Source[]> {
    const res = await apiClient.get<ApiEnvelope<Source[]>>("/integrations/sources");
    return res.data.data;
  },

  async createSource(payload: CreateSourcePayload): Promise<Source> {
    const res = await apiClient.post<ApiEnvelope<Source>>("/integrations/sources", payload);
    return res.data.data;
  },

  async updateSource(id: string, payload: UpdateSourcePayload): Promise<Source> {
    const res = await apiClient.patch<ApiEnvelope<Source>>(`/integrations/sources/${id}`, payload);
    return res.data.data;
  },

  async toggleSourceStatus(id: string, status: "ACTIVE" | "INACTIVE"): Promise<Source> {
    const res = await apiClient.patch<ApiEnvelope<Source>>(`/integrations/sources/${id}/status`, { status });
    return res.data.data;
  },

  async listSourceEvents(id: string): Promise<WebhookEventSummary[]> {
    const res = await apiClient.get<ApiEnvelope<WebhookEventSummary[]>>(`/integrations/sources/${id}/events`);
    return res.data.data;
  },
};
