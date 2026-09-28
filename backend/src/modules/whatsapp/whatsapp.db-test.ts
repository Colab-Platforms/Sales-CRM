// Database integration tests for E7.1 WhatsApp. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back, so nothing is ever committed
// and it is safe to run against a shared/development database - mirrors customers.db-test.ts.
//
// Every Lead read/write here uses an explicit `select`, deliberately: the live dev database is
// currently missing two columns (`import_batch_id`, `assigned_manager_id`) that schema.prisma
// already declares, because the migration that adds them (20260919122125_lead_assign_batch_implement,
// unrelated lead-import work) is still pending/unapplied. An unguarded Lead query (default
// select-all) fails against that mismatch - a pre-existing, out-of-scope condition, documented in
// the E7.1 final report, not something this task fixes. Explicit selects (which this module's own
// production code also always uses) route around it entirely.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ActivityType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AuditService from "../audit/audit.service.js";
import CustomersService from "../customers/customers.service.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import WhatsAppService from "./whatsapp.service.js";
import WhatsAppFreeTextService from "./whatsapp.freetext.service.js";
import { MetaCloudApiProvider } from "./whatsapp.meta.provider.js";

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
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });

const LEAD_SELECT = { id: true, normalizedMobile: true } as const;

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: {
      leadNumber: `L-${uid()}`,
      firstName: "Priya",
      lastName: "Shah",
      mobile: "9876543210",
      normalizedMobile: "+919876543210",
      ...overrides,
    },
    select: LEAD_SELECT,
  });
}

/** A provider stub that never makes a network call - sendTemplateMessage's result is scripted per test. */
function fakeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    id: "AISENSY",
    sendTemplateMessage: async () => ({ providerMessageId: `wamid-${uid()}`, raw: { ok: true } }),
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "not supported by this fake provider" }),
    ...overrides,
  };
}

describe("sending a WhatsApp template message", () => {
  it("persists an OUTBOUND message and a WHATSAPP_MESSAGE_SENT activity attributed to the sender", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const svc = new WhatsAppService(tx, () => fakeProvider());

      const result = await svc.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "order_update", params: ["SHP-100"] });

      assert.equal(result.direction, "OUTBOUND");
      assert.equal(result.messageType, "TEMPLATE");
      assert.equal(result.status, "SENT");
      assert.equal(result.templateName, "order_update");

      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: result.id } });
      assert.equal(stored.leadId, lead.id);
      assert.equal(stored.sentById, admin.id);
      assert.equal(stored.toNumber, "+919876543210");

      const activity = await tx.activity.findFirst({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_MESSAGE_SENT } });
      assert.ok(activity, "a WHATSAPP_MESSAGE_SENT activity was recorded");
      assert.equal(activity!.actorId, admin.id);
      assert.equal(activity!.source, ActivitySource.USER);
      assert.equal(activity!.referenceType, "WhatsAppMessage");
      assert.equal(activity!.referenceId, result.id);
    });
  });

  it("is QUEUED, not SENT, when the provider accepts without returning a message id", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const svc = new WhatsAppService(tx, () => fakeProvider({ sendTemplateMessage: async () => ({ providerMessageId: null, raw: {} }) }));
      const result = await svc.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "t", params: [] });
      assert.equal(result.status, "QUEUED");
    });
  });

  it("404s for a customer outside the caller's lead scope - a salesperson cannot message another rep's customer", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep2.id });
      const svc = new WhatsAppService(tx, () => fakeProvider());

      await assert.rejects(
        () => svc.sendTemplateMessage(as(rep1, Role.SALESPERSON), { leadId: lead.id, templateName: "t", params: [] }),
        (e: any) => e.statusCode === 404,
      );
    });
  });

  it("refuses to send to a customer with no valid mobile number, without calling the provider", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx, { mobile: null, normalizedMobile: null });
      let called = false;
      const svc = new WhatsAppService(tx, () => fakeProvider({ sendTemplateMessage: async () => { called = true; return { providerMessageId: "x", raw: {} }; } }));

      await assert.rejects(() => svc.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "t", params: [] }), (e: any) => e.statusCode === 400);
      assert.equal(called, false);
    });
  });

  it("reports 503 when WhatsApp is not configured, and sends nothing", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const svc = new WhatsAppService(tx, () => null);
      await assert.rejects(() => svc.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "t", params: [] }), (e: any) => e.statusCode === 503);
    });
  });

  it("turns a provider rejection into a 400 and persists nothing", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const { WhatsAppSendError } = await import("./whatsapp.provider.js");
      const svc = new WhatsAppService(tx, () => fakeProvider({ sendTemplateMessage: async () => { throw new WhatsAppSendError("template not approved"); } }));

      await assert.rejects(() => svc.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "t", params: [] }), (e: any) => e.statusCode === 400);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
    });
  });
});

describe("customer WhatsApp status", () => {
  it("reports the total and most recent message for a customer", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const svc = new WhatsAppService(tx, () => fakeProvider());
      await svc.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "first", params: [] });
      await svc.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "second", params: [] });

      const status = await svc.getCustomerWhatsAppStatus(as(admin, Role.ADMIN), lead.id);
      assert.equal(status.totalMessages, 2);
      assert.equal(status.lastMessage?.templateName, "second");
    });
  });

  it("404s for an out-of-scope customer", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep2.id });
      const svc = new WhatsAppService(tx);
      await assert.rejects(() => svc.getCustomerWhatsAppStatus(as(rep1, Role.SALESPERSON), lead.id), (e: any) => e.statusCode === 404);
    });
  });
});

describe("inbound message matching and lead creation (never a duplicate for the same number)", () => {
  it("matches an inbound message to the lead with the same normalized phone number", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { normalizedMobile: "+919876500001" });
      const svc = new WhatsAppService(tx);

      await svc.recordInboundMessage("AISENSY", { providerMessageId: "wamid-1", from: "919876500001", to: null, messageType: "TEXT", text: "Hi, is my order shipped?", timestamp: new Date() });

      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { provider_providerMessageId: { provider: "AISENSY", providerMessageId: "wamid-1" } } });
      assert.equal(stored.leadId, lead.id);
      assert.equal(stored.direction, "INBOUND");
      assert.equal(stored.status, "RECEIVED");
      assert.equal(stored.body, "Hi, is my order shipped?");

      const activity = await tx.activity.findFirst({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_MESSAGE_RECEIVED } });
      assert.ok(activity);
      assert.equal(activity!.actorId, null, "a webhook-driven event never invents a human actor");
      assert.equal(activity!.source, ActivitySource.WHATSAPP_WEBHOOK);
    });
  });

  // Phase 6's own behavior changed for this task (WhatsApp Inbox + AI order-taking, Phase 2 -
  // "if not found, create the appropriate CRM contact/lead using the existing service/model"):
  // an unmatched sender now gets a real Lead via leadService.createLeadFromSource, the same
  // Source-attributed pattern Meta/Shopify already use - never a bespoke lead-creation path, and
  // never a second lead for a second message from the same unmatched number (createLeadFromSource's
  // own dedup, scoped to the singleton "WhatsApp Inbound" Source).
  it("creates a new lead for an unmatched sender, attaches the message and Activity to it", async () => {
    await inRollback(async (tx) => {
      const svc = new WhatsAppService(tx);
      const unknownNumber = `9${Date.now()}`.slice(0, 10);
      await svc.recordInboundMessage("AISENSY", { providerMessageId: "wamid-unmatched", from: unknownNumber, to: null, messageType: "TEXT", text: "Hello", timestamp: new Date() });

      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { provider_providerMessageId: { provider: "AISENSY", providerMessageId: "wamid-unmatched" } }, select: { leadId: true } });
      assert.ok(stored.leadId, "a new lead was created and attached");

      const lead = await tx.lead.findUniqueOrThrow({ where: { id: stored.leadId! }, select: LEAD_SELECT });
      assert.equal(lead.normalizedMobile, `+91${unknownNumber}`);

      const receivedActivity = await tx.activity.findFirst({ where: { leadId: stored.leadId!, type: ActivityType.WHATSAPP_MESSAGE_RECEIVED } });
      assert.ok(receivedActivity);
      const createdActivity = await tx.activity.findFirst({ where: { leadId: stored.leadId!, type: ActivityType.LEAD_CREATED } });
      assert.ok(createdActivity, "the new lead's own creation is audited too");

      const source = await tx.source.findFirst({ where: { type: "WHATSAPP" }, select: { id: true, name: true } });
      assert.ok(source, "a singleton WhatsApp Inbound Source backs the new lead");
    });
  });

  it("never creates a duplicate lead for a second message from the same still-unmatched number", async () => {
    await inRollback(async (tx) => {
      const svc = new WhatsAppService(tx);
      const unknownNumber = `9${Date.now()}`.slice(0, 10);
      await svc.recordInboundMessage("AISENSY", { providerMessageId: "wamid-u1", from: unknownNumber, to: null, messageType: "TEXT", text: "Hello", timestamp: new Date() });
      await svc.recordInboundMessage("AISENSY", { providerMessageId: "wamid-u2", from: unknownNumber, to: null, messageType: "TEXT", text: "Are you open?", timestamp: new Date(Date.now() + 1000) });

      const m1 = await tx.whatsAppMessage.findUniqueOrThrow({ where: { provider_providerMessageId: { provider: "AISENSY", providerMessageId: "wamid-u1" } }, select: { leadId: true } });
      const m2 = await tx.whatsAppMessage.findUniqueOrThrow({ where: { provider_providerMessageId: { provider: "AISENSY", providerMessageId: "wamid-u2" } }, select: { leadId: true } });
      assert.equal(m1.leadId, m2.leadId, "the same lead, never a duplicate");

      const source = await tx.source.findFirst({ where: { type: "WHATSAPP" }, select: { id: true } });
      assert.equal(await tx.lead.count({ where: { sourceId: source!.id, normalizedMobile: `+91${unknownNumber}` } }), 1);
    });
  });

  it("is idempotent: a repeat delivery of the same provider message id is not stored twice", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { normalizedMobile: "+919876500002" });
      const svc = new WhatsAppService(tx);
      const msg = { providerMessageId: "wamid-dup", from: "919876500002", to: null, messageType: "TEXT" as const, text: "hi", timestamp: new Date() };

      await svc.recordInboundMessage("AISENSY", msg);
      await svc.recordInboundMessage("AISENSY", msg);

      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 1);
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_MESSAGE_RECEIVED } }), 1);
    });
  });
});

describe("delivery status updates", () => {
  async function sentMessage(tx: Prisma.TransactionClient, leadId: string, providerMessageId: string) {
    return tx.whatsAppMessage.create({
      data: { provider: "AISENSY", providerMessageId, direction: "OUTBOUND", messageType: "TEMPLATE", status: "SENT", leadId, sentAt: new Date("2026-09-20T10:00:00Z") },
      select: { id: true, status: true },
    });
  }

  it("advances SENT -> DELIVERED -> READ, writing one activity per real transition", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await sentMessage(tx, lead.id, "wamid-status-1");
      const svc = new WhatsAppService(tx);

      await svc.recordStatusUpdate("AISENSY", { providerMessageId: "wamid-status-1", status: "DELIVERED", timestamp: new Date("2026-09-20T10:01:00Z") });
      await svc.recordStatusUpdate("AISENSY", { providerMessageId: "wamid-status-1", status: "READ", timestamp: new Date("2026-09-20T10:02:00Z") });

      const stored = await tx.whatsAppMessage.findFirst({ where: { leadId: lead.id } });
      assert.equal(stored?.status, "READ");
      assert.ok(stored?.deliveredAt);
      assert.ok(stored?.readAt);

      const activities = await tx.activity.findMany({ where: { leadId: lead.id, type: { in: [ActivityType.WHATSAPP_DELIVERED, ActivityType.WHATSAPP_READ] } } });
      assert.equal(activities.length, 2);
      assert.ok(activities.every((a) => a.source === ActivitySource.WHATSAPP_WEBHOOK && a.actorId === null));
    });
  });

  it("ignores a stale/duplicate status that would move the message backwards", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await sentMessage(tx, lead.id, "wamid-status-2");
      const svc = new WhatsAppService(tx);

      await svc.recordStatusUpdate("AISENSY", { providerMessageId: "wamid-status-2", status: "READ", timestamp: new Date("2026-09-20T10:02:00Z") });
      // A late-arriving "delivered" (e.g. a re-sent webhook) must not un-read the message or double-log.
      await svc.recordStatusUpdate("AISENSY", { providerMessageId: "wamid-status-2", status: "DELIVERED", timestamp: new Date("2026-09-20T10:01:00Z") });

      const stored = await tx.whatsAppMessage.findFirst({ where: { leadId: lead.id } });
      assert.equal(stored?.status, "READ", "did not regress");
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_DELIVERED } }), 0);
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_READ } }), 1);
    });
  });

  it("never fabricates a message row for a status update the CRM never sent", async () => {
    await inRollback(async (tx) => {
      const svc = new WhatsAppService(tx);
      await svc.recordStatusUpdate("AISENSY", { providerMessageId: "wamid-unknown", status: "DELIVERED", timestamp: new Date() });
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: "wamid-unknown" } }), 0);
    });
  });

  it("records WHATSAPP_FAILED with the provider's error message", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await sentMessage(tx, lead.id, "wamid-status-3");
      const svc = new WhatsAppService(tx);
      await svc.recordStatusUpdate("AISENSY", { providerMessageId: "wamid-status-3", status: "FAILED", timestamp: new Date(), errorCode: "131047", errorMessage: "Re-engagement message" });

      const activity = await tx.activity.findFirst({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_FAILED } });
      assert.equal(activity?.description, "Re-engagement message");
    });
  });
});

describe("WhatsApp events reach Customer 360 and the Audit Trail without duplicating each other", () => {
  it("shows send/delivered milestones on the timeline, and the same events on the audit log, exactly once each", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const whatsapp = new WhatsAppService(tx, () => fakeProvider());
      const sent = await whatsapp.sendTemplateMessage(as(admin, Role.ADMIN), { leadId: lead.id, templateName: "order_update", params: [] });
      await whatsapp.recordStatusUpdate("AISENSY", { providerMessageId: (await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: sent.id }, select: { providerMessageId: true } })).providerMessageId!, status: "DELIVERED", timestamp: new Date() });

      const customers = new CustomersService(tx);
      const timeline = await customers.getTimeline(as(admin, Role.ADMIN), lead.id, { page: 1, pageSize: 50 });
      const sentEntries = timeline.entries.filter((e) => e.type === "WHATSAPP_MESSAGE_SENT");
      const deliveredEntries = timeline.entries.filter((e) => e.type === "WHATSAPP_DELIVERED");
      assert.equal(sentEntries.length, 1);
      assert.equal(deliveredEntries.length, 1);

      const audit = new AuditService(tx);
      const auditResult = await audit.getCustomerAudit(as(admin, Role.ADMIN), lead.id, { page: 1, pageSize: 50 });
      assert.equal(auditResult.items.filter((a) => a.type === "WHATSAPP_MESSAGE_SENT").length, 1);
      assert.equal(auditResult.items.filter((a) => a.type === "WHATSAPP_DELIVERED").length, 1);
    });
  });
});

// Regression (reported for a real customer, +91 93216 14025): a customer who already has an AISENSY conversation and AiSensy history messages the Meta-connected
// number. The Meta webhook (wa_id has no "+", the CRM stores "+91 93216 14025") must resolve to the SAME lead, be saved
// as provider META, flip the (single) conversation to META, and open the Meta service window - without touching the
// AiSensy history, and without any manual provider change.
describe("Meta inbound for a customer who already has an AiSensy conversation", () => {
  const META_CREDS = { phoneNumberId: "pn-1", businessAccountId: "waba-1", accessToken: "unused", appSecret: "unused", verifyToken: "unused", graphApiVersion: "v21.0" };
  const metaWebhook = (waId: string, wamid: string, ts: Date) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba-1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15551822677", phone_number_id: "pn-1" },
      contacts: [{ profile: { name: "Customer" }, wa_id: waId }],
      messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(ts.getTime() / 1000)), type: "text", text: { body: "Hello on the Meta number" } }],
    } }] }],
  });

  it("saves the message as META on the same lead, flips the conversation to META, and allows free text inside the window", async () => {
    await inRollback(async (tx) => {
      // A unique number per run (the shared dev DB holds real leads - the matcher correctly prefers the oldest lead for a real number).
      const ten = "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
      const waId = "91" + ten;
      const lead = await makeLead(tx, { mobile: "+91 " + ten.slice(0, 5) + " " + ten.slice(5), normalizedMobile: "+" + waId });
      await tx.whatsAppMessage.create({ data: { provider: "AISENSY", providerMessageId: `ais-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId: lead.id, fromNumber: waId, normalizedContact: "+" + waId, body: "earlier AiSensy message", receivedAt: new Date(Date.now() - 3600_000) } });
      await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: "AISENSY" } });

      const meta = new MetaCloudApiProvider(META_CREDS);
      const wamid = `wamid.${uid()}`;
      const parsed = meta.parseIncomingWebhook(metaWebhook(waId, wamid, new Date()));
      assert.equal(parsed.length, 1);

      const svc = new WhatsAppService(tx, () => fakeProvider());
      await svc.recordInboundMessage("META", parsed[0]!);

      const saved = await tx.whatsAppMessage.findUniqueOrThrow({ where: { provider_providerMessageId: { provider: "META", providerMessageId: wamid } }, select: { provider: true, leadId: true, direction: true } });
      assert.equal(saved.provider, "META");
      assert.equal(saved.leadId, lead.id, "resolved to the existing lead, not a new one");
      assert.equal(await tx.lead.count({ where: { normalizedMobile: "+" + waId } }), 1);

      const conversations = await tx.whatsAppConversation.findMany({ where: { leadId: lead.id }, select: { provider: true } });
      assert.deepEqual(conversations, [{ provider: "META" }], "one conversation, now on META");

      // The earlier AiSensy history is untouched.
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id, provider: "AISENSY" } }), 1);

      // A repeat delivery of the same Meta message changes nothing.
      await svc.recordInboundMessage("META", parsed[0]!);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id, provider: "META" } }), 1);

      const freeText = new WhatsAppFreeTextService(tx, async () => meta);
      const { capability } = await freeText.getCapability(lead.id);
      assert.equal(capability.activeProvider, "META");
      assert.equal(capability.serviceWindow.open, true);
      assert.equal(capability.freeText.allowed, true);
    });
  });
});
