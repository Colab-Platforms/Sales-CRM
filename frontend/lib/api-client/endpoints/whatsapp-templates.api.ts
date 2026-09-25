import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  CreateTemplateInput,
  ListTemplatesParams,
  TemplateListResult,
  TemplateSyncSummary,
  UpdateTemplateInput,
  WhatsAppTemplate,
} from "../types/whatsapp-templates.types";

export const whatsappTemplatesApi = {
  async list(params: ListTemplatesParams): Promise<TemplateListResult> {
    const res = await apiClient.get<ApiEnvelope<TemplateListResult>>("/whatsapp/templates", { params });
    return res.data.data;
  },
  async get(id: string): Promise<WhatsAppTemplate> {
    const res = await apiClient.get<ApiEnvelope<WhatsAppTemplate>>(`/whatsapp/templates/${id}`);
    return res.data.data;
  },
  async create(input: CreateTemplateInput): Promise<WhatsAppTemplate> {
    const res = await apiClient.post<ApiEnvelope<WhatsAppTemplate>>("/whatsapp/templates", input);
    return res.data.data;
  },
  async update(id: string, input: UpdateTemplateInput): Promise<WhatsAppTemplate> {
    const res = await apiClient.patch<ApiEnvelope<WhatsAppTemplate>>(`/whatsapp/templates/${id}`, input);
    return res.data.data;
  },
  async sync(provider?: "META"): Promise<TemplateSyncSummary> {
    const res = await apiClient.post<ApiEnvelope<TemplateSyncSummary>>("/whatsapp/templates/sync", provider ? { provider } : undefined);
    return res.data.data;
  },
};
