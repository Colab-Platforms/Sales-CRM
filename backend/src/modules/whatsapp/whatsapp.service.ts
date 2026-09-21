import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { resolveWhatsAppConfig } from "./whatsapp.config.js";
import { getWhatsAppProvider } from "./whatsapp.factory.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { NormalizedIncomingMessage, NormalizedStatusUpdate, WhatsAppDeliveryStatus, WhatsAppProvider, WhatsAppProviderId } from "./whatsapp.provider.js";
import { matchSenderToLead } from "./whatsapp.matching.js";
import { buildMessageWhere, mapMessageHistoryItem, scopedMessageWhere } from "./whatsapp.history.filters.js";
import type { ListMessagesQuery, WhatsAppMessageHistoryItem, WhatsAppMessageListResult } from "./whatsapp.history.types.js";
import type { CustomerWhatsAppStatus, SendWhatsAppMessageInput, WhatsAppMessageSummary, WhatsAppStatusResult } from "./whatsapp.types.js";

// E7.4: a read-only, richer view (customer/template/order/sender resolved to names, not just ids)
// of the same whatsapp_messages table MESSAGE_SELECT above already reads - one nested-select query,
// no N+1, same convention as audit.service.ts's AUDIT_SELECT.
const HISTORY_SELECT = {
  id: true,
  provider: true,
  direction: true,
  messageType: true,
  status: true,
  providerMessageId: true,
  body: true,
  errorMessage: true,
  createdAt: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
  failedAt: true,
  receivedAt: true,
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true } },
  template: { select: { id: true, name: true } },
  order: { select: { id: true, orderNumber: true, externalNumber: true } },
  sentBy: { select: { id: true, name: true } },
} satisfies Prisma.WhatsAppMessageSelect;

const MESSAGE_SELECT = {
  id: true,
  provider: true,
  direction: true,
  messageType: true,
  status: true,
  providerMessageId: true,
  templateName: true,
  templateId: true,
  orderId: true,
  body: true,
  errorMessage: true,
  createdAt: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
  failedAt: true,
  receivedAt: true,
} satisfies Prisma.WhatsAppMessageSelect;

function mapMessage(row: Prisma.WhatsAppMessageGetPayload<{ select: typeof MESSAGE_SELECT }>): WhatsAppMessageSummary {
  return { ...row };
}

// Delivery-status rank so a late/duplicate event can never move a message backwards (e.g. a
// re-delivered "delivered" event arriving after we already recorded "read").
const STATUS_RANK: Record<WhatsAppDeliveryStatus, number> = { SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };
const currentRank = (status: string): number => (status in STATUS_RANK ? STATUS_RANK[status as WhatsAppDeliveryStatus] : 0);

const ACTIVITY_BY_STATUS: Partial<Record<WhatsAppDeliveryStatus, { type: ActivityType; title: string }>> = {
  DELIVERED: { type: ActivityType.WHATSAPP_DELIVERED, title: "WhatsApp message delivered" },
  READ: { type: ActivityType.WHATSAPP_READ, title: "WhatsApp message read" },
  FAILED: { type: ActivityType.WHATSAPP_FAILED, title: "WhatsApp message failed" },
};

const REFERENCE_TYPE = "WhatsAppMessage";

class WhatsAppService {
  // getProvider is injectable so tests can exercise send/persist logic against a fake provider
  // without real credentials or network calls - the provider adapters themselves (HTTP calls,
  // signature verification, payload parsing) are unit-tested directly in whatsapp.test.ts.
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getProvider: () => WhatsAppProvider | null = getWhatsAppProvider,
  ) {}

  getStatus(): WhatsAppStatusResult {
    const result = resolveWhatsAppConfig();
    return result.ok ? { configured: true, provider: result.config.kind } : { configured: false, provider: result.provider, problems: result.problems };
  }

  async sendTemplateMessage(user: AuthUser, input: SendWhatsAppMessageInput): Promise<WhatsAppMessageSummary> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({
      where: scopedLeadWhere(input.leadId, leadScope),
      select: { id: true, firstName: true, lastName: true, mobile: true, normalizedMobile: true },
    });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    if (!lead.normalizedMobile) throw new ApiError("This customer has no valid WhatsApp/mobile number on file", STATUS_CODES.BAD_REQUEST);

    const provider = this.getProvider();
    if (!provider) throw new ApiError("WhatsApp is not configured", STATUS_CODES.SERVICE_UNAVAILABLE);

    const contactName = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || undefined;
    let result;
    try {
      result = await provider.sendTemplateMessage({ to: lead.normalizedMobile, templateName: input.templateName, params: input.params, contactName });
    } catch (error) {
      if (error instanceof WhatsAppSendError) throw new ApiError(error.message, STATUS_CODES.BAD_REQUEST);
      throw error;
    }

    const row = await this.db.whatsAppMessage.create({
      data: {
        provider: provider.id,
        providerMessageId: result.providerMessageId,
        direction: "OUTBOUND",
        messageType: "TEMPLATE",
        status: result.providerMessageId ? "SENT" : "QUEUED",
        leadId: lead.id,
        toNumber: lead.normalizedMobile,
        normalizedContact: lead.normalizedMobile,
        templateName: input.templateName,
        sentById: user.id,
        sentAt: new Date(),
      },
      select: MESSAGE_SELECT,
    });

    await this.db.activity.create({
      data: {
        leadId: lead.id,
        actorId: user.id,
        actorRole: user.role,
        type: ActivityType.WHATSAPP_MESSAGE_SENT,
        referenceType: REFERENCE_TYPE,
        referenceId: row.id,
        source: ActivitySource.USER,
        title: "WhatsApp template sent",
        description: input.templateName,
      },
    });

    return mapMessage(row);
  }

  async getCustomerWhatsAppStatus(user: AuthUser, leadId: string): Promise<CustomerWhatsAppStatus> {
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);

    const [totalMessages, last] = await Promise.all([
      this.db.whatsAppMessage.count({ where: { leadId } }),
      this.db.whatsAppMessage.findFirst({ where: { leadId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: MESSAGE_SELECT }),
    ]);

    return { leadId, totalMessages, lastMessage: last ? mapMessage(last) : null };
  }

  // ---- E7.4: read-only message history/conversation view. Never calls the provider, never
  // mutates a message's status, never writes an Activity - purely a different way to read the same
  // rows E7.1/E7.3 already wrote. ----

  async listMessages(user: AuthUser, query: ListMessagesQuery): Promise<WhatsAppMessageListResult> {
    const leadScope = await getLeadScope(user, this.db);

    // A leadId filter for a customer outside the caller's scope must not silently return someone
    // else's messages under a scope-widened query - fail the same way a direct customer lookup
    // would (out-of-scope looks like empty, not an error, consistent with 404-not-403 elsewhere).
    if (query.leadId && Object.keys(leadScope).length > 0) {
      const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(query.leadId, leadScope), select: { id: true } });
      if (!lead) return { items: [], pagination: { page: query.page, pageSize: query.pageSize, totalItems: 0, totalPages: 0 } };
    }

    const where = buildMessageWhere(query, leadScope);
    const [totalItems, rows] = await Promise.all([
      this.db.whatsAppMessage.count({ where }),
      this.db.whatsAppMessage.findMany({
        where,
        select: HISTORY_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map(mapMessageHistoryItem),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
  }

  async getMessage(user: AuthUser, id: string): Promise<WhatsAppMessageHistoryItem> {
    const leadScope = await getLeadScope(user, this.db);
    const row = await this.db.whatsAppMessage.findFirst({ where: scopedMessageWhere(id, leadScope), select: HISTORY_SELECT });
    if (!row) throw new ApiError("Message not found", STATUS_CODES.NOT_FOUND);
    return mapMessageHistoryItem(row);
  }

  // ---- Webhook-driven persistence (called from whatsapp.webhook.processor.ts). Never invents a
  // customer: an unmatched sender's message is still stored, with leadId left null. ----

  async recordInboundMessage(provider: WhatsAppProviderId, message: NormalizedIncomingMessage): Promise<void> {
    const { leadId, normalizedContact } = await matchSenderToLead(message.from, { db: this.db });

    // Idempotent: a repeat delivery of the same provider message id updates nothing new.
    const existing = await this.db.whatsAppMessage.findUnique({ where: { provider_providerMessageId: { provider, providerMessageId: message.providerMessageId } } });
    if (existing) return;

    const row = await this.db.whatsAppMessage.create({
      data: {
        provider,
        providerMessageId: message.providerMessageId,
        direction: "INBOUND",
        messageType: message.messageType,
        status: "RECEIVED",
        leadId,
        fromNumber: message.from,
        toNumber: message.to,
        normalizedContact,
        body: message.text?.slice(0, 4000) ?? null,
        receivedAt: message.timestamp,
      },
      select: { id: true },
    });

    if (!leadId) return; // Unresolved sender: stored, but there is no lead to attach an Activity to.
    await this.db.activity.create({
      data: {
        leadId,
        source: ActivitySource.WHATSAPP_WEBHOOK,
        type: ActivityType.WHATSAPP_MESSAGE_RECEIVED,
        referenceType: REFERENCE_TYPE,
        referenceId: row.id,
        title: "WhatsApp message received",
        description: message.text?.slice(0, 4000) ?? null,
      },
    });
  }

  async recordStatusUpdate(provider: WhatsAppProviderId, update: NormalizedStatusUpdate): Promise<void> {
    const existing = await this.db.whatsAppMessage.findUnique({
      where: { provider_providerMessageId: { provider, providerMessageId: update.providerMessageId } },
      select: { id: true, status: true, leadId: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true },
    });
    // A status event for a message the CRM never recorded sending is not fabricated into a new row.
    if (!existing) return;

    const timestampField = { SENT: "sentAt", DELIVERED: "deliveredAt", READ: "readAt", FAILED: "failedAt" } as const;
    const field = timestampField[update.status];
    const isAdvance = currentRank(update.status) > currentRank(existing.status);

    // A same-or-lower-rank event (stale, duplicate, or arriving out of order - e.g. a delayed
    // DELIVERED webhook after READ already landed) must never move status backwards or re-fire an
    // activity. It can still carry real information about *when* its own milestone happened, so that
    // one timestamp is backfilled if - and only if - nothing was ever recorded for it; an
    // already-known timestamp is never overwritten by a later duplicate.
    if (!isAdvance && existing[field] != null) return;

    const row = await this.db.whatsAppMessage.update({
      where: { id: existing.id },
      data: {
        ...(isAdvance ? { status: update.status, errorCode: update.errorCode ?? undefined, errorMessage: update.errorMessage ?? undefined } : {}),
        [field]: update.timestamp,
      },
      select: { id: true },
    });

    if (!isAdvance || !existing.leadId) return;
    const meta = ACTIVITY_BY_STATUS[update.status];
    if (!meta) return; // SENT is the initial state, not its own audit event
    await this.db.activity.create({
      data: {
        leadId: existing.leadId,
        source: ActivitySource.WHATSAPP_WEBHOOK,
        type: meta.type,
        referenceType: REFERENCE_TYPE,
        referenceId: row.id,
        title: meta.title,
        description: update.status === "FAILED" ? (update.errorMessage ?? null) : null,
      },
    });
  }
}

export default WhatsAppService;
