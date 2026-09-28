import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type { ConversationDetail, MessagingCapability, OrderDraftResult } from "../types/whatsapp-conversation.types";

export const whatsappConversationApi = {
  async getDetail(leadId: string): Promise<ConversationDetail> {
    const res = await apiClient.get<ApiEnvelope<ConversationDetail>>(`/whatsapp/conversations/${leadId}`);
    return res.data.data;
  },
  async getCapability(leadId: string): Promise<MessagingCapability> {
    const res = await apiClient.get<ApiEnvelope<MessagingCapability>>(`/whatsapp/conversations/${leadId}/capability`);
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
  async archive(leadId: string): Promise<{ archived: boolean }> {
    const res = await apiClient.post<ApiEnvelope<{ archived: boolean }>>(`/whatsapp/conversations/${leadId}/archive`);
    return res.data.data;
  },
  async unarchive(leadId: string): Promise<{ archived: boolean }> {
    const res = await apiClient.post<ApiEnvelope<{ archived: boolean }>>(`/whatsapp/conversations/${leadId}/unarchive`);
    return res.data.data;
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
