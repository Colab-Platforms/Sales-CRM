import type { Prisma } from "../../../generated/prisma/client.js";
import { fullName } from "../orders/orders.filters.js";
import type { ListMessagesQuery, WhatsAppMessageHistoryItem } from "./whatsapp.history.types.js";

export function buildMessageWhere(query: ListMessagesQuery, leadScope: Prisma.LeadWhereInput): Prisma.WhatsAppMessageWhereInput {
  const and: Prisma.WhatsAppMessageWhereInput[] = [];

  // A message with no lead (an inbound sender the CRM could not match, E7.1) has no lead to
  // satisfy this filter against, so it is naturally invisible to anyone but ADMIN - the same rule
  // already relied on for lead-less WhatsApp template Activity rows (E7.2).
  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (query.leadId) and.push({ leadId: query.leadId });
  if (query.direction) and.push({ direction: query.direction });
  if (query.status) and.push({ status: query.status });
  if (query.provider) and.push({ provider: query.provider });
  if (query.templateId) and.push({ templateId: query.templateId });
  if (query.orderId) and.push({ orderId: query.orderId });
  if (query.dateFrom || query.dateTo) and.push({ createdAt: { gte: query.dateFrom, lte: query.dateTo } });
  if (query.search) {
    const contains = { contains: query.search, mode: "insensitive" as const };
    and.push({ OR: [{ body: contains }, { templateName: contains }] });
  }

  return and.length > 0 ? { AND: and } : {};
}

// One order, but only if the user's lead scope allows it - mirrors scopedOrderWhere/scopedLeadWhere.
export function scopedMessageWhere(id: string, leadScope: Prisma.LeadWhereInput): Prisma.WhatsAppMessageWhereInput {
  return Object.keys(leadScope).length > 0 ? { AND: [{ id }, { lead: leadScope }] } : { id };
}

/** Every message that belongs to a real Lead, scoped and optionally name/mobile-searched - the base query the Inbox's conversation list groups by leadId. */
export function buildConversationWhere(leadScope: Prisma.LeadWhereInput, search?: string): Prisma.WhatsAppMessageWhereInput {
  const and: Prisma.WhatsAppMessageWhereInput[] = [{ leadId: { not: null } }];
  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  if (search) {
    const contains = { contains: search, mode: "insensitive" as const };
    and.push({ lead: { OR: [{ firstName: contains }, { lastName: contains }, { mobile: contains }, { normalizedMobile: contains }] } });
  }
  return { AND: and };
}

export interface MessageHistoryRow {
  id: string;
  provider: WhatsAppMessageHistoryItem["provider"];
  direction: WhatsAppMessageHistoryItem["direction"];
  messageType: WhatsAppMessageHistoryItem["messageType"];
  status: WhatsAppMessageHistoryItem["status"];
  providerMessageId: string | null;
  body: string | null;
  errorMessage: string | null;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  receivedAt: Date | null;
  lead: { id: string; leadNumber: string; firstName: string; lastName: string | null } | null;
  template: { id: string; name: string } | null;
  order: { id: string; orderNumber: string; externalNumber: string | null } | null;
  sentBy: { id: string; name: string } | null;
}

export function mapMessageHistoryItem(row: MessageHistoryRow): WhatsAppMessageHistoryItem {
  return {
    id: row.id,
    provider: row.provider,
    direction: row.direction,
    messageType: row.messageType,
    status: row.status,
    providerMessageId: row.providerMessageId,
    body: row.body,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
    failedAt: row.failedAt,
    receivedAt: row.receivedAt,
    customer: row.lead ? { leadId: row.lead.id, leadNumber: row.lead.leadNumber, name: fullName(row.lead.firstName, row.lead.lastName) } : null,
    template: row.template,
    order: row.order,
    sentBy: row.sentBy,
  };
}
