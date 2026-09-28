import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@/utils/apiError.js";
import type { DbClient } from "@/lib/leadScope.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";
import WhatsAppFreeTextService, { SERVICE_WINDOW_MS, computeServiceWindow } from "./whatsapp.freetext.service.js";
import type { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;

interface Msg { id: string; leadId: string; provider: string; direction: string; createdAt: Date; receivedAt: Date | null; [k: string]: unknown }

// In-memory stand-in for the delegates the services touch: whatsAppConversation, whatsAppMessage.
function fakeDb(seed: { conversations?: any[]; messages?: Partial<Msg>[] } = {}) {
  const conversations: any[] = seed.conversations ?? [];
  const messages: Msg[] = (seed.messages ?? []).map((m, i) => ({ id: `m${i}`, receivedAt: null, ...m }) as Msg);
  const db = {
    whatsAppConversation: {
      async findUnique({ where }: any) {
        const c = conversations.find((x) => x.leadId === where.leadId);
        return c ? { ...c, assignedTo: null } : null;
      },
      async create({ data }: any) {
        const c = { id: `c${conversations.length}`, mode: "HUMAN", assignedToId: null, lastReadAt: null, orderState: "DISCOVERY", orderDraft: null, aiSuggestedReply: null, lastAiHandoffReason: null, createdOrderId: null, ...data };
        conversations.push(c);
        return { ...c, assignedTo: null };
      },
      async update({ where, data }: any) {
        const c = conversations.find((x) => x.leadId === where.leadId);
        Object.assign(c, data);
        return { ...c, assignedTo: null };
      },
    },
    whatsAppMessage: {
      async findFirst({ where }: any) {
        const rows = messages
          .filter((m) => m.leadId === where.leadId && (!where.provider || m.provider === where.provider) && (!where.direction || m.direction === where.direction))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      },
      async create({ data }: any) {
        const row = { id: `m${messages.length}`, createdAt: NOW, receivedAt: null, ...data };
        messages.push(row);
        return { id: row.id };
      },
    },
  } as unknown as DbClient;
  return { db, conversations, messages };
}

function fakeMeta() {
  const sent: any[] = [];
  const meta = { async sendText(input: any) { sent.push(input); return { providerMessageId: "wamid.OUT1", raw: {} }; } } as unknown as MetaCloudApiProvider;
  return { meta, sent };
}

const lead = { id: "lead-1", normalizedMobile: "+919876543210" };
const service = (db: DbClient, meta: MetaCloudApiProvider | null) => new WhatsAppFreeTextService(db, async () => meta, () => NOW);

describe("computeServiceWindow", () => {
  it("is open for 24 hours after the last inbound message, closed after, and closed with no inbound at all", () => {
    assert.equal(computeServiceWindow(ago(23 * HOUR), NOW).open, true);
    assert.equal(computeServiceWindow(ago(25 * HOUR), NOW).open, false);
    assert.equal(computeServiceWindow(null, NOW).open, false);
    assert.equal(computeServiceWindow(ago(HOUR), NOW).expiresAt, new Date(ago(HOUR).getTime() + SERVICE_WINDOW_MS).toISOString());
  });
});

describe("Meta inbound message sets the conversation provider to META", () => {
  it("creates a META conversation on first contact, and flips an AiSensy conversation to META on a later Meta inbound", async () => {
    const { db, conversations } = fakeDb();
    const conversationService = new WhatsAppConversationService(db);
    const first = await conversationService.getOrCreateConversation("lead-1", "META");
    assert.equal(first.provider, "META");

    const second = fakeDb({ conversations: [{ id: "c0", leadId: "lead-1", provider: "AISENSY", mode: "HUMAN", assignedToId: null, lastReadAt: null, orderState: "DISCOVERY", orderDraft: null, aiSuggestedReply: null, lastAiHandoffReason: null, createdOrderId: null }] });
    const updated = await new WhatsAppConversationService(second.db).getOrCreateConversation("lead-1", "META");
    assert.equal(updated.provider, "META");
    assert.equal(second.conversations.length, 1);
    assert.equal(conversations.length, 1);
  });
});

describe("free-text send - META conversation", () => {
  it("INSIDE the service window: sends the text through Meta and persists an OUTBOUND META message", async () => {
    const { db, messages } = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "META" }],
      messages: [{ leadId: "lead-1", provider: "META", direction: "INBOUND", createdAt: ago(2 * HOUR), receivedAt: ago(2 * HOUR) }],
    });
    const { meta, sent } = fakeMeta();

    const result = await service(db, meta).sendText(lead, "Hello from the CRM", "user-1");

    assert.deepEqual(sent, [{ to: "+919876543210", body: "Hello from the CRM" }]);
    const out = messages.find((m) => m.id === result.id)!;
    assert.equal(out.provider, "META");
    assert.equal(out.direction, "OUTBOUND");
    assert.equal(out.providerMessageId, "wamid.OUT1");
  });

  it("OUTSIDE the window: refuses with a clear template-required message and sends nothing", async () => {
    const { db, messages } = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "META" }],
      messages: [{ leadId: "lead-1", provider: "META", direction: "INBOUND", createdAt: ago(30 * HOUR), receivedAt: ago(30 * HOUR) }],
    });
    const { meta, sent } = fakeMeta();

    await assert.rejects(
      () => service(db, meta).sendText(lead, "Too late", "user-1"),
      (err: unknown) => err instanceof ApiError && err.statusCode === 400 && /24-hour/.test(err.message) && /approved template/.test(err.message),
    );
    assert.equal(sent.length, 0);
    assert.equal(messages.filter((m) => m.direction === "OUTBOUND").length, 0);
  });

  it("a META conversation whose customer never messaged the Meta number has no window: template required", async () => {
    const { db } = fakeDb({ conversations: [{ leadId: "lead-1", provider: "META" }] });
    const { meta, sent } = fakeMeta();
    await assert.rejects(() => service(db, meta).sendText(lead, "hi", "user-1"), /not open/);
    assert.equal(sent.length, 0);
  });

  it("an AiSensy/Gupshup inbound opens NO Meta window, even if it is recent", async () => {
    const { db } = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "META" }],
      messages: [{ leadId: "lead-1", provider: "AISENSY", direction: "INBOUND", createdAt: ago(HOUR) }],
    });
    const { capability } = await service(db, fakeMeta().meta).getCapability("lead-1");
    assert.equal(capability.serviceWindow.open, false);
    assert.equal(capability.freeText.allowed, false);
  });

  it("refuses when Meta is not configured (or undecryptable), even inside the window", async () => {
    const { db } = fakeDb({
      conversations: [{ leadId: "lead-1", provider: "META" }],
      messages: [{ leadId: "lead-1", provider: "META", direction: "INBOUND", createdAt: ago(HOUR), receivedAt: ago(HOUR) }],
    });
    const { capability } = await service(db, null).getCapability("lead-1");
    assert.equal(capability.freeText.reason, "META_NOT_CONFIGURED");
  });
});

describe("free-text send - AiSensy / Gupshup conversations keep template-only behavior", () => {
  for (const [provider, label] of [["AISENSY", "AiSensy"], ["GUPSHUP", "Gupshup"]] as const) {
    it(`${label}: free text is refused (even with Meta configured and a Meta inbound within 24h), nothing is sent through Meta, provider stays ${provider}`, async () => {
      const { db } = fakeDb({
        conversations: [{ leadId: "lead-1", provider }],
        messages: [{ leadId: "lead-1", provider: "META", direction: "INBOUND", createdAt: ago(HOUR), receivedAt: ago(HOUR) }],
      });
      const { meta, sent } = fakeMeta();

      const { capability } = await service(db, meta).getCapability("lead-1");
      assert.equal(capability.activeProvider, provider);
      assert.equal(capability.activeProviderLabel, label);
      assert.equal(capability.freeText.reason, "PROVIDER_NOT_META");

      await assert.rejects(() => service(db, meta).sendText(lead, "hi", "user-1"), (err: unknown) => err instanceof ApiError && err.message.includes(label) && /templates/.test(err.message));
      assert.equal(sent.length, 0);
    });
  }
});

describe("active provider resolution", () => {
  it("a lead with pre-conversation-model history resolves to the provider of its latest message (not a global default)", async () => {
    const { db } = fakeDb({ messages: [{ leadId: "lead-1", provider: "AISENSY", direction: "OUTBOUND", createdAt: ago(5 * HOUR) }] });
    const { capability } = await service(db, fakeMeta().meta).getCapability("lead-1");
    assert.equal(capability.activeProvider, "AISENSY");
    assert.equal(capability.freeText.allowed, false);
  });

  it("a lead with no history in a Meta-configured workspace starts on META, with the window closed", async () => {
    const { db } = fakeDb();
    const { capability } = await service(db, fakeMeta().meta).getCapability("lead-1");
    assert.equal(capability.activeProvider, "META");
    assert.equal(capability.freeText.reason, "SERVICE_WINDOW_CLOSED");
  });

  it("with no history and Meta not configured, there is no active provider", async () => {
    const { db } = fakeDb();
    const { capability } = await service(db, null).getCapability("lead-1");
    assert.equal(capability.activeProvider, null);
  });

  it("never returns secrets in the capability payload", async () => {
    const { db } = fakeDb({ conversations: [{ leadId: "lead-1", provider: "META" }] });
    const { capability } = await service(db, fakeMeta().meta).getCapability("lead-1");
    assert.equal(/token|secret|key/i.test(JSON.stringify(capability)), false);
  });
});
