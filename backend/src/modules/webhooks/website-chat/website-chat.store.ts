import type { Prisma } from "@root/generated/prisma/client.js";
import { ConversationMode, SourceStatus, SourceType, WebChatSender } from "@root/generated/prisma/enums.js";
import type { prisma as PrismaSingleton } from "@/lib/prisma.js";
import { normalizeMobile } from "@/utils/normalize.js";
import LeadService from "../../lead/lead.service.js";

/**
 * Persistence port for the Website Chat webhook service - same shape as
 * webhooks/callerdesk/callerdesk.store.ts (CallEventTx/CallEventStore), so the service can be
 * unit-tested with an in-memory fake and never touch the live database in tests.
 */

export interface StoredConversation {
  id: string;
  externalConversationId: string;
  leadId: string | null;
  mode: ConversationMode;
  intent: string | null;
  productInterest: string | null;
}

export interface ConversationPatch {
  leadId?: string;
  intent?: string;
  productInterest?: string;
  mode?: ConversationMode;
  lastMessageAt: Date;
}

export interface NewMessage {
  conversationId: string;
  externalMessageId: string | null;
  sender: WebChatSender;
  body: string;
  metadata: Record<string, unknown> | null;
}

export interface CustomerIdentity {
  name?: string;
  mobile?: string;
  email?: string;
}

export interface CreatedWebChatLead {
  id: string;
  ownerId: string | null;
}

export interface CandidateWebChatLead {
  id: string;
  ownerId: string | null;
}

export interface WebChatEventTx {
  /** Serialises all processing for one chatbot conversation across requests/instances. */
  lockConversation(key: string): Promise<void>;

  findConversationByExternalId(externalConversationId: string): Promise<StoredConversation | null>;
  createConversation(externalConversationId: string): Promise<StoredConversation>;
  updateConversation(id: string, patch: ConversationPatch): Promise<StoredConversation>;

  /** Idempotency: null externalMessageId is never looked up (nothing stable to dedupe on) - every
   * such delivery is simply stored, mirroring callerdesk.service.ts's own null-dedupeKey behaviour. */
  findMessageByExternalId(conversationId: string, externalMessageId: string): Promise<{ id: string } | null>;
  createMessage(data: NewMessage): Promise<{ id: string }>;

  /** At most 2 rows are needed: 0 = no match, 1 = match, 2 = ambiguous - same convention as
   * callerdesk.store.ts#findLeadsByNormalizedMobile (global, source-agnostic). */
  findLeadsByNormalizedMobile(candidates: string[]): Promise<CandidateWebChatLead[]>;

  /** Only called after findLeadsByNormalizedMobile already found zero matches. Creates (or reuses)
   * the "Website Chat" Source and a minimal, unassigned Lead - same pattern as
   * callerdesk.store.ts#createIvrLead. Returns null if no usable identity was supplied. */
  createLeadForWebChat(identity: CustomerIdentity): Promise<CreatedWebChatLead | null>;
}

export interface WebChatEventStore {
  transaction<T>(fn: (tx: WebChatEventTx) => Promise<T>): Promise<T>;
}

// "Website Chat" is the Source every web-chat-matched/created Lead is attached to. `type: API`
// reuses an existing SourceType enum value (an external system posting to our API), same reasoning
// as IVR Inquiry's Source - no new enum member, no migration for this part.
export const WEBSITE_CHAT_SOURCE_CODE = "website_chat";
export const WEBSITE_CHAT_SOURCE_NAME = "Website Chat";

const leadService = new LeadService();

type Db = Prisma.TransactionClient;

function asStoredConversation(row: {
  id: string;
  externalConversationId: string;
  leadId: string | null;
  mode: ConversationMode;
  intent: string | null;
  productInterest: string | null;
}): StoredConversation {
  return {
    id: row.id,
    externalConversationId: row.externalConversationId,
    leadId: row.leadId,
    mode: row.mode,
    intent: row.intent,
    productInterest: row.productInterest,
  };
}

function createTx(db: Db): WebChatEventTx {
  return {
    async lockConversation(key) {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    },

    async findConversationByExternalId(externalConversationId) {
      const row = await db.webChatConversation.findUnique({ where: { externalConversationId } });
      return row ? asStoredConversation(row) : null;
    },

    async createConversation(externalConversationId) {
      const row = await db.webChatConversation.create({
        data: { externalConversationId, mode: ConversationMode.AI },
      });
      return asStoredConversation(row);
    },

    async updateConversation(id, patch) {
      const row = await db.webChatConversation.update({
        where: { id },
        data: {
          ...(patch.leadId !== undefined ? { leadId: patch.leadId } : {}),
          ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
          ...(patch.productInterest !== undefined ? { productInterest: patch.productInterest } : {}),
          ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
          lastMessageAt: patch.lastMessageAt,
        },
      });
      return asStoredConversation(row);
    },

    async findMessageByExternalId(conversationId, externalMessageId) {
      return db.webChatMessage.findUnique({
        where: { conversationId_externalMessageId: { conversationId, externalMessageId } },
        select: { id: true },
      });
    },

    async createMessage(data) {
      return db.webChatMessage.create({
        data: {
          conversationId: data.conversationId,
          externalMessageId: data.externalMessageId,
          sender: data.sender,
          body: data.body,
          metadata: data.metadata as Prisma.InputJsonValue | undefined,
        },
        select: { id: true },
      });
    },

    async findLeadsByNormalizedMobile(candidates) {
      if (candidates.length === 0) return [];
      return db.lead.findMany({
        where: { normalizedMobile: { in: candidates } },
        select: { id: true, ownerId: true },
        take: 2,
      });
    },

    async createLeadForWebChat(identity) {
      const normalizedMobile = identity.mobile ? normalizeMobile(identity.mobile) : null;
      if (!normalizedMobile && !identity.email) return null;

      const source = await db.source.upsert({
        where: { code: WEBSITE_CHAT_SOURCE_CODE },
        update: {},
        create: {
          name: WEBSITE_CHAT_SOURCE_NAME,
          code: WEBSITE_CHAT_SOURCE_CODE,
          type: SourceType.API,
          status: SourceStatus.ACTIVE,
        },
        select: { id: true },
      });

      const lead = await leadService.createLeadFromSource(
        source.id,
        { firstName: identity.name?.trim() || "Website Visitor", mobile: identity.mobile, email: identity.email },
        "Lead created via Website Chat",
        db,
      );

      return { id: lead.id, ownerId: lead.ownerId };
    },
  };
}

export function createPrismaWebChatEventStore(prisma: typeof PrismaSingleton): WebChatEventStore {
  return {
    transaction(fn) {
      return prisma.$transaction((tx) => fn(createTx(tx)));
    },
  };
}
