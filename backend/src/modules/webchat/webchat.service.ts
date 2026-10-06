import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ActivityType, ConversationMode, Role, UserStatus, WebChatSender } from "../../../generated/prisma/enums.js";
import { buildWebChatListWhere, scopedWebChatWhere } from "./webchat.filters.js";
import { buildWebChatScope, canAssignConversationTo } from "./webchat.scope.js";
import type {
  ListWebChatConversationsQuery,
  WebChatConversationDetail,
  WebChatConversationListItem,
  WebChatConversationListResult,
} from "./webchat.types.js";

/**
 * Agent-facing Website Chat Live Queue service (`/api/webchat/*`).
 *
 * Authorisation: every read or action first resolves the conversation through buildWebChatScope,
 * so an out-of-scope id is indistinguishable from a missing one (404). Assignment targets follow
 * canAssignConversationTo. No second authorisation system.
 *
 * Activity: recorded only where an existing ActivityType fits - ASSIGNMENT for an assign, and only
 * when the conversation already has a Lead (Activity is Lead-centric). Handoff, AI-mode changes and
 * agent replies have NO matching ActivityType today; they are not recorded here and this gap is
 * reported rather than solved by adding enum values.
 *
 * Phase 2 boundary: sendAgentMessage stores the reply only. Delivering it to the chatbot is the
 * Phase 2 integration point marked inside that method - intentionally not implemented yet.
 */

const conversationInclude = {
  lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true, email: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

type ConversationRow = {
  id: string;
  externalConversationId: string;
  mode: ConversationMode;
  intent: string | null;
  productInterest: string | null;
  lastMessageAt: Date | null;
  lastReadAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  lead: { id: string; leadNumber: string; firstName: string; lastName: string | null; mobile: string | null; email: string | null } | null;
  assignedTo: { id: string; name: string } | null;
};

function mapListItem(row: ConversationRow): WebChatConversationListItem {
  return {
    id: row.id,
    externalConversationId: row.externalConversationId,
    lead: row.lead,
    assignedTo: row.assignedTo,
    mode: row.mode,
    intent: row.intent,
    productInterest: row.productInterest,
    lastMessageAt: row.lastMessageAt,
    lastReadAt: row.lastReadAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

export class WebChatService {
  constructor(private readonly db: DbClient = prisma) {}

  private async findScoped(user: AuthUser, id: string) {
    const scope = await buildWebChatScope(user, this.db);
    const row = await this.db.webChatConversation.findFirst({
      where: scopedWebChatWhere(id, scope),
      include: conversationInclude,
    });
    if (!row) throw new ApiError("Conversation not found", STATUS_CODES.NOT_FOUND);
    return row;
  }

  async listConversations(user: AuthUser, query: ListWebChatConversationsQuery): Promise<WebChatConversationListResult> {
    const scope = await buildWebChatScope(user, this.db);
    const where = buildWebChatListWhere(query, scope);

    const [total, rows] = await Promise.all([
      this.db.webChatConversation.count({ where }),
      this.db.webChatConversation.findMany({
        where,
        include: conversationInclude,
        orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);

    return {
      data: rows.map(mapListItem),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async getConversation(user: AuthUser, id: string): Promise<WebChatConversationDetail> {
    const row = await this.findScoped(user, id);
    const messages = await this.db.webChatMessage.findMany({
      where: { conversationId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        sender: true,
        body: true,
        createdAt: true,
        sentBy: { select: { id: true, name: true } },
      },
    });

    return {
      ...mapListItem(row),
      messages: messages.map((m) => ({ id: m.id, sender: m.sender, body: m.body, sentBy: m.sentBy, createdAt: m.createdAt })),
    };
  }

  async markRead(user: AuthUser, id: string): Promise<{ id: string; lastReadAt: Date }> {
    await this.findScoped(user, id);
    const lastReadAt = new Date();
    await this.db.webChatConversation.update({ where: { id }, data: { lastReadAt }, select: { id: true } });
    return { id, lastReadAt };
  }

  async assign(user: AuthUser, id: string, assignedToId: string): Promise<{ id: string; assignedTo: { id: string; name: string } }> {
    const row = await this.findScoped(user, id);

    if (!(await canAssignConversationTo(user, assignedToId, this.db))) {
      throw new ApiError("You cannot assign this conversation to that user", STATUS_CODES.FORBIDDEN);
    }

    const target = await this.db.user.findFirst({
      where: { id: assignedToId, status: UserStatus.ACTIVE, role: { in: [Role.SALESPERSON, Role.MANAGER] } },
      select: { id: true, name: true },
    });
    if (!target) throw new ApiError("Assignee must be an active salesperson or manager", STATUS_CODES.BAD_REQUEST);

    await this.db.webChatConversation.update({ where: { id }, data: { assignedToId }, select: { id: true } });

    if (row.leadId) {
      await this.db.activity.create({
        data: {
          leadId: row.leadId,
          actorId: user.id,
          actorRole: user.role,
          type: ActivityType.ASSIGNMENT,
          referenceType: "WebChatConversation",
          referenceId: id,
          title: `Website chat assigned to ${target.name}`,
        },
      });
    }

    return { id, assignedTo: target };
  }

  async handoff(user: AuthUser, id: string): Promise<{ id: string; mode: ConversationMode }> {
    await this.findScoped(user, id);
    await this.db.webChatConversation.update({ where: { id }, data: { mode: ConversationMode.HUMAN }, select: { id: true } });
    return { id, mode: ConversationMode.HUMAN };
  }

  async returnToAi(user: AuthUser, id: string): Promise<{ id: string; mode: ConversationMode }> {
    await this.findScoped(user, id);
    await this.db.webChatConversation.update({ where: { id }, data: { mode: ConversationMode.AI }, select: { id: true } });
    return { id, mode: ConversationMode.AI };
  }

  async archive(user: AuthUser, id: string): Promise<{ id: string; archivedAt: Date }> {
    await this.findScoped(user, id);
    const archivedAt = new Date();
    await this.db.webChatConversation.update({ where: { id }, data: { archivedAt }, select: { id: true } });
    return { id, archivedAt };
  }

  async sendAgentMessage(user: AuthUser, id: string, text: string): Promise<{ messageId: string; createdAt: Date }> {
    await this.findScoped(user, id);

    const message = await this.db.webChatMessage.create({
      data: {
        conversationId: id,
        sender: WebChatSender.AGENT,
        sentById: user.id,
        body: text,
      },
      select: { id: true, createdAt: true },
    });

    await this.db.webChatConversation.update({
      where: { id },
      data: { lastMessageAt: message.createdAt },
      select: { id: true },
    });

    // PHASE 2 BOUNDARY: deliver `text` to the chatbot backend here (CRM -> chatbot reply call using
    // its own shared secret). Intentionally not implemented in Phase 1 - the message is stored only.

    return { messageId: message.id, createdAt: message.createdAt };
  }
}

export const webChatService = new WebChatService();
