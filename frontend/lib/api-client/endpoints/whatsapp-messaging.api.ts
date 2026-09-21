import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { PreviewTemplateInput, SendTemplateInput, TemplatePreviewResult, WhatsAppMessageResult } from "../types/whatsapp-messaging.types";

export const whatsappMessagingApi = {
  async preview(input: PreviewTemplateInput): Promise<TemplatePreviewResult> {
    const res = await apiClient.post<ApiEnvelope<TemplatePreviewResult>>("/whatsapp/messages/template/preview", input);
    return res.data.data;
  },
  async send(input: SendTemplateInput): Promise<WhatsAppMessageResult> {
    const res = await apiClient.post<ApiEnvelope<WhatsAppMessageResult>>("/whatsapp/messages/template", input);
    return res.data.data;
  },
};
