import type { WhatsAppDirection, WhatsAppMessageStatus, WhatsAppMessageType, WhatsAppProviderName } from "../../../generated/prisma/enums.js";

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
