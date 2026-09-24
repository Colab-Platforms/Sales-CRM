import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ConversationListResult, ListConversationsParams, ListMessagesParams, WhatsAppMessageHistoryItem, WhatsAppMessageListResult } from "../types/whatsapp-history.types";

export const whatsappHistoryApi = {
  async list(params: ListMessagesParams): Promise<WhatsAppMessageListResult> {
    const res = await apiClient.get<ApiEnvelope<WhatsAppMessageListResult>>("/whatsapp/messages", { params });
    return res.data.data;
  },
  async get(id: string): Promise<WhatsAppMessageHistoryItem> {
    const res = await apiClient.get<ApiEnvelope<WhatsAppMessageHistoryItem>>(`/whatsapp/messages/${id}`);
    return res.data.data;
  },
  async listConversations(params: ListConversationsParams): Promise<ConversationListResult> {
    const res = await apiClient.get<ApiEnvelope<ConversationListResult>>("/whatsapp/conversations", { params });
    return res.data.data;
  },
};
