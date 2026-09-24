import type { ConversationMode, OrderConversationState, WhatsAppDirection, WhatsAppMessageStatus, WhatsAppMessageType, WhatsAppProviderName } from "../../../generated/prisma/enums.js";

export interface ListMessagesQuery {
  page: number;
  pageSize: number;
  leadId?: string;
  direction?: WhatsAppDirection;
  status?: WhatsAppMessageStatus;
  provider?: WhatsAppProviderName;
  templateId?: string;
  orderId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  /** Plain `contains` match against body/templateName - see whatsapp.history.service.ts for why nothing fancier. */
  search?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

// Richer than WhatsAppMessageSummary (E7.1/E7.3's flat shape used for send/preview responses) -
// this is a read view meant to render a conversation without extra round trips, so the customer/
// template/order/sender are resolved names, not just ids, in one query (see HISTORY_SELECT).
export interface WhatsAppMessageHistoryItem {
  id: string;
  provider: WhatsAppProviderName;
  direction: WhatsAppDirection;
  messageType: WhatsAppMessageType;
  status: WhatsAppMessageStatus;
  providerMessageId: string | null;
  body: string | null;
  errorMessage: string | null;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  receivedAt: Date | null;
  customer: { leadId: string; leadNumber: string; name: string } | null;
  template: { id: string; name: string } | null;
  order: { id: string; orderNumber: string; externalNumber: string | null } | null;
  sentBy: { id: string; name: string } | null;
}

export interface WhatsAppMessageListResult {
  items: WhatsAppMessageHistoryItem[];
  pagination: Pagination;
}

// ---- Central WhatsApp Inbox: one row per Lead that has at least one WhatsApp message, carrying
// only its latest message - built on top of the same whatsapp_messages table / lead-scope RBAC as
// everything else in this file, never a second data source.

export interface ListConversationsQuery {
  page: number;
  pageSize: number;
  /** Matches against the lead's name/mobile - same idea as the history list's own `search`, scoped to contacts instead of message bodies. */
  search?: string;
}

export interface ConversationSummary {
  leadId: string;
  leadNumber: string;
  name: string;
  mobile: string | null;
  lastMessage: {
    id: string;
    direction: WhatsAppDirection;
    messageType: WhatsAppMessageType;
    status: WhatsAppMessageStatus;
    body: string | null;
    templateName: string | null;
    /** sentAt for an OUTBOUND message, receivedAt for an INBOUND one, createdAt otherwise - the same rule the existing conversation view already uses to decide what "the time" of a message is. */
    at: Date;
  };
  /** True only when the lead's own most recent message is INBOUND - i.e. the customer's turn, nobody has replied since. Derived purely from existing direction/recency data; not a stored "read" flag (none exists on WhatsAppMessage). */
  awaitingReply: boolean;
  /** From WhatsAppConversation (whatsapp.conversation.service.ts) - defaults applied when no row exists yet (a lead with messages predating that feature, or whose first message hasn't been processed as a real conversation yet). */
  mode: ConversationMode;
  assignedTo: { id: string; name: string } | null;
  orderState: OrderConversationState;
  unreadCount: number;
}

export interface ConversationListResult {
  items: ConversationSummary[];
  pagination: Pagination;
}
