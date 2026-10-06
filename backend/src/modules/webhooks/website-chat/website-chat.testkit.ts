import { randomUUID } from "node:crypto";
import { ConversationMode, WebChatSender } from "@root/generated/prisma/enums.js";
import type {
  CandidateWebChatLead,
  CreatedWebChatLead,
  CustomerIdentity,
  NewMessage,
  StoredConversation,
  WebChatEventStore,
  WebChatEventTx,
} from "./website-chat.store.js";

/** In-memory WebChatEventStore for unit tests - no database, synthetic data only. Mirrors
 * webhooks/callerdesk/callerdesk.testkit.ts's shape/conventions exactly. */

interface FakeConversation extends StoredConversation {}

interface FakeMessage {
  id: string;
  conversationId: string;
  externalMessageId: string | null;
  sender: WebChatSender;
  body: string;
  metadata: Record<string, unknown> | null;
}

interface FakeLead extends CandidateWebChatLead {
  normalizedMobile: string;
}

interface State {
  conversations: FakeConversation[];
  messages: FakeMessage[];
  leads: FakeLead[];
}

export function createInMemoryWebChatEventStore() {
  const state: State = { conversations: [], messages: [], leads: [] };
  const lockKeys: string[] = [];

  const tx: WebChatEventTx = {
    async lockConversation(key) {
      lockKeys.push(key);
    },

    async findConversationByExternalId(externalConversationId) {
      return state.conversations.find((c) => c.externalConversationId === externalConversationId) ?? null;
    },

    async createConversation(externalConversationId) {
      const row: FakeConversation = {
        id: randomUUID(),
        externalConversationId,
        leadId: null,
        mode: ConversationMode.AI,
        intent: null,
        productInterest: null,
      };
      state.conversations.push(row);
      return { ...row };
    },

    async updateConversation(id, patch) {
      const row = state.conversations.find((c) => c.id === id);
      if (!row) throw new Error("conversation not found");
      if (patch.leadId !== undefined) row.leadId = patch.leadId;
      if (patch.intent !== undefined) row.intent = patch.intent;
      if (patch.productInterest !== undefined) row.productInterest = patch.productInterest;
      if (patch.mode !== undefined) row.mode = patch.mode;
      return { ...row };
    },

    async findMessageByExternalId(conversationId, externalMessageId) {
      const found = state.messages.find((m) => m.conversationId === conversationId && m.externalMessageId === externalMessageId);
      return found ? { id: found.id } : null;
    },

    async createMessage(data: NewMessage) {
      const row: FakeMessage = {
        id: randomUUID(),
        conversationId: data.conversationId,
        externalMessageId: data.externalMessageId,
        sender: data.sender,
        body: data.body,
        metadata: data.metadata,
      };
      state.messages.push(row);
      return { id: row.id };
    },

    async findLeadsByNormalizedMobile(candidates) {
      return state.leads
        .filter((l) => candidates.includes(l.normalizedMobile))
        .slice(0, 2)
        .map((l) => ({ id: l.id, ownerId: l.ownerId }));
    },

    async createLeadForWebChat(identity: CustomerIdentity): Promise<CreatedWebChatLead | null> {
      if (!identity.mobile && !identity.email) return null;
      const normalizedMobile = (identity.mobile ?? "").replace(/\D/g, "").slice(-10);
      const id = randomUUID();
      state.leads.push({ id, ownerId: null, normalizedMobile });
      return { id, ownerId: null };
    },
  };

  const store: WebChatEventStore = {
    async transaction(fn) {
      const snapshot = structuredClone(state);
      try {
        return await fn(tx);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    },
  };

  return {
    store,
    state,
    lockKeys,
    addLead(lead: { id?: string; normalizedMobile: string; ownerId?: string | null }): string {
      const id = lead.id ?? randomUUID();
      state.leads.push({ id, normalizedMobile: lead.normalizedMobile, ownerId: lead.ownerId ?? null });
      return id;
    },
    addConversation(conversation: Partial<FakeConversation> & { externalConversationId: string }): string {
      const id = conversation.id ?? randomUUID();
      state.conversations.push({
        id,
        externalConversationId: conversation.externalConversationId,
        leadId: conversation.leadId ?? null,
        mode: conversation.mode ?? ConversationMode.AI,
        intent: conversation.intent ?? null,
        productInterest: conversation.productInterest ?? null,
      });
      return id;
    },
  };
}

export type InMemoryWebChatEventStore = ReturnType<typeof createInMemoryWebChatEventStore>;

/** A minimal, valid webhook body for tests to override via `{...inboundCustomerMessage(), ...overrides}`. */
export function inboundCustomerMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalConversationId: "web-session-1",
    externalMessageId: "msg-1",
    sender: "customer",
    text: "Hi, do you have the immunity booster in stock?",
    timestamp: "2026-10-05T10:00:00.000Z",
    ...overrides,
  };
}
