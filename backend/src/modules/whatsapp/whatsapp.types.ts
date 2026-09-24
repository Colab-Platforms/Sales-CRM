import type {
  WhatsAppDirection,
  WhatsAppMessageStatus,
  WhatsAppMessageType,
  WhatsAppProviderName,
} from "../../../generated/prisma/enums.js";

export interface WhatsAppStatusResult {
  configured: boolean;
  provider: string | null;
  /** Only present when configured is false - variable names only, never secret values. */
  problems?: string[];
}

export interface SendWhatsAppMessageInput {
  leadId: string;
  templateName: string;
  params: string[];
}

export interface WhatsAppMessageSummary {
  id: string;
  provider: WhatsAppProviderName;
  direction: WhatsAppDirection;
  messageType: WhatsAppMessageType;
  status: WhatsAppMessageStatus;
  providerMessageId: string | null;
  templateName: string | null;
  // E7.3: set only for a message sent through the structured template flow (whatsapp.messaging.
  // service.ts); null for E7.1's raw send and for every INBOUND row.
  templateId: string | null;
  orderId: string | null;
  body: string | null;
  errorMessage: string | null;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  receivedAt: Date | null;
}

export interface CustomerWhatsAppStatus {
  leadId: string;
  totalMessages: number;
  lastMessage: WhatsAppMessageSummary | null;
}
