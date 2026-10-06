import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  WebChatAssignResult,
  WebChatConversationDetail,
  WebChatConversationListResult,
  WebChatListParams,
  WebChatModeResult,
  WebChatSendMessageResult,
} from "../types/webchat.types";

/** Thin wrappers over the existing `/api/webchat/*` routes (backend/src/modules/webchat). */
export const webChatApi = {
  async list(params: WebChatListParams): Promise<WebChatConversationListResult> {
    const res = await apiClient.get<ApiEnvelope<WebChatConversationListResult>>("/webchat/conversations", { params });
    return res.data.data;
  },

  async getDetail(id: string): Promise<WebChatConversationDetail> {
    const res = await apiClient.get<ApiEnvelope<WebChatConversationDetail>>(`/webchat/conversations/${id}`);
    return res.data.data;
  },

  async markRead(id: string): Promise<void> {
    await apiClient.post(`/webchat/conversations/${id}/read`);
  },

  async assign(id: string, assignedToId: string): Promise<WebChatAssignResult> {
    const res = await apiClient.post<ApiEnvelope<WebChatAssignResult>>(`/webchat/conversations/${id}/assign`, { assignedToId });
    return res.data.data;
  },

  async handoff(id: string): Promise<WebChatModeResult> {
    const res = await apiClient.post<ApiEnvelope<WebChatModeResult>>(`/webchat/conversations/${id}/handoff`);
    return res.data.data;
  },

  async returnToAi(id: string): Promise<WebChatModeResult> {
    const res = await apiClient.post<ApiEnvelope<WebChatModeResult>>(`/webchat/conversations/${id}/ai-mode`);
    return res.data.data;
  },

  async archive(id: string): Promise<{ id: string; archivedAt: string }> {
    const res = await apiClient.post<ApiEnvelope<{ id: string; archivedAt: string }>>(`/webchat/conversations/${id}/archive`);
    return res.data.data;
  },

  /** Stores the CRM AGENT message only. It is NOT delivered to the website visitor yet. */
  async sendMessage(id: string, text: string): Promise<WebChatSendMessageResult> {
    const res = await apiClient.post<ApiEnvelope<WebChatSendMessageResult>>(`/webchat/conversations/${id}/messages`, { text });
    return res.data.data;
  },
};
