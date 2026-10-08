import type { ConversationMode, WebChatSender } from "../../../generated/prisma/enums.js";

/**
 * Agent-facing Website Chat Live Queue API (`/api/webchat/*`) - the CRM-side counterpart to the
 * `webhooks/website-chat` module. Field shapes follow the same conventions as
 * call/call.history.types.ts (CallListItem/CallListResult) and whatsapp.conversation.types.ts.
 */

export interface ListWebChatConversationsQuery {
  page: number;
  limit: number;
  search?: string;
  archived?: boolean;
  mode?: ConversationMode;
  /** true = assignedToId is set, false = unassigned (the open queue). */
  assigned?: boolean;
}

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
  mode: ConversationMode;
  intent: string | null;
  productInterest: string | null;
  lastMessageAt: Date | null;
  /** The most recent message's text/sender, for the queue preview - null for a brand-new
   * conversation with no messages yet. */
  lastMessagePreview: string | null;
  lastMessageSender: WebChatSender | null;
  lastReadAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface WebChatMessageItem {
  id: string;
  sender: WebChatSender;
  body: string;
  sentBy: WebChatAgentRef | null;
  createdAt: Date;
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

export interface AssignWebChatConversationBody {
  assignedToId: string;
}

export interface SendWebChatAgentMessageBody {
  text: string;
}
