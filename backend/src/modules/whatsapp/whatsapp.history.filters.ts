import type { Prisma } from "../../../generated/prisma/client.js";
import { Role } from "../../../generated/prisma/enums.js";
import { fullName } from "../orders/orders.filters.js";
import type { ListMessagesQuery, WhatsAppMessageHistoryItem } from "./whatsapp.history.types.js";

/**
 * WhatsApp conversations and message history are READABLE company-wide by ADMIN, MANAGER and SALESPERSON (telecaller): a customer's reply is visible whichever team or user owns the
 * lead. Only reading uses this - sending, deleting, assigning, archiving, forwarding, starring and order creation keep the normal lead scope (or their own role checks). HR keeps the
 * normal scope, which matches no lead. Customer, lead, order and abandoned-checkout scoping are separate and unchanged.
 */
export function canViewAllWhatsAppConversations(role: string): boolean {
  return role === Role.ADMIN || role === Role.MANAGER || role === Role.SALESPERSON;
}

export function whatsAppReadScope(role: string, leadScope: Prisma.LeadWhereInput): Prisma.LeadWhereInput {
  return canViewAllWhatsAppConversations(role) ? {} : leadScope;
}

// userId: whoever is asking - a message this user chose "Delete for me" on is excluded for them
// alone (WhatsAppMessageUserState is per-user; everyone else still sees it). The row itself is
// never touched, so this can never hide a message "for everyone" by accident.
export function buildMessageWhere(query: ListMessagesQuery, leadScope: Prisma.LeadWhereInput, userId: string, thread?: { leadIds: string[]; contacts: string[] }): Prisma.WhatsAppMessageWhereInput {
  const and: Prisma.WhatsAppMessageWhereInput[] = [];

  // A message with no lead (an inbound sender the CRM could not match, E7.1) has no lead to
  // satisfy this filter against, so it is naturally invisible to anyone but ADMIN - the same rule
  // already relied on for lead-less WhatsApp template Activity rows (E7.2).
  if (Object.keys(leadScope).length > 0) and.push({ lead: leadScope });
  // thread: the same phone number can sit on more than one lead, and a message may have been stored with no lead at all; the customer's thread is read across all of them by EXACT phone
  // (see threadOf). Nothing is re-attached in the database - this only decides what is shown together.
  if (query.leadId) {
    and.push(thread && thread.leadIds.length > 0
      ? { OR: [{ leadId: { in: thread.leadIds } }, ...(thread.contacts.length > 0 ? [{ leadId: null, normalizedContact: { in: thread.contacts } }] : [])] }
      : { leadId: query.leadId });
  }
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
  and.push({ NOT: { userStates: { some: { userId, hiddenAt: { not: null } } } } });

  return and.length > 0 ? { AND: and } : {};
}

// One order, but only if the user's lead scope allows it - mirrors scopedOrderWhere/scopedLeadWhere.
export function scopedMessageWhere(id: string, leadScope: Prisma.LeadWhereInput): Prisma.WhatsAppMessageWhereInput {
  return Object.keys(leadScope).length > 0 ? { AND: [{ id }, { lead: leadScope }] } : { id };
}

/** Every message that belongs to a real Lead, scoped and optionally name/mobile-searched - the base query the Inbox's conversation list groups by leadId. */
export function buildConversationWhere(leadScope: Prisma.LeadWhereInput, search?: string): Prisma.WhatsAppMessageWhereInput {
  // A deactivated customer (Part 8, WhatsApp Inbox: "Delete Customer") drops out of the active
  // Inbox/conversation list entirely - their message history is still reachable through Customer
  // 360's own timeline, just not through this operational queue.
  const and: Prisma.WhatsAppMessageWhereInput[] = [{ leadId: { not: null } }, { lead: { workingStatus: { not: "DEACTIVATED" } } }];
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
  replyToProviderMessageId: string | null;
  body: string | null;
  errorMessage: string | null;
  errorCode: string | null;
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

export function mapMessageHistoryItem(row: MessageHistoryRow, starred: boolean = false): WhatsAppMessageHistoryItem {
  return {
    starred,
    id: row.id,
    provider: row.provider,
    direction: row.direction,
    messageType: row.messageType,
    status: row.status,
    providerMessageId: row.providerMessageId,
    replyToProviderMessageId: row.replyToProviderMessageId,
    body: row.body,
    errorMessage: row.errorMessage,
    errorCode: row.errorCode,
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
