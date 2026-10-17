import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebsiteChatWebhookService } from "./website-chat.service.js";
import { createPrismaWebChatEventStore } from "./website-chat.store.js";
import { inboundCustomerMessage } from "./website-chat.testkit.js";

// An in-memory stand-in for the Prisma calls the REAL website-chat store and LeadService make. It applies the
// `where` those calls build (mobile candidates, email, source, workingStatus), so a missing or wrong guard
// shows up as a deactivated lead being selected or updated.
interface LeadRow { id: string; normalizedMobile: string | null; normalizedEmail: string | null; sourceId: string | null; workingStatus: string; firstName: string; ownerId: string | null; createdAt: number }
interface ConversationRow { id: string; externalConversationId: string; leadId: string | null; mode: string; intent: string | null; productInterest: string | null }

const statusOk = (row: LeadRow, filter: unknown) => (filter as { not?: string } | undefined)?.not === undefined || row.workingStatus !== (filter as { not: string }).not;

function makeDb(leads: LeadRow[], conversations: ConversationRow[] = []) {
  const leadUpdates: string[] = [];
  const createdLeads: LeadRow[] = [];
  const messages: { conversationId: string; body: string }[] = [];
  const db = {
    async $executeRaw() { return 1; },
    lead: {
      async findMany({ where, take }: any) {
        return leads
          .filter((l) => where.normalizedMobile.in.includes(l.normalizedMobile) && statusOk(l, where.workingStatus))
          .slice(0, take ?? leads.length)
          .map((l) => ({ id: l.id, ownerId: l.ownerId }));
      },
      async findFirst({ where }: any) {
        const any = where.OR as { normalizedMobile?: string; normalizedEmail?: string }[];
        return leads.find((l) => l.sourceId === where.sourceId && statusOk(l, where.workingStatus)
          && any.some((c) => (c.normalizedMobile && c.normalizedMobile === l.normalizedMobile) || (c.normalizedEmail && c.normalizedEmail === l.normalizedEmail))) ?? null;
      },
      async update({ where }: any) {
        leadUpdates.push(where.id);
        return leads.find((l) => l.id === where.id);
      },
      async create({ data }: any) {
        const row: LeadRow = { id: `new-${createdLeads.length + 1}`, normalizedMobile: data.normalizedMobile ?? null, normalizedEmail: data.normalizedEmail ?? null, sourceId: data.sourceId, workingStatus: "NEW", firstName: data.firstName, ownerId: null, createdAt: 99 };
        createdLeads.push(row);
        leads.push(row);
        return row;
      },
    },
    source: { async upsert() { return { id: "chat-source" }; } },
    activity: { async create() { return {}; } },
    webChatConversation: {
      async findUnique({ where }: any) { return conversations.find((c) => c.externalConversationId === where.externalConversationId) ?? null; },
      async create({ data }: any) {
        const row: ConversationRow = { id: `conv-${conversations.length + 1}`, externalConversationId: data.externalConversationId, leadId: null, mode: data.mode, intent: null, productInterest: null };
        conversations.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const row = conversations.find((c) => c.id === where.id)!;
        if (data.leadId !== undefined) row.leadId = data.leadId;
        return row;
      },
    },
    webChatMessage: {
      async findUnique() { return null; },
      async create({ data }: any) { messages.push({ conversationId: data.conversationId, body: data.body }); return { id: `m-${messages.length}` }; },
    },
  };
  const store = createPrismaWebChatEventStore({ $transaction: (fn: (tx: unknown) => unknown) => fn(db) } as never);
  return { db, store, leadUpdates, createdLeads, messages, conversations, leads };
}

const lead = (over: Partial<LeadRow> & { id: string }): LeadRow => ({ normalizedMobile: "+919876543210", normalizedEmail: null, sourceId: "chat-source", workingStatus: "NEW", firstName: "Asha", ownerId: null, createdAt: 1, ...over });
const CANDIDATES = ["+919876543210", "919876543210", "9876543210", "09876543210"];

describe("website chat phone matching skips deactivated leads", () => {
  it("never matches a deactivated lead that is the only one with the number", async () => {
    const { store } = makeDb([lead({ id: "TEST", workingStatus: "DEACTIVATED" })]);
    assert.deepEqual(await store.transaction((tx) => tx.findLeadsByNormalizedMobile(CANDIDATES)), []);
  });

  it("a deactivated lead no longer turns a single active match into an ambiguous (2-match) one", async () => {
    const { store } = makeDb([lead({ id: "TEST", workingStatus: "DEACTIVATED" }), lead({ id: "LIVE", createdAt: 20 })]);
    const found = await store.transaction((tx) => tx.findLeadsByNormalizedMobile(CANDIDATES));
    assert.deepEqual(found.map((l) => l.id), ["LIVE"]);
  });

  it("two ACTIVE leads with the number are still ambiguous (existing behaviour kept)", async () => {
    const { store } = makeDb([lead({ id: "A" }), lead({ id: "B", createdAt: 2 })]);
    assert.equal((await store.transaction((tx) => tx.findLeadsByNormalizedMobile(CANDIDATES))).length, 2);
  });

  it("end to end: a chat visitor whose number belongs only to a deactivated lead gets a new lead, the deactivated one is untouched", async () => {
    const { store, createdLeads, leadUpdates, conversations } = makeDb([lead({ id: "TEST", workingStatus: "DEACTIVATED" })]);
    const service = createWebsiteChatWebhookService(store);
    const result = await service.processWebhook(inboundCustomerMessage({ customer: { name: "Asha", mobile: "+91 98765 43210" } }));
    assert.equal(result.outcome, "PROCESSED");
    assert.equal(createdLeads.length, 1);
    assert.notEqual(conversations[0]!.leadId, "TEST");
    assert.deepEqual(leadUpdates, []);
  });
});

describe("website chat email-only identity skips deactivated leads", () => {
  const identity = { name: "Asha", email: "asha@example.com" };

  it("does not reuse or update a deactivated same-source lead with that email - a new lead is created instead", async () => {
    const { store, createdLeads, leadUpdates } = makeDb([lead({ id: "TEST", normalizedMobile: null, normalizedEmail: "asha@example.com", workingStatus: "DEACTIVATED" })]);
    const created = await store.transaction((tx) => tx.createLeadForWebChat(identity));
    assert.equal(createdLeads.length, 1);
    assert.notEqual(created?.id, "TEST");
    assert.deepEqual(leadUpdates, []);
  });

  it("still reuses an ACTIVE same-source lead with that email (no duplicate)", async () => {
    const { store, createdLeads, leadUpdates } = makeDb([lead({ id: "LIVE", normalizedMobile: null, normalizedEmail: "asha@example.com" })]);
    const created = await store.transaction((tx) => tx.createLeadForWebChat(identity));
    assert.equal(created?.id, "LIVE");
    assert.equal(createdLeads.length, 0);
    assert.deepEqual(leadUpdates, ["LIVE"]);
  });
});

describe("website chat existing conversations are preserved", () => {
  // Pinned on purpose: deactivation hides a lead from active workflows, it does not rewrite history. A
  // conversation that is already linked keeps its lead and keeps receiving messages; nothing re-matches it.
  const linked: ConversationRow = { id: "conv-1", externalConversationId: "ext-1", leadId: "TEST", mode: "AI", intent: null, productInterest: null };

  it("a conversation already linked to a deactivated lead stays linked and keeps appending messages", async () => {
    const { store, conversations, messages, createdLeads, leadUpdates } = makeDb([lead({ id: "TEST", workingStatus: "DEACTIVATED" })], [{ ...linked }]);
    const service = createWebsiteChatWebhookService(store);

    const result = await service.processWebhook(inboundCustomerMessage({ externalConversationId: "ext-1", externalMessageId: "m-new", text: "hello again" }));

    assert.equal(result.outcome, "PROCESSED");
    assert.equal(conversations.length, 1, "no second conversation");
    assert.equal(conversations[0]!.leadId, "TEST", "the link to the deactivated lead is not rewritten");
    assert.deepEqual(messages.map((m) => m.body), ["hello again"]);
    assert.equal(createdLeads.length, 0);
    assert.deepEqual(leadUpdates, []);
  });

  it("identity supplied on an already-linked conversation does not re-match it to another lead", async () => {
    const { store, conversations, createdLeads } = makeDb([lead({ id: "TEST", workingStatus: "DEACTIVATED" }), lead({ id: "LIVE", createdAt: 20 })], [{ ...linked }]);
    const service = createWebsiteChatWebhookService(store);

    await service.processWebhook(inboundCustomerMessage({ externalConversationId: "ext-1", externalMessageId: "m-2", customer: { mobile: "9876543210" } }));

    assert.equal(conversations[0]!.leadId, "TEST");
    assert.equal(createdLeads.length, 0);
  });
});
