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
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });

// Each lead gets its OWN phone by default: bulk send sends once per phone number, so fixtures that mean "different customers" must not share one.
let phoneSeq = 0;
async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  phoneSeq += 1;
  const mobile = `98764${String(10000 + phoneSeq).padStart(5, "0")}`;
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Test", lastName: `C-${uid().slice(0, 6)}`, mobile, normalizedMobile: `+91${mobile}`, ...overrides },
    select: { id: true, mobile: true },
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx, { mobile: null, normalizedMobile: null });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);

      const result = await bulk.classifyRecipients(as(admin, Role.ADMIN), { leadIds: [lead.id], templateId: template.id, manualValues: { webinar_name: "Wellness Webinar" } });
      assert.equal(result.summary.INVALID_PHONE, 1);
    });
  });

  it("classifies every recipient TEMPLATE_NOT_SENDABLE when the template is not APPROVED, without touching provider/variable checks", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const rep1 = await tx.user.create({ data: { name: "Rep1", username: `r1-${uid()}`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", username: `r2-${uid()}`, role: Role.SALESPERSON } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
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

// ---- The reported case: 9 chats selected, 1 Ready, 8 Excluded ("UnknownProvider issue - Customer not found or outside your access"). ----
describe("Bulk send: cross-team recipients, duplicates, conversation ids and honest exclusion reasons", () => {
  const webhook = { webinar_name: "Wellness Webinar" };

  async function nineChats(tx: Prisma.TransactionClient) {
    const mk = (role: Role, name: string) => tx.user.create({ data: { name, username: `u-${uid()}`, role }, select: { id: true, username: true } });
    const manager = await mk(Role.MANAGER, "Manager B"); // the caller; none of the leads below belong to their team except A
    const owner = await mk(Role.SALESPERSON, "Owner A");
    const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
    const conversation = (leadId: string) => tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `wamid-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId, body: "hi" } });
    const A = await makeLead(tx, { ownerId: owner.id, groupId: group.id }); // in the caller's team
    const B = await makeLead(tx, { ownerId: owner.id }); // another team's customer, has a WhatsApp conversation
    const C = await makeLead(tx); // another team's customer, selected by its CONVERSATION id
    const D = await makeLead(tx, { mobile: B.mobile!, normalizedMobile: `+91${B.mobile}` }); // duplicate lead: same phone as B
    const E = await makeLead(tx); // another team's customer WITHOUT any WhatsApp conversation
    const G = await makeLead(tx, { mobile: null, normalizedMobile: null }); // no phone
    const H = await makeLead(tx); // opted out
    const I = await makeLead(tx, { workingStatus: "DEACTIVATED" });
    for (const l of [A, B, C, D, G, H, I]) await conversation(l.id);
    await tx.communicationPreference.create({ data: { leadId: H.id, channel: "WHATSAPP", status: "OPTED_OUT" } });
    const convC = await tx.whatsAppConversation.create({ data: { leadId: C.id, provider: "META" }, select: { id: true } });
    const ghost = uid(); // not a lead and not a conversation
    return { manager, A, B, C, D, E, G, H, I, convC, ghost, ids: [A.id, B.id, convC.id, D.id, E.id, ghost, G.id, H.id, I.id] };
  }

  it("classifies all nine selected chats individually: cross-team customers with a conversation are READY, and every exclusion has its own accurate reason", async () => {
    await inRollback(async (tx) => {
      const w = await nineChats(tx);
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);
      const result = await bulk.classifyRecipients(as(w.manager, Role.MANAGER), { leadIds: w.ids, templateId: template.id, manualValues: webhook });

      const by = (id: string) => result.recipients.find((r) => r.leadId === id)!;
      assert.equal(result.recipients.length, 9);
      assert.equal(by(w.A.id).status, "READY", "own team's customer");
      assert.equal(by(w.B.id).status, "READY", "another team's customer, handled company-wide because it has a conversation");
      assert.equal(by(w.C.id).status, "READY", "selected by CONVERSATION id: resolved to its customer, not reported as unknown");
      assert.equal(by(w.D.id).status, "DUPLICATE_PHONE", "same phone as B: messaged once");
      assert.match(by(w.D.id).reason ?? "", /Same phone number/);
      assert.equal(by(w.E.id).status, "NOT_ALLOWED", "another team's customer with no WhatsApp conversation");
      assert.equal(by(w.ghost).status, "NOT_FOUND", "an id that is neither a customer nor a conversation");
      assert.equal(by(w.G.id).status, "INVALID_PHONE");
      assert.equal(by(w.H.id).status, "OPTED_OUT");
      assert.equal(by(w.I.id).status, "CUSTOMER_DEACTIVATED");
      // the misleading catch-all text is gone, and the counts match the per-recipient results
      assert.ok(result.recipients.every((r) => !/Customer not found or outside your access/.test(r.reason ?? "")));
      assert.deepEqual(
        [result.summary.READY, result.summary.DUPLICATE_PHONE, result.summary.NOT_ALLOWED, result.summary.NOT_FOUND, result.summary.INVALID_PHONE, result.summary.OPTED_OUT, result.summary.CUSTOMER_DEACTIVATED],
        [3, 1, 1, 1, 1, 1, 1],
      );
      assert.equal(Object.values(result.summary).reduce((a, b) => a + b, 0), 9);
    });
  });

  it("the send only goes to the eligible recipients - once per phone - and records one message per send", async () => {
    await inRollback(async (tx) => {
      const w = await nineChats(tx);
      const template = await makeWebinarTemplate(tx);
      const sentTo: string[] = [];
      const { bulk } = makeServices(tx, fakeProvider({ sendTemplateMessage: async (input: any) => { sentTo.push(input.to); return { providerMessageId: `wamid-${uid()}`, raw: { ok: true } }; } }));
      const result = await bulk.sendBulk(as(w.manager, Role.MANAGER), { leadIds: w.ids, templateId: template.id, manualValues: webhook });

      assert.deepEqual([result.sent, result.failed, result.skipped], [3, 0, 6]);
      assert.deepEqual(new Set(sentTo), new Set([`+91${w.A.mobile}`, `+91${w.B.mobile}`, `+91${w.C.mobile}`]), "exactly the three eligible phones");
      assert.equal(sentTo.length, 3, "the duplicate lead of B did not cause a second send");
      for (const excluded of [w.D, w.E, w.G, w.H, w.I]) {
        assert.equal(await tx.whatsAppMessage.count({ where: { leadId: excluded.id, direction: "OUTBOUND" } }), 0, "no outbound message for an excluded recipient");
      }
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: { in: [w.A.id, w.B.id, w.C.id] }, direction: "OUTBOUND" } }), 3);
      // re-running the same send inside the duplicate-guard window does not send again
      const again = await bulk.sendBulk(as(w.manager, Role.MANAGER), { leadIds: w.ids, templateId: template.id, manualValues: webhook });
      assert.equal(sentTo.length, 3, "the existing duplicate-send guard still holds");
      assert.ok(again.sent <= 3);
    });
  });

  it("a provider/template problem stays distinguishable from an authorization problem", async () => {
    await inRollback(async (tx) => {
      const w = await nineChats(tx);
      const template = await makeWebinarTemplate(tx);
      // no provider configured: eligible customers are PROVIDER_ERROR with the provider reason; NOT_ALLOWED / NOT_FOUND are unchanged
      const messaging = new WhatsAppMessagingService(tx, () => null, async () => null);
      const bulk = new WhatsAppBulkSendService(tx, messaging);
      const r = await bulk.classifyRecipients(as(w.manager, Role.MANAGER), { leadIds: w.ids, templateId: template.id, manualValues: webhook });
      const by = (id: string) => r.recipients.find((x) => x.leadId === id)!;
      assert.equal(by(w.A.id).status, "PROVIDER_ERROR");
      assert.match(by(w.A.id).reason ?? "", /Meta WhatsApp Cloud API is not configured/);
      assert.equal(by(w.E.id).status, "NOT_ALLOWED");
      assert.equal(by(w.ghost).status, "NOT_FOUND");
      // a template that is not APPROVED: TEMPLATE_NOT_SENDABLE, not a provider or access error
      const draft = await tx.whatsAppTemplate.create({ data: { name: `d_${uid()}`, provider: "META", language: "en", body: "Hi", variables: [], status: "DRAFT" }, select: { id: true } });
      const t = await makeServices(tx).bulk.classifyRecipients(as(w.manager, Role.MANAGER), { leadIds: [w.A.id, w.E.id], templateId: draft.id });
      assert.equal(t.recipients.find((x) => x.leadId === w.A.id)!.status, "TEMPLATE_NOT_SENDABLE");
      assert.equal(t.recipients.find((x) => x.leadId === w.E.id)!.status, "NOT_ALLOWED");
    });
  });

  it("unauthorized callers are still refused: HR can message nobody, and a salesperson still cannot message another team's customer that has no conversation", async () => {
    await inRollback(async (tx) => {
      const w = await nineChats(tx);
      const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true } });
      const template = await makeWebinarTemplate(tx);
      const { bulk } = makeServices(tx);
      const hr = await bulk.classifyRecipients({ id: uid(), username: "hr", role: Role.HR } as never, { leadIds: [w.A.id, w.B.id], templateId: template.id, manualValues: webhook });
      assert.ok(hr.recipients.every((r) => r.status !== "READY"), "HR is never allowed to message");
      const asRep = await bulk.classifyRecipients(as(rep, Role.SALESPERSON), { leadIds: [w.B.id, w.E.id], templateId: template.id, manualValues: webhook });
      assert.equal(asRep.recipients.find((r) => r.leadId === w.B.id)!.status, "READY", "company-wide Inbox: a conversation of another team can be messaged");
      assert.equal(asRep.recipients.find((r) => r.leadId === w.E.id)!.status, "NOT_ALLOWED");
    });
  });
});
