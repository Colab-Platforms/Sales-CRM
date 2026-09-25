// Database integration tests for provider-aware template sending. Run with: npm run test:db
//
// A signed-in user's template send goes through the provider the lead's WhatsApp conversation is on (Meta -> the active
// Meta config; AiSensy/Gupshup -> the legacy env provider), never overridden by the global WHATSAPP_PROVIDER. System
// senders (automation/campaigns) keep the legacy provider. Every test runs in ONE transaction that is always rolled back.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma, WhatsAppProviderName } from "../../../generated/prisma/client.js";
import { ApiError } from "@/utils/apiError.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import WhatsAppTemplateService from "./whatsapp.template.service.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const TOKEN = "EAA-super-secret-access-token";

async function setup(tx: Prisma.TransactionClient, opts: { conversationProvider?: WhatsAppProviderName | null; historyProvider?: WhatsAppProviderName | null; templateProvider: WhatsAppProviderName; templateStatus?: WhatsAppTemplateStatus; language?: string; providerTemplateId?: string }) {
  const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210" }, select: { id: true } });
  if (opts.conversationProvider) await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: opts.conversationProvider } });
  if (opts.historyProvider) {
    await tx.whatsAppMessage.create({ data: { provider: opts.historyProvider, providerMessageId: `h-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId: lead.id, fromNumber: "919876543210", normalizedContact: "+919876543210", body: "hi" } });
  }
  const template = await tx.whatsAppTemplate.create({
    data: { name: `tpl_${uid()}`, provider: opts.templateProvider, providerTemplateId: opts.providerTemplateId, language: opts.language ?? "en", body: "Hi {{customer_name}}", variables: ["customer_name"], status: opts.templateStatus ?? WhatsAppTemplateStatus.APPROVED },
    select: { id: true, name: true },
  });
  return { user: { id: admin.id, email: admin.email, role: Role.ADMIN }, lead, template };
}

/** A provider stub recording every template send it receives. */
function recordingProvider(id: WhatsAppProvider["id"], overrides: Partial<WhatsAppProvider> = {}) {
  const calls: any[] = [];
  const provider: WhatsAppProvider = {
    id,
    sendTemplateMessage: async (input) => { calls.push(input); return { providerMessageId: `${id.toLowerCase()}-msg-${uid()}`, raw: {} }; },
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "n/a" }),
    ...overrides,
  };
  return { provider, calls };
}

const service = (tx: Prisma.TransactionClient, legacy: WhatsAppProvider | null, meta: WhatsAppProvider | null) =>
  new WhatsAppMessagingService(tx, () => legacy, async () => meta);

describe("template send routing by conversation provider", () => {
  it("META conversation: sends through Meta (not the legacy AiSensy), persists a META outbound message with its wamid and recipient, with the template's language", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "META", language: "en_US" });
      const legacy = recordingProvider("AISENSY");
      const meta = recordingProvider("META");

      const result = await service(tx, legacy.provider, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id });

      assert.equal(legacy.calls.length, 0, "a Meta conversation must never send a template through AiSensy");
      assert.equal(meta.calls.length, 1);
      assert.equal(meta.calls[0].to, "+919876543210");
      assert.equal(meta.calls[0].templateName, template.name);
      assert.equal(meta.calls[0].languageCode, "en_US");
      assert.deepEqual(meta.calls[0].params, ["Mahadev Babar"]);

      assert.equal(result.provider, "META");
      assert.equal(result.direction, "OUTBOUND");
      assert.equal(result.messageType, "TEMPLATE");
      assert.equal(result.status, "SENT");
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: result.id }, select: { provider: true, providerMessageId: true, toNumber: true, normalizedContact: true, sentById: true } });
      assert.equal(stored.provider, "META");
      assert.match(stored.providerMessageId ?? "", /^meta-msg-/);
      assert.equal(stored.toNumber, "+919876543210");
      assert.equal(stored.sentById, user.id);
    });
  });

  it("regression: a Meta-synced template (providerTemplateId = Meta's numeric template id) is sent by its NAME, not that id - live-exposed bug (sending the id 404s against Meta)", async () => {
    await inRollback(async (tx) => {
      const numericId = `13${Math.floor(Math.random() * 1e12)}`; // shaped like a real Meta template id, unique per run
      const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "META", providerTemplateId: numericId });
      const meta = recordingProvider("META");
      await service(tx, null, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id });
      assert.equal(meta.calls[0].templateName, template.name);
      assert.notEqual(meta.calls[0].templateName, numericId);
    });
  });

  it("AiSensy still sends by providerTemplateId (its campaign identifier) when one is set - unchanged", async () => {
    await inRollback(async (tx) => {
      const campaignId = `aisensy-campaign-${uid()}`;
      const { user, lead, template } = await setup(tx, { conversationProvider: "AISENSY", templateProvider: "AISENSY", providerTemplateId: campaignId });
      const legacy = recordingProvider("AISENSY");
      await service(tx, legacy.provider, null).sendTemplate(user, { leadId: lead.id, templateId: template.id });
      assert.equal(legacy.calls[0].templateName, campaignId);
    });
  });

  it("META conversation works even when the global provider is AiSensy, Gupshup, or unset", async () => {
    for (const legacyId of ["AISENSY", "GUPSHUP", null] as const) {
      await inRollback(async (tx) => {
        const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "META" });
        const legacy = legacyId ? recordingProvider(legacyId) : null;
        const meta = recordingProvider("META");
        const result = await service(tx, legacy?.provider ?? null, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id });
        assert.equal(result.provider, "META");
        assert.equal(legacy?.calls.length ?? 0, 0);
      });
    }
  });

  it("AISENSY conversation: keeps using AiSensy; Meta is never touched", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "AISENSY", templateProvider: "AISENSY" });
      const legacy = recordingProvider("AISENSY");
      const meta = recordingProvider("META");
      const result = await service(tx, legacy.provider, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id });
      assert.equal(result.provider, "AISENSY");
      assert.equal(legacy.calls.length, 1);
      assert.equal(legacy.calls[0].languageCode, undefined, "AiSensy's payload is unchanged - no Meta-only field is added");
      assert.equal(meta.calls.length, 0);
    });
  });

  it("GUPSHUP conversation: keeps using Gupshup; Meta is never touched", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "GUPSHUP", templateProvider: "GUPSHUP" });
      const legacy = recordingProvider("GUPSHUP");
      const meta = recordingProvider("META");
      const result = await service(tx, legacy.provider, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id });
      assert.equal(result.provider, "GUPSHUP");
      assert.equal(legacy.calls.length, 1);
      assert.equal(meta.calls.length, 0);
    });
  });

  it("a lead with pre-conversation-model AiSensy history is routed by that history, not the global setting", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { historyProvider: "GUPSHUP", templateProvider: "AISENSY" });
      const legacy = recordingProvider("AISENSY"); // the global provider is AiSensy, but this customer is on Gupshup
      await assert.rejects(
        () => service(tx, legacy.provider, null).sendTemplate(user, { leadId: lead.id, templateId: template.id }),
        (e: unknown) => e instanceof ApiError && e.statusCode === 400 && /Gupshup/.test(e.message),
      );
      assert.equal(legacy.calls.length, 0, "never silently re-routed through the other legacy provider");
    });
  });

  it("META conversation + an AiSensy template: refused with a clear message; nothing is sent by anyone", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "AISENSY" });
      const legacy = recordingProvider("AISENSY");
      const meta = recordingProvider("META");
      await assert.rejects(
        () => service(tx, legacy.provider, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id }),
        (e: unknown) => e instanceof ApiError && e.statusCode === 400 && /belongs to AISENSY/.test(e.message) && /Meta Cloud API template/.test(e.message),
      );
      assert.equal(legacy.calls.length + meta.calls.length, 0);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id, direction: "OUTBOUND" } }), 0);
    });
  });

  it("META conversation but Meta is not configured: clear 503, and it does NOT fall back to AiSensy", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "META" });
      const legacy = recordingProvider("AISENSY");
      await assert.rejects(
        () => service(tx, legacy.provider, null).sendTemplate(user, { leadId: lead.id, templateId: template.id }),
        (e: unknown) => e instanceof ApiError && e.statusCode === 503 && /Meta WhatsApp Cloud API is not configured/.test(e.message),
      );
      assert.equal(legacy.calls.length, 0);
    });
  });

  it("a Meta template that is not APPROVED is refused with a clear reason", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "META", templateStatus: WhatsAppTemplateStatus.PENDING });
      const meta = recordingProvider("META");
      await assert.rejects(
        () => service(tx, null, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id }),
        (e: unknown) => e instanceof ApiError && e.statusCode === 400 && /pending provider approval/.test(e.message),
      );
      assert.equal(meta.calls.length, 0);
    });
  });

  it("a lead with no WhatsApp history keeps the existing behavior (legacy provider), and uses Meta only when no legacy provider is configured", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { templateProvider: "AISENSY" });
      const legacy = recordingProvider("AISENSY");
      const meta = recordingProvider("META");
      assert.equal((await service(tx, legacy.provider, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id })).provider, "AISENSY");
    });
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { templateProvider: "META" });
      const meta = recordingProvider("META");
      assert.equal((await service(tx, null, meta.provider).sendTemplate(user, { leadId: lead.id, templateId: template.id })).provider, "META");
    });
  });

  it("system senders (automation/campaigns) are unchanged: legacy provider, even for a lead whose conversation is on Meta", async () => {
    await inRollback(async (tx) => {
      const { lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "AISENSY" });
      const legacy = recordingProvider("AISENSY");
      const meta = recordingProvider("META");
      const result = await service(tx, legacy.provider, meta.provider).sendTemplateAsSystem({ leadId: lead.id, templateId: template.id });
      assert.equal(result.provider, "AISENSY");
      assert.equal(meta.calls.length, 0);
    });
  });

  it("describeTemplateProvider reports the provider a send would use, or why it cannot be sent (never throws for config problems)", async () => {
    await inRollback(async (tx) => {
      const { user, lead } = await setup(tx, { conversationProvider: "META", templateProvider: "META" });
      const ok = await service(tx, null, recordingProvider("META").provider).describeTemplateProvider(user, lead.id);
      assert.deepEqual(ok, { provider: "META", message: null });
      const blocked = await service(tx, null, null).describeTemplateProvider(user, lead.id);
      assert.equal(blocked.provider, null);
      assert.match(blocked.message ?? "", /not configured/);
    });
  });
});

describe("Meta template send - real MetaCloudApiProvider over a fake network", () => {
  const creds = { phoneNumberId: "PHONE-123", businessAccountId: "WABA-1", accessToken: TOKEN, appSecret: "app-secret-xyz", verifyToken: "verify-xyz", graphApiVersion: "v21.0" };

  it("posts to the active config's Phone Number ID with its bearer token and the template's language, and stores the Meta message id", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "META", language: "hi" });
      const requests: { url: string; auth: string | null; body: any }[] = [];
      const fetchImpl = (async (url: string, init: any) => {
        requests.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.REAL-1" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await service(tx, null, new MetaCloudApiProvider(creds, { fetchImpl })).sendTemplate(user, { leadId: lead.id, templateId: template.id });

      assert.equal(requests.length, 1);
      const seen = requests[0]!;
      assert.match(seen.url, /\/PHONE-123\/messages$/);
      assert.equal(seen.auth, `Bearer ${TOKEN}`);
      assert.equal(seen.body.type, "template");
      assert.equal(seen.body.template.name, template.name);
      assert.equal(seen.body.template.language.code, "hi");
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: result.id }, select: { provider: true, providerMessageId: true, toNumber: true } });
      assert.deepEqual(stored, { provider: "META", providerMessageId: "wamid.REAL-1", toNumber: "+919876543210" });
    });
  });

  it("a Meta rejection is stored as FAILED, and neither the access token nor the app secret appears in the message, activity or error", async () => {
    await inRollback(async (tx) => {
      const { user, lead, template } = await setup(tx, { conversationProvider: "META", templateProvider: "META" });
      const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190 } }), { status: 401 })) as unknown as typeof fetch;

      const result = await service(tx, null, new MetaCloudApiProvider(creds, { fetchImpl })).sendTemplate(user, { leadId: lead.id, templateId: template.id });

      assert.equal(result.status, "FAILED");
      assert.equal(result.provider, "META");
      const row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: result.id }, select: { errorMessage: true, body: true } });
      const activity = await tx.activity.findMany({ where: { leadId: lead.id }, select: { description: true, title: true } });
      const everything = JSON.stringify({ result, row, activity });
      assert.equal(everything.includes(TOKEN), false, "access token must never be persisted or returned");
      assert.equal(everything.includes("app-secret-xyz"), false);
    });
  });
});

describe("Meta template sync", () => {
  it("syncs templates from the Meta config when asked (making them APPROVED and sendable); the default sync still uses the legacy provider", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const user = { id: admin.id, email: admin.email, role: Role.ADMIN };
      const name = `meta_tpl_${uid()}`;
      const metaProvider = recordingProvider("META", {
        listTemplates: async () => ({ supported: true, templates: [{ providerTemplateId: `mt-${uid()}`, externalId: "1", name, category: "UTILITY", language: "en_US", body: "Hi {{1}}", status: "APPROVED", quality: null }] }),
      }).provider;
      const legacy = recordingProvider("AISENSY", { listTemplates: async () => ({ supported: false, reason: "AiSensy has no list API" }) }).provider;
      const svc = new WhatsAppTemplateService(tx, () => legacy, async () => metaProvider);

      const metaSummary = await svc.syncTemplates(user, "META");
      assert.equal(metaSummary.provider, "META");
      assert.equal(metaSummary.created, 1);
      const row = await tx.whatsAppTemplate.findFirstOrThrow({ where: { name, provider: "META" }, select: { status: true, language: true } });
      assert.deepEqual(row, { status: "APPROVED", language: "en_US" });

      const legacySummary = await svc.syncTemplates(user);
      assert.equal(legacySummary.provider, "AISENSY");
      assert.equal(legacySummary.supported, false);

      await assert.rejects(() => new WhatsAppTemplateService(tx, () => legacy, async () => null).syncTemplates(user, "META"), (e: unknown) => e instanceof ApiError && e.statusCode === 503 && /Meta WhatsApp Cloud API is not configured/.test(e.message));
    });
  });
});
