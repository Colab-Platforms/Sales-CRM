// Database tests: sending an approved template to another team's CONVERSATION, and showing messages that have no lead. Run with: npm run test:db
// Rolled-back transaction only; the provider is a fake - nothing is sent anywhere.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import WhatsAppService from "./whatsapp.service.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 90_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role }) as never;
const status = (code: number) => (e: any) => e.statusCode === code;

function fakeProvider(sent: unknown[], overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    id: "META",
    sendTemplateMessage: async (input: unknown) => { sent.push(input); return { providerMessageId: `wamid-${uid()}`, raw: { ok: true } }; },
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "n/a" }),
    ...overrides,
  } as WhatsAppProvider;
}

async function world(tx: Prisma.TransactionClient) {
  const tag = `Gap${uid().slice(0, 8)}`;
  const mk = (role: Role, name: string) => tx.user.create({ data: { name, username: `u-${uid()}`, role }, select: { id: true, username: true } });
  const admin = await mk(Role.ADMIN, "Admin");
  const mgrB = await mk(Role.MANAGER, "MgrB");
  const repA = await mk(Role.SALESPERSON, "RepA");
  const repB = await mk(Role.SALESPERSON, "RepB");
  const lead = (over: Partial<Prisma.LeadUncheckedCreateInput>) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: tag, lastName: "Customer", ...over }, select: { id: true } });
  const template = await tx.whatsAppTemplate.create({ data: { name: `t_${uid()}`, provider: "META", language: "en", body: "Hi {{customer_name}}!", variables: ["customer_name"], status: WhatsAppTemplateStatus.APPROVED }, select: { id: true, name: true } });
  const msg = (leadId: string | null, direction: "INBOUND" | "OUTBOUND", contact: string, at = new Date()) =>
    tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `wamid-${uid()}`, direction, messageType: "TEXT", status: direction === "INBOUND" ? "RECEIVED" : "SENT", leadId, normalizedContact: contact, fromNumber: contact, body: `${direction} text`, createdAt: at, receivedAt: at }, select: { id: true } });
  return { tag, admin, mgrB, repA, repB, lead, template, msg, svc: new WhatsAppService(tx) };
}

describe("approved templates can be sent to another team's conversation", () => {
  it("admin, manager and salesperson can preview and send to a lead that has a conversation, owned by someone else; the message is recorded against that conversation", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      // one customer per sender: the service's own 30-second duplicate guard collapses repeat sends of the same template to the same lead
      const leads = [] as { id: string; phone: string }[];
      for (const n of [1, 2, 3]) {
        const phone = `+91981237710${n}`;
        const l = await w.lead({ mobile: phone.slice(3), normalizedMobile: phone, ownerId: w.repA.id });
        await w.msg(l.id, "INBOUND", phone);
        leads.push({ id: l.id, phone });
      }
      const sent: any[] = [];
      const svc = new WhatsAppMessagingService(tx, () => null, async () => fakeProvider(sent));

      const actors = [[w.admin, Role.ADMIN], [w.mgrB, Role.MANAGER], [w.repB, Role.SALESPERSON]] as const;
      for (const [i, [u, role]] of actors.entries()) {
        const lead = leads[i]!;
        const preview = await svc.previewTemplate(as(u, role), { leadId: lead.id, templateId: w.template.id });
        assert.equal(preview.resolvedBody, `Hi ${w.tag} Customer!`, `${role}: variables resolve from the conversation's verified contact`);
        const result = await svc.sendTemplate(as(u, role), { leadId: lead.id, templateId: w.template.id });
        assert.equal(result.status === "FAILED", false, `${role}: sent`);
        const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { leadId: lead.id, direction: "OUTBOUND" }, select: { sentById: true, toNumber: true } });
        assert.equal(row.sentById, u.id, `${role}: recorded against the sender`);
        assert.equal(sent[i].to, lead.phone, "always the verified number of that conversation, never a caller-supplied one");
      }
      assert.equal(sent.length, 3, "the provider was asked once per send");
    });
  });

  it("validation is unchanged: a lead with NO conversation owned by another team is still 'not found'; an unapproved template is refused; HR is refused; a provider failure is surfaced", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const noConversation = await w.lead({ mobile: "9812377102", normalizedMobile: "+919812377102", ownerId: w.repA.id });
      const withConversation = await w.lead({ mobile: "9812377103", normalizedMobile: "+919812377103", ownerId: w.repA.id });
      await w.msg(withConversation.id, "INBOUND", "+919812377103");
      const draft = await tx.whatsAppTemplate.create({ data: { name: `t_${uid()}`, provider: "META", language: "en", body: "Hi", variables: [], status: WhatsAppTemplateStatus.DRAFT }, select: { id: true } });
      const sent: any[] = [];
      const svc = new WhatsAppMessagingService(tx, () => null, async () => fakeProvider(sent));

      await assert.rejects(svc.sendTemplate(as(w.repB, Role.SALESPERSON), { leadId: noConversation.id, templateId: w.template.id }), status(404));
      await assert.rejects(svc.sendTemplate(as(w.mgrB, Role.MANAGER), { leadId: noConversation.id, templateId: w.template.id }), status(404));
      await assert.rejects(svc.sendTemplate(as(w.repB, Role.SALESPERSON), { leadId: withConversation.id, templateId: draft.id }), status(400));
      await assert.rejects(svc.sendTemplate(as({ id: uid(), username: "hr" }, Role.HR), { leadId: withConversation.id, templateId: w.template.id }), status(404));
      await assert.rejects(svc.sendTemplate(as(w.repB, Role.SALESPERSON), { leadId: withConversation.id, templateId: uid() }), status(404));
      assert.equal(sent.length, 0, "nothing reached the provider for any refused attempt");

      const failing = new WhatsAppMessagingService(tx, () => null, async () => fakeProvider([], { sendTemplateMessage: async () => { throw new WhatsAppSendError("Meta rejected the template (test)"); } }));
      // a provider failure is not swallowed: the attempt is recorded as FAILED with the provider's reason, and returned to the caller
      const failed = await failing.sendTemplate(as(w.repB, Role.SALESPERSON), { leadId: withConversation.id, templateId: w.template.id });
      assert.equal(failed.status, "FAILED");
      assert.match(failed.errorMessage ?? "", /rejected/i);
    });
  });
});

describe("messages without a lead are shown, never hidden", () => {
  it("a lead-less message from a phone that leads have joins that conversation (list, latest message, thread) without being re-attached or merged", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.lead({ mobile: "9812377201", normalizedMobile: "+919812377201", ownerId: w.repA.id, createdAt: new Date("2026-09-01T00:00:00Z") });
      const b = await w.lead({ mobile: "9812377201", normalizedMobile: "9812377201", createdAt: new Date("2026-09-02T00:00:00Z") }); // duplicate, legacy shape
      const stranger = await w.lead({ mobile: "9812377299", normalizedMobile: "+919812377299" });
      const t = Date.now();
      await w.msg(a.id, "OUTBOUND", "+919812377201", new Date(t - 120_000));
      const orphan = await w.msg(null, "INBOUND", "+919812377201", new Date(t - 60_000));
      await w.msg(stranger.id, "INBOUND", "+919812377299", new Date(t - 30_000));

      for (const [u, role] of [[w.admin, Role.ADMIN], [w.mgrB, Role.MANAGER], [w.repB, Role.SALESPERSON]] as const) {
        const me = as(u, role);
        const items = (await w.svc.listConversations(me, { page: 1, pageSize: 100, search: "9812377201" })).items;
        assert.equal(items.length, 1, `${role}: one row for the phone`);
        assert.equal(items[0]!.lastMessage.id, orphan.id, `${role}: the lead-less reply is the latest message shown`);
        const thread = await w.svc.listMessages(me, { page: 1, pageSize: 50, leadId: items[0]!.leadId });
        assert.ok(thread.items.some((m) => m.id === orphan.id), `${role}: the thread includes it`);
        assert.ok(!thread.items.some((m) => m.body === "INBOUND text" && m.customer?.leadId === stranger.id), "a different phone is never pulled in");
      }
      assert.equal((await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: orphan.id }, select: { leadId: true } })).leadId, null, "the stored message is untouched - no automatic re-attachment");
      assert.equal(await tx.lead.count({ where: { id: { in: [a.id, b.id] } } }), 2, "no lead was merged or deleted");
    });
  });

  it("a lead-less message from a phone NO lead has appears in the read-only unmatched list for admin/manager/salesperson, and stays out of the normal rows; HR sees nothing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.msg(null, "INBOUND", "+919812377301");
      await w.msg(null, "INBOUND", "+919812377301");
      for (const [u, role] of [[w.admin, Role.ADMIN], [w.mgrB, Role.MANAGER], [w.repB, Role.SALESPERSON]] as const) {
        const res = await w.svc.listConversations(as(u, role), { page: 1, pageSize: 100, search: "9812377301" });
        assert.deepEqual(res.items, [], `${role}: no fabricated customer row`);
        assert.equal(res.unmatched?.length, 1, `${role}: shown in the unmatched list`);
        assert.equal(res.unmatched![0]!.phone, "+919812377301");
        assert.equal(res.unmatched![0]!.messageCount, 2);
      }
      const hr = await w.svc.listConversations(as({ id: uid(), username: "hr" }, Role.HR), { page: 1, pageSize: 100, search: "9812377301" });
      assert.equal(hr.unmatched, undefined);
    });
  });
});
