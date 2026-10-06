import { z } from "zod";
import { ConversationMode, WebChatSender } from "@root/generated/prisma/enums.js";
import { logger } from "@/utils/logger.js";
import { buildMobileLookupCandidates } from "@/utils/phone.js";
import type { WebChatEventStore, WebChatEventTx } from "./website-chat.store.js";

/**
 * Website Chat webhook processing - the chatbot (a separate application, Aayush-AI-Commerce) posts
 * here after every message. Same architecture as webhooks/callerdesk: a persistence port
 * (WebChatEventTx) the service only talks to, an advisory lock per conversation, idempotent on
 * (conversationId, externalMessageId).
 *
 * IDEMPOTENCY
 *  - A delivery with an externalMessageId is deduped by (conversationId, externalMessageId); a
 *    repeat is answered as DUPLICATE and does nothing else.
 *  - A delivery with no externalMessageId cannot be deduped (nothing stable to key on) and is
 *    always stored - same accepted limitation as callerdesk.service.ts's null dedupeKey case.
 *  - All work for one conversation runs under a Postgres transaction-scoped advisory lock keyed by
 *    externalConversationId, so concurrent deliveries for the same conversation cannot race.
 *
 * LEAD MATCHING (only when `customer.mobile` or `customer.email` is supplied)
 *  - Global, source-agnostic match by normalized mobile first (findLeadsByNormalizedMobile) -
 *    never a source-scoped check alone, so a visitor who already has a Lead from another channel
 *    (WhatsApp, IVR, Shopify...) is reused, never duplicated.
 *  - 2+ matches = ambiguous: the conversation's leadId is left as-is (never guessed).
 *  - 0 matches = a new, unassigned Lead is created (source "Website Chat").
 *  - An anonymous visitor who never supplies identity never gets a Lead - the conversation simply
 *    stays leadId: null, exactly as the approved architecture requires.
 *
 * MODE
 *  - A conversation is created with mode = AI and is NEVER auto-switched to HUMAN by this service,
 *    no matter how many messages arrive. Handoff is an explicit, separate CRM action
 *    (webchat.service.ts#handoff), not an inbound-message side effect.
 */

export type WebChatWebhookOutcome = "INVALID" | "DUPLICATE" | "PROCESSED";

export type WebChatWebhookResult =
  | { outcome: "INVALID"; reason: string }
  | { outcome: "DUPLICATE"; conversationId: string }
  | {
      outcome: "PROCESSED";
      conversationId: string;
      messageId: string;
      conversationCreated: boolean;
      leadId: string | null;
      leadCreated: boolean;
      handoffAccepted: boolean;
    };

const identitySchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    mobile: z.string().trim().min(1).max(30).optional(),
    email: z.string().trim().email().max(255).optional(),
  })
  .optional();

const eventSchema = z.object({
  externalConversationId: z.string().trim().min(1).max(100),
  externalMessageId: z.string().trim().min(1).max(100).nullish(),
  sender: z.enum(["customer", "ai"]),
  text: z.string().trim().min(1).max(4000),
  timestamp: z.string().trim().min(1),
  customer: identitySchema,
  intent: z.string().trim().max(255).optional(),
  productInterest: z.string().trim().max(255).optional(),
  // Optional. Only the literal boolean true requests handoff; zod rejects any other type (e.g. "true").
  handoff: z.boolean().optional(),
});

type WebChatEvent = z.infer<typeof eventSchema>;

function senderFromEvent(sender: WebChatEvent["sender"]): WebChatSender {
  return sender === "customer" ? WebChatSender.CUSTOMER : WebChatSender.AI;
}

/** Make attacker-controlled strings safe and bounded for log lines - same helper shape as
 * callerdesk.service.ts#logToken, duplicated rather than imported across modules on purpose (this
 * module must stay independently testable/deployable from the telephony webhook). */
function logToken(value: string | null | undefined, max = 60): string {
  if (!value) return "none";
  return value.replace(/[^\w.\-|:() ]/g, "?").slice(0, max);
}

export function createWebsiteChatWebhookService(store: WebChatEventStore) {
  async function handle(tx: WebChatEventTx, event: WebChatEvent): Promise<WebChatWebhookResult> {
    await tx.lockConversation(`webchat:${event.externalConversationId}`);

    let conversation = await tx.findConversationByExternalId(event.externalConversationId);
    const conversationCreated = !conversation;
    if (!conversation) {
      conversation = await tx.createConversation(event.externalConversationId);
    }

    if (event.externalMessageId) {
      const existing = await tx.findMessageByExternalId(conversation.id, event.externalMessageId);
      if (existing) {
        return { outcome: "DUPLICATE", conversationId: conversation.id };
      }
    }

    let leadId = conversation.leadId;
    let leadCreated = false;

    if (!leadId && (event.customer?.mobile || event.customer?.email)) {
      const candidates = event.customer.mobile ? buildMobileLookupCandidates(event.customer.mobile) : [];
      const matches = candidates.length > 0 ? await tx.findLeadsByNormalizedMobile(candidates) : [];

      if (matches.length === 1) {
        leadId = matches[0]!.id;
      } else if (matches.length === 0) {
        const created = await tx.createLeadForWebChat(event.customer);
        if (created) {
          leadId = created.id;
          leadCreated = true;
        }
      }
      // matches.length > 1 (ambiguous) -> leadId stays null, never guessed.
    }

    // Handoff is applied only on a first-time delivery (a DUPLICATE returned above changes nothing),
    // so a retried or stale handoff can never flip a conversation back to HUMAN after an agent
    // has already returned it to AI. Setting HUMAN is never an archive or a data change.
    const handoffAccepted = event.handoff === true;

    await tx.updateConversation(conversation.id, {
      ...(leadId && leadId !== conversation.leadId ? { leadId } : {}),
      ...(event.intent !== undefined ? { intent: event.intent } : {}),
      ...(event.productInterest !== undefined ? { productInterest: event.productInterest } : {}),
      ...(handoffAccepted ? { mode: ConversationMode.HUMAN } : {}),
      lastMessageAt: new Date(event.timestamp),
    });

    const message = await tx.createMessage({
      conversationId: conversation.id,
      externalMessageId: event.externalMessageId ?? null,
      sender: senderFromEvent(event.sender),
      body: event.text,
      metadata: null,
    });

    return {
      outcome: "PROCESSED",
      conversationId: conversation.id,
      messageId: message.id,
      conversationCreated,
      leadId,
      leadCreated,
      handoffAccepted,
    };
  }

  async function processWebhook(body: unknown): Promise<WebChatWebhookResult> {
    const parsed = eventSchema.safeParse(body);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "invalid payload";
      logger.warn(`Website Chat webhook rejected: category=INVALID_PAYLOAD reason="${logToken(reason, 120)}"`);
      return { outcome: "INVALID", reason };
    }

    const event = parsed.data;

    try {
      const result = await store.transaction((tx) => handle(tx, event));

      logger.info(
        `Website Chat webhook: conversation=${logToken(event.externalConversationId)} result=${result.outcome}` +
          (result.outcome === "PROCESSED"
            ? ` conversationCreated=${result.conversationCreated} lead=${result.leadCreated ? "CREATED" : result.leadId ? "FOUND" : "NONE"} leadId=${result.leadId ?? "none"} messageId=${result.messageId} handoff=${result.handoffAccepted}`
            : ""),
      );

      return result;
    } catch (err) {
      const category = err instanceof Error ? err.name : "UnknownError";
      logger.error(`Website Chat webhook: conversation=${logToken(event.externalConversationId)} result=FAILED category=${logToken(category, 40)}`);
      throw err;
    }
  }

  return { processWebhook };
}

export type WebsiteChatWebhookService = ReturnType<typeof createWebsiteChatWebhookService>;
