import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import { logger } from "@/utils/logger.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import { fullName } from "../orders/orders.filters.js";
import { resolveWhatsAppConfig } from "./whatsapp.config.js";
import { getWhatsAppProvider } from "./whatsapp.factory.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { NormalizedIncomingMessage, NormalizedStatusUpdate, WhatsAppDeliveryStatus, WhatsAppProvider, WhatsAppProviderId } from "./whatsapp.provider.js";
import { legacyMatchCandidates, matchSenderToLead, threadOf } from "./whatsapp.matching.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import LeadService from "../lead/lead.service.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";
import WhatsAppOrderConversationService from "./whatsapp.order-conversation.service.js";
import { buildConversationWhere, buildMessageWhere, mapMessageHistoryItem, scopedMessageWhere, whatsAppReadScope, canViewAllWhatsAppConversations } from "./whatsapp.history.filters.js";
import type { ConversationListResult, ConversationSummary, ListConversationsQuery, ListMessagesQuery, UnmatchedConversation, WhatsAppMessageHistoryItem, WhatsAppMessageListResult } from "./whatsapp.history.types.js";
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
  replyToProviderMessageId: true,
  body: true,
  errorMessage: true,
  errorCode: true,
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
  private readonly leadService: LeadService;
  private readonly conversationService: WhatsAppConversationService;
  private readonly orderConversationService: WhatsAppOrderConversationService;

  constructor(
    private readonly db: DbClient = prisma,
    private readonly getProvider: () => WhatsAppProvider | null = getWhatsAppProvider,
  ) {
    this.leadService = new LeadService();
    this.conversationService = new WhatsAppConversationService(this.db);
    this.orderConversationService = new WhatsAppOrderConversationService(this.db);
  }

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
    const leadScope = whatsAppReadScope(user.role, await getLeadScope(user, this.db));

    // A leadId filter for a customer outside the caller's scope must not silently return someone
    // else's messages under a scope-widened query - fail the same way a direct customer lookup
    // would (out-of-scope looks like empty, not an error, consistent with 404-not-403 elsewhere).
    if (query.leadId && Object.keys(leadScope).length > 0) {
      const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(query.leadId, leadScope), select: { id: true } });
      if (!lead) return { items: [], pagination: { page: query.page, pageSize: query.pageSize, totalItems: 0, totalPages: 0 } };
    }

    // One customer = one thread: for the roles that read every conversation, a lead's history also includes the messages sitting on another lead with the same phone number.
    const thread = query.leadId && canViewAllWhatsAppConversations(user.role) ? await threadOf(this.db, query.leadId) : undefined;
    const where = buildMessageWhere(query, leadScope, user.id, thread);
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

    // Starred is per-viewer (WhatsAppMessageUserState), so it's a separate small lookup rather than
    // a field HISTORY_SELECT could carry for an unparametrized static select - same "overlay a second,
    // targeted query onto an already-fetched page" idiom orders.live.service.ts's CRM join already uses.
    const starredIds = rows.length > 0
      ? new Set((await this.db.whatsAppMessageUserState.findMany({ where: { userId: user.id, messageId: { in: rows.map((r) => r.id) }, starred: true }, select: { messageId: true } })).map((s) => s.messageId))
      : new Set<string>();

    return {
      items: rows.map((row) => mapMessageHistoryItem(row, starredIds.has(row.id))),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
  }

  async getMessage(user: AuthUser, id: string): Promise<WhatsAppMessageHistoryItem> {
    const leadScope = whatsAppReadScope(user.role, await getLeadScope(user, this.db));
    const row = await this.db.whatsAppMessage.findFirst({ where: scopedMessageWhere(id, leadScope), select: HISTORY_SELECT });
    if (!row) throw new ApiError("Message not found", STATUS_CODES.NOT_FOUND);
    const state = await this.db.whatsAppMessageUserState.findUnique({ where: { messageId_userId: { messageId: id, userId: user.id } }, select: { starred: true } });
    return mapMessageHistoryItem(row, state?.starred ?? false);
  }

  // Starred messages for the current user, optionally scoped to one conversation - the same
  // "Starred messages" idea WhatsApp itself has, built on the same WhatsAppMessageUserState rows
  // setStarred() above writes. RBAC: a message whose lead has since left this user's scope (a
  // reassignment, say) is excluded, the same as every other lead-scoped read.
  async listStarredMessages(user: AuthUser, leadId?: string): Promise<WhatsAppMessageHistoryItem[]> {
    const leadScope = whatsAppReadScope(user.role, await getLeadScope(user, this.db));
    const states = await this.db.whatsAppMessageUserState.findMany({
      where: {
        userId: user.id,
        starred: true,
        message: { AND: [leadId ? { leadId } : {}, Object.keys(leadScope).length > 0 ? { lead: leadScope } : {}] },
      },
      select: { message: { select: HISTORY_SELECT } },
      orderBy: { updatedAt: "desc" },
    });
    return states.map((s) => mapMessageHistoryItem(s.message, true));
  }

  // Central WhatsApp Inbox's conversation list: one row per Lead, carrying only their latest
  // message - built entirely on the same whatsapp_messages table and lead-scope RBAC as
  // listMessages/getMessage above, never a second data source. Prisma has no native "latest row per
  // group" query, so this reduces a bounded recent window in memory rather than reaching for raw
  // SQL - correct and simple at this CRM's real message volume; the window (not the whole table) is
  // what's paginated, a known, documented limit rather than a silent one.
  async listConversations(user: AuthUser, query: ListConversationsQuery): Promise<ConversationListResult> {
    const leadScope = whatsAppReadScope(user.role, await getLeadScope(user, this.db));
    const where = buildConversationWhere(leadScope, query.search);

    const RECENT_WINDOW = 500;
    const recent = await this.db.whatsAppMessage.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_WINDOW,
      select: {
        id: true,
        leadId: true,
        direction: true,
        messageType: true,
        status: true,
        body: true,
        templateName: true,
        createdAt: true,
        sentAt: true,
        receivedAt: true,
        lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true, normalizedMobile: true } },
      },
    });

    const byLead = new Map<string, (typeof recent)[number]>();
    for (const m of recent) {
      if (!m.leadId || byLead.has(m.leadId)) continue;
      byLead.set(m.leadId, m);
    }
    const perLead = [...byLead.values()]; // already newest-first, since `recent` was fetched newest-first and only the first occurrence per lead is kept

    // ONE row per customer phone. The same phone can exist on more than one lead (an import, a webhook or a manual entry created a duplicate); the Inbox used to show a row per lead.
    // Rows are grouped on the canonical phone only (never on a name), the newest message represents the group, and the other leads' ids are kept to sum the unread count.
    const groups = new Map<string, { rep: (typeof perLead)[number]; leadIds: string[] }>();
    for (const m of perLead) {
      const key = normalizeMobile(m.lead!.normalizedMobile ?? m.lead!.mobile ?? "") ?? `lead:${m.leadId}`;
      const group = groups.get(key);
      if (group) group.leadIds.push(m.leadId!);
      else groups.set(key, { rep: m, leadIds: [m.leadId!] });
    }

    // Messages stored with NO lead (an inbound that predates lead creation). They are never re-attached in the database; they are shown by EXACT phone: under the conversation of the
    // leads that have this phone, or - when no lead has it at all - in a read-only "unmatched" list, so they are never silently hidden. Only for the roles that read every conversation.
    const unmatched: UnmatchedConversation[] = [];
    const searchDigits = query.search ? query.search.replace(/\D/g, "") : null;
    if (canViewAllWhatsAppConversations(user.role) && (!query.search || searchDigits)) {
      const leadless = await this.db.whatsAppMessage.findMany({
        where: { leadId: null, ...(searchDigits ? { normalizedContact: { contains: searchDigits } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 200,
        select: { id: true, leadId: true, direction: true, messageType: true, status: true, body: true, templateName: true, createdAt: true, sentAt: true, receivedAt: true, normalizedContact: true, fromNumber: true, toNumber: true },
      });
      const byContact = new Map<string, typeof leadless>();
      for (const m of leadless) {
        const key = normalizeMobile(m.normalizedContact ?? m.fromNumber ?? m.toNumber ?? "");
        if (key) (byContact.get(key) ?? byContact.set(key, []).get(key)!).push(m);
      }
      for (const [key, msgs] of byContact) {
        const newest = msgs[0]!;
        const group = groups.get(key);
        if (group) {
          if (newest.createdAt > group.rep.createdAt) group.rep = { ...group.rep, ...newest, leadId: group.rep.leadId, lead: group.rep.lead };
          continue;
        }
        const lead = await this.db.lead.findFirst({
          where: { normalizedMobile: { in: legacyMatchCandidates(key) }, workingStatus: { not: "DEACTIVATED" } },
          orderBy: { createdAt: "asc" },
          select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true, normalizedMobile: true },
        });
        if (lead) groups.set(key, { rep: { ...newest, leadId: lead.id, lead }, leadIds: [lead.id] });
        else unmatched.push({ phone: key, messageCount: msgs.length, lastMessage: { id: newest.id, direction: newest.direction, body: newest.body, at: newest.receivedAt ?? newest.createdAt } });
      }
    }
    const deduped = [...groups.values()].map((g) => g.rep).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const memberLeadIds = new Map([...groups.values()].map((g) => [g.rep.leadId!, g.leadIds]));

    // Archived conversations are hidden from the normal inbox (default/archived=false) - or, with
    // ?archived=true, ONLY archived ones are shown. See WhatsAppConversationService.archivedLeadIds
    // for why this is a derived check, not a stored column: no schema change, and a new message
    // arriving after an archive automatically un-archives it for free.
    const lastMessageAtByLead = new Map(deduped.map((m) => [m.leadId!, m.createdAt]));
    const archivedLeadIds = await this.conversationService.archivedLeadIds([...lastMessageAtByLead.keys()], lastMessageAtByLead);
    const showArchived = query.archived === true;
    const conversations = deduped.filter((m) => archivedLeadIds.has(m.leadId!) === showArchived);

    const totalItems = conversations.length;
    const page = conversations.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);

    // WhatsAppConversation rows for this page only (bounded to pageSize, cheap) - a lead with
    // messages predating this feature (or whose conversation row hasn't been created yet) simply
    // gets the HUMAN/DISCOVERY/unassigned defaults below, same defaults getOrCreateConversation itself uses.
    const leadIds = page.map((m) => m.leadId!);
    const allMemberIds = [...new Set(leadIds.flatMap((id) => memberLeadIds.get(id) ?? [id]))];
    const conversationRows = await this.db.whatsAppConversation.findMany({
      where: { leadId: { in: allMemberIds } },
      select: { leadId: true, mode: true, orderState: true, lastReadAt: true, assignedTo: { select: { id: true, name: true } } },
    });
    const conversationByLead = new Map(conversationRows.map((c) => [c.leadId, c]));
    const unreadCounts = await Promise.all(
      leadIds.map(async (leadId) => {
        const counts = await Promise.all(
          (memberLeadIds.get(leadId) ?? [leadId]).map((memberId) => {
            const lastReadAt = conversationByLead.get(memberId)?.lastReadAt ?? null;
            return this.db.whatsAppMessage.count({ where: { leadId: memberId, direction: "INBOUND", createdAt: { gt: lastReadAt ?? new Date(0) } } });
          }),
        );
        return counts.reduce((a, b) => a + b, 0);
      }),
    );
    const unreadByLead = new Map(leadIds.map((leadId, i) => [leadId, unreadCounts[i]]));

    const items: ConversationSummary[] = page.map((m) => {
      const conversation = conversationByLead.get(m.leadId!);
      return {
        leadId: m.lead!.id,
        leadNumber: m.lead!.leadNumber,
        name: fullName(m.lead!.firstName, m.lead!.lastName),
        mobile: m.lead!.mobile ?? m.lead!.normalizedMobile,
        lastMessage: {
          id: m.id,
          direction: m.direction,
          messageType: m.messageType,
          status: m.status,
          body: m.body,
          templateName: m.templateName,
          at: (m.direction === "OUTBOUND" ? m.sentAt : m.receivedAt) ?? m.createdAt,
        },
        awaitingReply: m.direction === "INBOUND",
        mode: conversation?.mode ?? "HUMAN",
        assignedTo: conversation?.assignedTo ?? null,
        orderState: conversation?.orderState ?? "DISCOVERY",
        unreadCount: unreadByLead.get(m.leadId!) ?? 0,
        archived: archivedLeadIds.has(m.leadId!),
      };
    });

    return { items, pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) }, ...(unmatched.length > 0 && query.page === 1 ? { unmatched } : {}) };
  }

  // ---- Webhook-driven persistence (called from whatsapp.webhook.processor.ts). ----

  async recordInboundMessage(provider: WhatsAppProviderId, message: NormalizedIncomingMessage): Promise<void> {
    // Idempotent: a repeat delivery of the same provider message id does nothing new - checked
    // before any lead-matching/creation or AI work, so a retried webhook can never double-process.
    const existing = await this.db.whatsAppMessage.findUnique({ where: { provider_providerMessageId: { provider, providerMessageId: message.providerMessageId } } });
    if (existing) return;

    const normalizedContact = normalizeMobile(message.from);

    // Bug fix (race condition): lead-matching, lead-creation, and conversation-creation used to run
    // as separate, unguarded "check, then act" steps against `this.db` directly. Two inbound
    // messages from the SAME brand-new number arriving close together (two separate webhook
    // deliveries, each independently scheduled via its own setImmediate in
    // whatsapp.webhook.routes.ts - never serialized against each other) could each see "no existing
    // lead" and each create one, splitting the conversation in two - the same symptom the
    // normalizedMobile-format fix in whatsapp.matching.ts addresses, but from a timing angle instead
    // of a data-format one. Wrapping match -> create-if-needed -> conversation get-or-create in one
    // transaction, serialized per phone number by a Postgres advisory lock (session-scoped, released
    // automatically when the transaction ends - no schema change, no new table), makes this atomic:
    // a second concurrent call for the same number simply waits, then finds the lead/conversation the
    // first call just committed, instead of racing it.
    const result = await this.db.$transaction(async (tx) => {
      if (normalizedContact) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${normalizedContact})::bigint)`;
      }

      let { leadId } = await matchSenderToLead(message.from, { db: tx });

      // Unmatched sender: create the CRM contact, same "Source-attributed lead" pattern Meta/Shopify
      // already use (leadService.createLeadFromSource), never a bespoke lead-creation path.
      if (!leadId && normalizedContact) {
        let source = await tx.source.findFirst({ where: { type: "WHATSAPP" }, select: { id: true } });
        if (!source) source = await tx.source.create({ data: { name: "WhatsApp Inbound", type: "WHATSAPP", status: "ACTIVE" }, select: { id: true } });
        const lead = await this.leadService.createLeadFromSource(source.id, { firstName: message.from, mobile: message.from }, "Lead created from WhatsApp Inbox", tx);
        leadId = lead.id;
        // Align this lead's normalizedMobile with the form matchSenderToLead actually queries by
        // (leadIdentity.ts's, same scheme shopify.persist.ts already uses), so the next message from
        // this number takes the fast matched path instead of re-running createLeadFromSource's dedup.
        if (lead.normalizedMobile !== normalizedContact) {
          await tx.lead.update({ where: { id: leadId }, data: { normalizedMobile: normalizedContact } });
        }
      }

      const row = await tx.whatsAppMessage.create({
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
          // Real provider-reported reply reference only (Meta's context.id) - null for the large
          // majority of inbound messages, which is expected, not missing data.
          replyToProviderMessageId: message.replyToProviderMessageId ?? null,
        },
        select: { id: true },
      });

      if (!leadId) return { leadId: null, conversation: null }; // No phone number at all to match or create from (rare, malformed sender).

      await tx.activity.create({
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

      // The existing conversation for this lead is reused whenever one exists - getOrCreateConversation
      // only ever creates one on a lead's genuinely first message. Scoped to `tx` (not `this.db`) so it
      // shares the same advisory lock/transaction as the match-or-create step above.
      const conversation = await new WhatsAppConversationService(tx).getOrCreateConversation(leadId, provider);
      return { leadId, conversation };
    });

    if (!result.leadId || !result.conversation) return;
    if (result.conversation.mode === "AI") {
      // Fire-and-forget, same setImmediate pattern whatsapp.webhook.routes.ts already uses for
      // processing - keeps the webhook's own 200-ack timing unaffected by an AI call's latency.
      const { leadId, conversation } = result;
      setImmediate(() => {
        void this.orderConversationService
          .processInboundForAi({ leadId, messageText: message.text ?? "", conversation: { provider: conversation.provider, assignedToId: conversation.assignedToId, orderState: conversation.orderState, orderDraft: conversation.orderDraft as any } })
          .catch((error) => logger.error("WhatsApp AI order-taking processing failed", error instanceof Error ? error.message : error));
      });
    }
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
