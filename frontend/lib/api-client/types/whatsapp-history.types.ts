// Kept in sync with backend/src/modules/whatsapp/whatsapp.history.types.ts.
import type { WhatsAppProvider } from "./whatsapp-templates.types";

export type WhatsAppDirection = "INBOUND" | "OUTBOUND";
export type WhatsAppMessageStatus = "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "RECEIVED";

export interface ListMessagesParams {
  page: number;
  pageSize: number;
  leadId?: string;
  direction?: WhatsAppDirection;
  status?: WhatsAppMessageStatus;
  provider?: WhatsAppProvider;
  templateId?: string;
  orderId?: string;
  // ISO date-times
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export interface WhatsAppMessageHistoryItem {
  id: string;
  provider: WhatsAppProvider;
  direction: WhatsAppDirection;
  messageType: string;
  status: WhatsAppMessageStatus;
  providerMessageId: string | null;
  body: string | null;
  errorMessage: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  receivedAt: string | null;
  customer: { leadId: string; leadNumber: string; name: string } | null;
  template: { id: string; name: string } | null;
  order: { id: string; orderNumber: string; externalNumber: string | null } | null;
  sentBy: { id: string; name: string } | null;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface WhatsAppMessageListResult {
  items: WhatsAppMessageHistoryItem[];
  pagination: Pagination;
}

// ---- Central WhatsApp Inbox conversation list ----

export interface ListConversationsParams {
  page: number;
  pageSize: number;
  search?: string;
  // false/omitted: the normal inbox (archived hidden). true: only archived conversations.
  archived?: boolean;
}

export type ConversationMode = "AI" | "HUMAN";
export type OrderConversationState =
  | "DISCOVERY"
  | "PRODUCT_SELECTED"
  | "QUANTITY_SELECTED"
  | "CUSTOMER_DETAILS"
  | "ADDRESS_REQUIRED"
  | "ADDRESS_CONFIRMED"
  | "PAYMENT_METHOD"
  | "ORDER_REVIEW"
  | "CUSTOMER_CONFIRMED"
  | "ORDER_CREATED";

export interface ConversationSummary {
  leadId: string;
  leadNumber: string;
  name: string;
  mobile: string | null;
  lastMessage: {
    id: string;
    direction: WhatsAppDirection;
    messageType: string;
    status: WhatsAppMessageStatus;
    body: string | null;
    templateName: string | null;
    at: string;
  };
  awaitingReply: boolean;
  mode: ConversationMode;
  assignedTo: { id: string; name: string } | null;
  orderState: OrderConversationState;
  unreadCount: number;
  archived: boolean;
}

export interface ConversationListResult {
  items: ConversationSummary[];
  pagination: Pagination;
}
