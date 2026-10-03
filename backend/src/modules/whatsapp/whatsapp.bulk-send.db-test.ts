// Database integration tests for Parts 3-5 (WhatsApp Inbox: selected-chat/bulk sending). Run with:
// npm run test:db. Mirrors the rolled-back-transaction pattern in whatsapp.messaging.db-test.ts.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import WhatsAppBulkSendService from "./whatsapp.bulk-send.service.js";

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

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Test", lastName: `C-${uid().slice(0, 6)}`, mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true },
  });
}

// A webinar-style template: one CRM variable (customer_name) and one with no CRM source (webinar_name) -
// exactly the shape Part 1's bug fix and this bulk feature both need to exercise.
async function makeWebinarTemplate(tx: Prisma.TransactionClient, overrides: Partial<Prisma.WhatsAppTemplateUncheckedCreateInput> = {}) {
  return tx.whatsAppTemplate.create({
    data: {
      name: `webinar_${uid()}`,
      provider: "META",
      language: "en",
      body: "Hi {{customer_name}}, join our {{webinar_name}}!",
      variables: ["customer_name", "webinar_name"],
      status: WhatsAppTemplateStatus.APPROVED,
      ...overrides,
    },
    select: { id: true, name: true },
  });
}

// A signed-in user's send always goes through Meta now (AiSensy is disabled for user-initiated
// sends - see WhatsAppMessagingService.resolveSendProvider), and bulk send always acts as a
// signed-in user - so this fake stands in for the Meta provider (passed as the 3rd/getMeta
// constructor arg below, not the legacy 2nd arg).
function fakeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    id: "META",
    sendTemplateMessage: async () => ({ providerMessageId: `wamid-${uid()}`, raw: { ok: true } }),
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "n/a" }),
    ...overrides,
  };
}

function makeServices(tx: Prisma.TransactionClient, provider: WhatsAppProvider = fakeProvider()) {
  const messaging = new WhatsAppMessagingService(tx, () => null, async () => provider);
  return { messaging, bulk: new WhatsAppBulkSendService(tx, messaging) };
}

describe("Bulk/selected-chat sending: classification (Part 5 safety states)", () => {
  it("classifies READY once a manual value is supplied for the one variable with no CRM source", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id, manualValues: { webinar_name: "Wellness Webinar" } });
      assert.equal(result.summary.READY, 1);
      assert.equal(result.recipients[0]?.status, "READY");
      assert.match(result.recipients[0]?.resolvedBody ?? "", /Wellness Webinar/);
    });
  });

  it("classifies MISSING_VARIABLE, naming the variable, when no manual value is supplied", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id });
      assert.equal(result.summary.MISSING_VARIABLE, 1);
      assert.match(result.recipients[0]?.reason ?? "", /webinar_name/);
    });
  });

  it("classifies OPTED_OUT and never lets that recipient reach READY, even with a manual value", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await tx.communicationPreference.create({ data: { leadId: lead.id, channel: "WHATSAPP", status: "OPTED_OUT" } });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id, manualValues: { webinar_name: "Wellness Webinar" } });
      assert.equal(result.summary.OPTED_OUT, 1);
      assert.equal(result.summary.READY, 0);
    });
  });

  it("classifies INVALID_PHONE for a customer with no mobile number on file", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx, { mobile: null, normalizedMobile: null });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id, manualValues: { webinar_name: "Wellness Webinar" } });
      assert.equal(result.summary.INVALID_PHONE, 1);
    });
  });

  it("classifies every recipient TEMPLATE_NOT_SENDABLE when the template is not APPROVED, without touching provider/variable checks", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead1 = await makeLead(tx);
      const lead2 = await makeLead(tx);
      const template = await makeWebinarTemplate(tx, { status: WhatsAppTemplateStatus.PENDING });
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), { leadIds: [lead1.id, lead2.id], templateId: template.id });
      assert.equal(result.summary.TEMPLATE_NOT_SENDABLE, 2);
      assert.match(result.recipients[0]?.reason ?? "", /pending/i);
    });
  });

  it("mixes multiple selected chats with different outcomes in one review, with an accurate summary count", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const ready = await makeLead(tx);
      const optedOut = await makeLead(tx);
      await tx.communicationPreference.create({ data: { leadId: optedOut.id, channel: "WHATSAPP", status: "OPTED_OUT" } });
      const invalidPhone = await makeLead(tx, { mobile: null, normalizedMobile: null });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), {
        leadIds: [ready.id, optedOut.id, invalidPhone.id],
        templateId: template.id,
        manualValues: { webinar_name: "Wellness Webinar" },
      });
      // Every selected chat appears exactly once - never silently dropped.
      assert.equal(result.recipients.length, 3);
      assert.equal(result.summary.READY, 1);
      assert.equal(result.summary.OPTED_OUT, 1);
      assert.equal(result.summary.INVALID_PHONE, 1);
    });
  });

  it("404-equivalent: a lead outside the caller's scope is still reported, never silently dropped", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const notMine = await makeLead(tx, { ownerId: rep2.id });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(rep1, Role.SALESPERSON), { leadIds: [notMine.id], templateId: template.id, manualValues: { webinar_name: "x" } });
      assert.equal(result.recipients.length, 1);
      assert.notEqual(result.recipients[0]?.status, "READY");
      assert.ok(result.recipients[0]?.reason);
    });
  });

  // Part 7 (WhatsApp Inbox): a deactivated customer must never receive a bulk message either -
  // checked before opt-out/phone/template so the reason is always specific.
  it("classifies a deactivated customer as CUSTOMER_DEACTIVATED, never READY, even with every other condition satisfied", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx, { workingStatus: "DEACTIVATED" });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id, manualValues: { webinar_name: "Wellness Webinar" } });
      assert.equal(result.recipients[0]?.status, "CUSTOMER_DEACTIVATED");
      assert.equal(result.summary.READY, 0);
    });
  });
});

describe("Bulk/selected-chat sending: send (Parts 3-4)", () => {
  it("sends only to READY recipients via the real per-message send path, and reports per-recipient outcomes", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const ready1 = await makeLead(tx);
      const ready2 = await makeLead(tx);
      const optedOut = await makeLead(tx);
      await tx.communicationPreference.create({ data: { leadId: optedOut.id, channel: "WHATSAPP", status: "OPTED_OUT" } });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.sendBulk(as(admin, Role.ADMIN), {
        leadIds: [ready1.id, ready2.id, optedOut.id],
        templateId: template.id,
        manualValues: { webinar_name: "Wellness Webinar" },
      });

      assert.equal(result.sent, 2);
      assert.equal(result.skipped, 1);
      assert.equal(result.failed, 0);
      assert.equal(result.recipients.find((r) => r.leadId === optedOut.id)?.status, "OPTED_OUT");

      // Real WhatsAppMessage rows exist for the two sent recipients, and none for the opted-out one.
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: ready1.id, templateId: template.id } }), 1);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: ready2.id, templateId: template.id } }), 1);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: optedOut.id } }), 0);
    });
  });

  it("never sends to an opted-out contact even if it were somehow re-attempted", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const optedOut = await makeLead(tx);
      await tx.communicationPreference.create({ data: { leadId: optedOut.id, channel: "WHATSAPP", status: "OPTED_OUT" } });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      await bulk.sendBulk(as(admin, Role.ADMIN), { leadIds: [optedOut.id], templateId: template.id, manualValues: { webinar_name: "x" } });
      await bulk.sendBulk(as(admin, Role.ADMIN), { leadIds: [optedOut.id], templateId: template.id, manualValues: { webinar_name: "x" } });

      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: optedOut.id } }), 0);
    });
  });

  it("persists a per-recipient FAILED outcome (never a silent skip) when the provider rejects one send", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeWebinarTemplate(tx);
      const rejecting = fakeProvider({
        sendTemplateMessage: async () => {
          throw new WhatsAppSendError("AiSensy rejected the message");
        },
      });
      const { bulk } = makeServices(tx, rejecting);

      const result = await bulk.sendBulk(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id, manualValues: { webinar_name: "x" } });
      assert.equal(result.sent, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.recipients[0]?.status, "FAILED");
      assert.match(result.recipients[0]?.reason ?? "", /rejected/);
    });
  });

  it("never attempts a send for a TEMPLATE_NOT_SENDABLE template, for any recipient", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeWebinarTemplate(tx, { status: WhatsAppTemplateStatus.DRAFT });
      const { bulk } = makeServices(tx);

      const result = await bulk.sendBulk(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id, manualValues: { webinar_name: "x" } });
      assert.equal(result.sent, 0);
      assert.equal(result.skipped, 1);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
    });
  });
});
