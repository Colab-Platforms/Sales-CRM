// Mirrors backend/src/modules/webchat/webchat.types.ts exactly - the Website Chat Live Queue API.

export type WebChatMode = "AI" | "HUMAN";

export type WebChatSender = "CUSTOMER" | "AI" | "AGENT";

export interface WebChatLeadRef {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string | null;
  mobile: string | null;
  email: string | null;
}

export interface WebChatAgentRef {
  id: string;
  name: string;
}

export interface WebChatConversationListItem {
  id: string;
  externalConversationId: string;
  lead: WebChatLeadRef | null;
  assignedTo: WebChatAgentRef | null;
  mode: WebChatMode;
  intent: string | null;
  productInterest: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageSender: WebChatSender | null;
  lastReadAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface WebChatMessageItem {
  id: string;
  sender: WebChatSender;
  body: string;
  sentBy: WebChatAgentRef | null;
  createdAt: string;
}

export interface WebChatConversationDetail extends WebChatConversationListItem {
  messages: WebChatMessageItem[];
}

export interface WebChatListPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface WebChatConversationListResult {
  data: WebChatConversationListItem[];
  pagination: WebChatListPagination;
}

export interface WebChatListParams {
  page?: number;
  limit?: number;
  search?: string;
  archived?: boolean;
  mode?: WebChatMode;
  assigned?: boolean;
}

export interface WebChatModeResult {
  id: string;
  mode: WebChatMode;
}

export interface WebChatAssignResult {
  id: string;
  assignedTo: WebChatAgentRef;
}

export interface WebChatSendMessageResult {
  messageId: string;
  createdAt: string;
  /** Whether the reply reached the chatbot for the visitor to see - false means it is saved in the
   * CRM only (chatbot unreachable or two-way reply not configured). */
  delivered: boolean;
}
