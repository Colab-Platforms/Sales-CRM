import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  AudienceFilters,
  AudiencePreview,
  CampaignDetail,
  CampaignListResult,
  CampaignRecipientListResult,
  CreateCampaignInput,
  LaunchCampaignInput,
  ListCampaignRecipientsParams,
  ListCampaignsParams,
  UpdateCampaignInput,
} from "../types/whatsapp-campaigns.types";

export const whatsappCampaignsApi = {
  async previewAudience(filters: AudienceFilters): Promise<AudiencePreview> {
    const res = await apiClient.post<ApiEnvelope<AudiencePreview>>("/whatsapp/campaigns/preview", filters);
    return res.data.data;
  },
  async create(input: CreateCampaignInput): Promise<CampaignDetail> {
    const res = await apiClient.post<ApiEnvelope<CampaignDetail>>("/whatsapp/campaigns", input);
    return res.data.data;
  },
  async update(id: string, input: UpdateCampaignInput): Promise<CampaignDetail> {
    const res = await apiClient.patch<ApiEnvelope<CampaignDetail>>(`/whatsapp/campaigns/${id}`, input);
    return res.data.data;
  },
  async get(id: string): Promise<CampaignDetail> {
    const res = await apiClient.get<ApiEnvelope<CampaignDetail>>(`/whatsapp/campaigns/${id}`);
    return res.data.data;
  },
  async list(params: ListCampaignsParams): Promise<CampaignListResult> {
    const res = await apiClient.get<ApiEnvelope<CampaignListResult>>("/whatsapp/campaigns", { params });
    return res.data.data;
  },
  async listRecipients(id: string, params: ListCampaignRecipientsParams): Promise<CampaignRecipientListResult> {
    const res = await apiClient.get<ApiEnvelope<CampaignRecipientListResult>>(`/whatsapp/campaigns/${id}/recipients`, { params });
    return res.data.data;
  },
  async launch(id: string, input: LaunchCampaignInput): Promise<CampaignDetail> {
    const res = await apiClient.post<ApiEnvelope<CampaignDetail>>(`/whatsapp/campaigns/${id}/launch`, input);
    return res.data.data;
  },
  async cancel(id: string): Promise<CampaignDetail> {
    const res = await apiClient.post<ApiEnvelope<CampaignDetail>>(`/whatsapp/campaigns/${id}/cancel`);
    return res.data.data;
  },
};
