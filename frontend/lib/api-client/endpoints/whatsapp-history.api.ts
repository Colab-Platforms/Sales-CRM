import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  BulkDeleteForMeResult,
  ConversationListResult,
  DeleteForMeResult,
  ForwardMessageResult,
  ListConversationsParams,
  ListMessagesParams,
  StarMessageResult,
  WhatsAppMessageHistoryItem,
  WhatsAppMessageListResult,
} from "../types/whatsapp-history.types";

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

  // ---- WhatsApp-style per-message actions ----
  async listStarred(leadId?: string): Promise<WhatsAppMessageHistoryItem[]> {
    const res = await apiClient.get<ApiEnvelope<WhatsAppMessageHistoryItem[]>>("/whatsapp/messages/starred", { params: { leadId } });
    return res.data.data;
  },
  async star(id: string): Promise<StarMessageResult> {
    const res = await apiClient.post<ApiEnvelope<StarMessageResult>>(`/whatsapp/messages/${id}/star`);
    return res.data.data;
  },
  async unstar(id: string): Promise<StarMessageResult> {
    const res = await apiClient.delete<ApiEnvelope<StarMessageResult>>(`/whatsapp/messages/${id}/star`);
    return res.data.data;
  },
  async deleteForMe(id: string): Promise<DeleteForMeResult> {
    const res = await apiClient.post<ApiEnvelope<DeleteForMeResult>>(`/whatsapp/messages/${id}/delete-for-me`);
    return res.data.data;
  },
  async bulkDeleteForMe(ids: string[]): Promise<BulkDeleteForMeResult> {
    const res = await apiClient.post<ApiEnvelope<BulkDeleteForMeResult>>("/whatsapp/messages/bulk/delete-for-me", { ids });
    return res.data.data;
  },
  async forward(id: string, targetLeadId: string): Promise<ForwardMessageResult> {
    const res = await apiClient.post<ApiEnvelope<ForwardMessageResult>>(`/whatsapp/messages/${id}/forward`, { targetLeadId });
    return res.data.data;
  },
};
