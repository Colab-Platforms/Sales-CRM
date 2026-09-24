import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ConversationDetail, OrderDraftResult } from "../types/whatsapp-conversation.types";

export const whatsappConversationApi = {
  async getDetail(leadId: string): Promise<ConversationDetail> {
    const res = await apiClient.get<ApiEnvelope<ConversationDetail>>(`/whatsapp/conversations/${leadId}`);
    return res.data.data;
  },
  async markRead(leadId: string): Promise<void> {
    await apiClient.post(`/whatsapp/conversations/${leadId}/read`);
  },
  async assign(leadId: string, userId: string): Promise<ConversationDetail> {
    const res = await apiClient.post<ApiEnvelope<ConversationDetail>>(`/whatsapp/conversations/${leadId}/assign`, { userId });
    return res.data.data;
  },
  async handoff(leadId: string): Promise<ConversationDetail> {
    const res = await apiClient.post<ApiEnvelope<ConversationDetail>>(`/whatsapp/conversations/${leadId}/handoff`);
    return res.data.data;
  },
  async returnToAi(leadId: string): Promise<ConversationDetail> {
    const res = await apiClient.post<ApiEnvelope<ConversationDetail>>(`/whatsapp/conversations/${leadId}/ai-mode`);
    return res.data.data;
  },
  async sendText(leadId: string, text: string): Promise<void> {
    await apiClient.post(`/whatsapp/conversations/${leadId}/messages`, { text });
  },
  async getOrderDraft(leadId: string): Promise<OrderDraftResult> {
    const res = await apiClient.get<ApiEnvelope<OrderDraftResult>>(`/whatsapp/orders/${leadId}/draft`);
    return res.data.data;
  },
  async confirmOrderDraft(leadId: string): Promise<{ orderId: string }> {
    const res = await apiClient.post<ApiEnvelope<{ orderId: string }>>(`/whatsapp/orders/${leadId}/confirm`);
    return res.data.data;
  },
};
