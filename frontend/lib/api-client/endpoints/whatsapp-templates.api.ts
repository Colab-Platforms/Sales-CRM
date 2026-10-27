import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  CreateTemplateInput,
  DeleteTemplateResult,
  ListTemplatesParams,
  SubmitTemplateResult,
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
  /** `timeoutMs`: give up waiting after this long (the server keeps working on its own; nothing is retried). */
  async sync(provider?: "META", timeoutMs?: number): Promise<TemplateSyncSummary> {
    const res = await apiClient.post<ApiEnvelope<TemplateSyncSummary>>("/whatsapp/templates/sync", provider ? { provider } : undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
    return res.data.data;
  },
  async remove(id: string): Promise<DeleteTemplateResult> {
    const res = await apiClient.delete<ApiEnvelope<DeleteTemplateResult>>(`/whatsapp/templates/${id}`);
    return res.data.data;
  },
  async submitToMeta(id: string): Promise<SubmitTemplateResult> {
    const res = await apiClient.post<ApiEnvelope<SubmitTemplateResult>>(`/whatsapp/templates/${id}/submit`);
    return res.data.data;
  },
};
