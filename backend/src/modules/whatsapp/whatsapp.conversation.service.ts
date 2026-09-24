import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import { scopedLeadWhere } from "../customers/customers.filters.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, Role } from "../../../generated/prisma/enums.js";
import type { ConversationMode, Prisma, WhatsAppProviderName } from "../../../generated/prisma/client.js";
import type { AssignConversationInput, ConversationDetail, OrderDraft } from "./whatsapp.conversation.types.js";

const REFERENCE_TYPE = "WhatsAppConversation";

const CONVERSATION_SELECT = {
  id: true,
  leadId: true,
  provider: true,
  mode: true,
  assignedToId: true,
  assignedTo: { select: { id: true, name: true } },
  lastReadAt: true,
  orderState: true,
  orderDraft: true,
  aiSuggestedReply: true,
  lastAiHandoffReason: true,
  createdOrderId: true,
} satisfies Prisma.WhatsAppConversationSelect;

type ConversationRow = Prisma.WhatsAppConversationGetPayload<{ select: typeof CONVERSATION_SELECT }>;

class WhatsAppConversationService {
  constructor(private readonly db: DbClient = prisma) {}

  /** System-triggered, no RBAC - called from whatsapp.service.ts's recordInboundMessage for every
   *  inbound message. Creates the row (default mode HUMAN) on the first message from a lead, or
   *  just refreshes `provider` on every later one (a lead can message from a different number/BSP
   *  over time - the conversation stays the same, one per lead). */
  async getOrCreateConversation(leadId: string, provider: WhatsAppProviderName): Promise<ConversationRow> {
    const existing = await this.db.whatsAppConversation.findUnique({ where: { leadId }, select: CONVERSATION_SELECT });
    if (existing) {
      if (existing.provider === provider) return existing;
      return this.db.whatsAppConversation.update({ where: { leadId }, data: { provider }, select: CONVERSATION_SELECT });
    }
    return this.db.whatsAppConversation.create({ data: { leadId, provider }, select: CONVERSATION_SELECT });
  }

  /** A caller may act on a conversation when the lead is within their normal lead-scope (ADMIN/
   *  MANAGER-team/owning-SALESPERSON, same rule every other WhatsApp/lead route already uses) OR
   *  they are this specific conversation's assignee - a conversation can be assigned to someone
   *  handling WhatsApp for a customer they don't own outright. */
  private async assertAccess(user: AuthUser, leadId: string, conversation: { assignedToId: string | null }): Promise<void> {
    if (conversation.assignedToId === user.id) return;
    const leadScope = await getLeadScope(user, this.db);
    const lead = await this.db.lead.findFirst({ where: scopedLeadWhere(leadId, leadScope), select: { id: true } });
    if (!lead) throw new ApiError("Conversation not found", STATUS_CODES.NOT_FOUND);
  }

  private async getRowOrThrow(leadId: string): Promise<ConversationRow> {
    const row = await this.db.whatsAppConversation.findUnique({ where: { leadId }, select: CONVERSATION_SELECT });
    if (!row) throw new ApiError("Conversation not found", STATUS_CODES.NOT_FOUND);
    return row;
  }

  private async toDetail(row: ConversationRow): Promise<ConversationDetail> {
    const unreadCount = await this.db.whatsAppMessage.count({
      where: { leadId: row.leadId, direction: "INBOUND", createdAt: { gt: row.lastReadAt ?? new Date(0) } },
    });
    return {
      leadId: row.leadId,
      provider: row.provider,
      mode: row.mode,
      assignedTo: row.assignedTo,
      orderState: row.orderState,
      orderDraft: (row.orderDraft as unknown as OrderDraft) ?? null,
      aiSuggestedReply: row.aiSuggestedReply,
      lastAiHandoffReason: row.lastAiHandoffReason,
      createdOrderId: row.createdOrderId,
      unreadCount,
    };
  }

  async getConversationDetail(user: AuthUser, leadId: string): Promise<ConversationDetail> {
    const row = await this.getRowOrThrow(leadId);
    await this.assertAccess(user, leadId, row);
    return this.toDetail(row);
  }

  async markRead(user: AuthUser, leadId: string): Promise<void> {
    const row = await this.getRowOrThrow(leadId);
    await this.assertAccess(user, leadId, row);
    await this.db.whatsAppConversation.update({ where: { leadId }, data: { lastReadAt: new Date() } });
  }

  async assignConversation(user: AuthUser, leadId: string, input: AssignConversationInput): Promise<ConversationDetail> {
    const row = await this.getRowOrThrow(leadId);
    // Reassigning is an ADMIN/MANAGER action (deciding who owns a queue item); a SALESPERSON may
    // only claim an unassigned conversation they can already see, never hand it to someone else.
    if (user.role === Role.SALESPERSON) {
      if (row.assignedToId) throw new ApiError("Only an admin or manager can reassign a conversation", STATUS_CODES.FORBIDDEN);
      if (input.userId !== user.id) throw new ApiError("A salesperson can only assign a conversation to themselves", STATUS_CODES.FORBIDDEN);
      await this.assertAccess(user, leadId, row);
    }
    const updated = await this.db.whatsAppConversation.update({ where: { leadId }, data: { assignedToId: input.userId }, select: CONVERSATION_SELECT });
    await this.db.activity.create({
      data: { leadId, actorId: user.id, actorRole: user.role, type: ActivityType.CONVERSATION_ASSIGNED, referenceType: REFERENCE_TYPE, referenceId: row.id, source: ActivitySource.USER, title: "WhatsApp conversation assigned" },
    });
    return this.toDetail(updated);
  }

  /** Explicit, human-triggered handoff (the "handoff" route). Internal AI-initiated handoffs (low
   *  confidence, AI-call failure) go through setModeInternal below instead, with source SYSTEM. */
  async handoffToHuman(user: AuthUser, leadId: string): Promise<ConversationDetail> {
    const row = await this.getRowOrThrow(leadId);
    await this.assertAccess(user, leadId, row);
    const updated = await this.db.whatsAppConversation.update({ where: { leadId }, data: { mode: "HUMAN", lastAiHandoffReason: null }, select: CONVERSATION_SELECT });
    await this.db.activity.create({
      data: { leadId, actorId: user.id, actorRole: user.role, type: ActivityType.CONVERSATION_AI_HANDOFF, referenceType: REFERENCE_TYPE, referenceId: row.id, source: ActivitySource.USER, title: "WhatsApp conversation handed off to a human" },
    });
    return this.toDetail(updated);
  }

  async returnToAi(user: AuthUser, leadId: string): Promise<ConversationDetail> {
    const row = await this.getRowOrThrow(leadId);
    await this.assertAccess(user, leadId, row);
    if (!row.assignedToId) throw new ApiError("Assign this conversation to a salesperson before enabling AI mode - the AI acts on their behalf when it creates an order", STATUS_CODES.BAD_REQUEST);
    const updated = await this.db.whatsAppConversation.update({ where: { leadId }, data: { mode: "AI" }, select: CONVERSATION_SELECT });
    await this.db.activity.create({
      data: { leadId, actorId: user.id, actorRole: user.role, type: ActivityType.CONVERSATION_HUMAN_HANDBACK, referenceType: REFERENCE_TYPE, referenceId: row.id, source: ActivitySource.USER, title: "WhatsApp conversation returned to AI" },
    });
    return this.toDetail(updated);
  }

  /** System-triggered mode change (AI handing off to a human on its own - low confidence, explicit
   *  "talk to a human", unsupported request, or an AI-call failure). No RBAC - called only from
   *  whatsapp.order-conversation.service.ts, never reachable from a route. */
  async setModeInternal(leadId: string, mode: ConversationMode, reason: string | null): Promise<void> {
    const row = await this.db.whatsAppConversation.findUnique({ where: { leadId }, select: { id: true } });
    if (!row) return;
    await this.db.whatsAppConversation.update({ where: { leadId }, data: { mode, lastAiHandoffReason: mode === "HUMAN" ? reason : null } });
    await this.db.activity.create({
      data: { leadId, type: ActivityType.CONVERSATION_AI_HANDOFF, referenceType: REFERENCE_TYPE, referenceId: row.id, source: ActivitySource.SYSTEM, title: "AI handed off to a human", description: reason },
    });
  }
}

export default WhatsAppConversationService;
