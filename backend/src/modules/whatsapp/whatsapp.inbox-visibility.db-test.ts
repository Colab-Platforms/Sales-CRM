// Database tests: WhatsApp conversations and message history are VISIBLE company-wide to ADMIN, MANAGER and SALESPERSON (telecaller), whichever team owns the lead - while every ACTION
// (assign, archive, send, order-draft confirm) and every customer/lead/order scope keeps its existing rule. Run with: npm run test:db
// Rolled-back transaction only; no provider is called, nothing is sent.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import WhatsAppService from "./whatsapp.service.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";
import CustomersService from "../customers/customers.service.js";
import type { NormalizedIncomingMessage } from "./whatsapp.provider.js";

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
const notFound = (p: Promise<unknown>) => assert.rejects(p, (e: any) => e.statusCode === 404);

// Team A owns the customer; the viewers are admin, manager B, salesperson B and a second salesperson B ("telecaller") - none of them in team A.
async function world(tx: Prisma.TransactionClient) {
  const tag = `WaVis${uid().slice(0, 8)}`;
  const mk = (role: Role, name: string) => tx.user.create({ data: { name, username: `u-${uid()}`, role }, select: { id: true, username: true } });
  const admin = await mk(Role.ADMIN, "Admin");
  const hr = { id: uid(), username: "hr-synthetic" }; // no DB row needed: scope is derived from the role alone
  const mgrA = await mk(Role.MANAGER, "MgrA");
  const mgrB = await mk(Role.MANAGER, "MgrB");
  const repA = await mk(Role.SALESPERSON, "RepA");
  const repB = await mk(Role.SALESPERSON, "RepB");
  const teleB = await mk(Role.SALESPERSON, "TeleB");
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: mgrA.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: repA.id, joinedAt: new Date(), isActive: true } });
  const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: tag, lastName: "Customer", mobile: "9812388001", normalizedMobile: "+919812388001", ownerId: repA.id, groupId: group.id }, select: { id: true } });
  const svc = new WhatsAppService(tx);
  const conv = new WhatsAppConversationService(tx);
  const inbound = (id: string, text: string): NormalizedIncomingMessage => ({ providerMessageId: id, from: "919812388001", to: null, messageType: "TEXT", text, timestamp: new Date() });
  return { tag, admin, hr, mgrA, mgrB, repA, repB, teleB, lead: lead.id, svc, conv, inbound };
}

const VIEWERS = (w: Awaited<ReturnType<typeof world>>) => [
  ["ADMIN", w.admin, Role.ADMIN], ["MANAGER (other team)", w.mgrB, Role.MANAGER], ["SALESPERSON (other owner)", w.repB, Role.SALESPERSON], ["TELECALLER (another salesperson)", w.teleB, Role.SALESPERSON],
] as const;

describe("WhatsApp inbox: incoming replies are visible to every role, whichever team owns the customer", () => {
  it("conversation list (+search), message history, message detail and conversation detail all show the customer's reply to admin, manager, salesperson and telecaller", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `wamid-out-${uid()}`, direction: "OUTBOUND", messageType: "TEMPLATE", status: "DELIVERED", leadId: w.lead, normalizedContact: "+919812388001", templateName: "order_approval" } });
      await w.svc.recordInboundMessage("META", w.inbound(`wamid-in-${uid()}`, "Yes, approved"));
      const replyRow = await tx.whatsAppMessage.findFirstOrThrow({ where: { leadId: w.lead, direction: "INBOUND" }, select: { id: true } });

      for (const [label, user, role] of VIEWERS(w)) {
        const me = as(user, role);
        // list + search
        const list = await w.svc.listConversations(me, { page: 1, pageSize: 100, search: w.tag });
        assert.equal(list.items.length, 1, `${label}: the conversation is listed and found by search`);
        assert.equal(list.items[0]!.lastMessage.direction, "INBOUND", `${label}: newest message is the customer's reply`);
        assert.equal(list.items[0]!.unreadCount, 1, `${label}: unread count covers the incoming reply`);
        // history: template then reply
        const history = await w.svc.listMessages(me, { page: 1, pageSize: 50, leadId: w.lead });
        assert.deepEqual(history.items.map((m) => m.direction).sort(), ["INBOUND", "OUTBOUND"], `${label}: history has the template and the reply`);
        // single message + conversation detail: same rule, no "not found"
        assert.equal((await w.svc.getMessage(me, replyRow.id)).id, replyRow.id, `${label}: message detail opens`);
        assert.equal((await w.conv.viewConversationDetail(me, w.lead)).leadId, w.lead, `${label}: conversation opens`);
      }
    });
  });

  it("opening a conversation marks it read for everyone viewing it, so the unread count stays consistent; pagination is unaffected", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.recordInboundMessage("META", w.inbound(`wamid-in-${uid()}`, "one"));
      await w.svc.recordInboundMessage("META", w.inbound(`wamid-in-${uid()}`, "two"));
      const me = as(w.repB, Role.SALESPERSON);
      assert.equal((await w.svc.listConversations(me, { page: 1, pageSize: 100, search: w.tag })).items[0]!.unreadCount, 2);
      await w.conv.markRead(me, w.lead);
      assert.equal((await w.svc.listConversations(as(w.admin, Role.ADMIN), { page: 1, pageSize: 100, search: w.tag })).items[0]!.unreadCount, 0);
      const p1 = await w.svc.listMessages(me, { page: 1, pageSize: 1, leadId: w.lead });
      const p2 = await w.svc.listMessages(me, { page: 2, pageSize: 1, leadId: w.lead });
      assert.deepEqual([p1.items.length, p2.items.length, p1.pagination.totalItems], [1, 1, 2]);
      assert.notEqual(p1.items[0]!.id, p2.items[0]!.id);
    });
  });

  it("a duplicate provider delivery still stores exactly one message and one conversation", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const id = `wamid-in-${uid()}`;
      await w.svc.recordInboundMessage("META", w.inbound(id, "hello"));
      await w.svc.recordInboundMessage("META", w.inbound(id, "hello"));
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: id } }), 1);
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: w.lead } }), 1);
      const list = await w.svc.listConversations(as(w.repB, Role.SALESPERSON), { page: 1, pageSize: 100, search: w.tag });
      assert.equal(list.items.length, 1);
    });
  });

  it("HR still sees no WhatsApp conversations or messages", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.recordInboundMessage("META", w.inbound(`wamid-in-${uid()}`, "hi"));
      const me = as(w.hr, Role.HR);
      assert.equal((await w.svc.listConversations(me, { page: 1, pageSize: 100, search: w.tag })).items.length, 0);
      assert.equal((await w.svc.listMessages(me, { page: 1, pageSize: 50, leadId: w.lead })).items.length, 0);
      await notFound(w.conv.viewConversationDetail(me, w.lead));
    });
  });
});

describe("WhatsApp inbox: seeing a conversation grants no action, and other scopes are unchanged", () => {
  it("assign, archive, order-draft confirm gating and sending to another team's customer are still refused exactly as before", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.svc.recordInboundMessage("META", w.inbound(`wamid-in-${uid()}`, "hi"));
      for (const [, user, role] of VIEWERS(w).slice(1)) {
        const me = as(user, role);
        if (role === Role.SALESPERSON) await notFound(w.conv.assignConversation(me, w.lead, { userId: user.id })); // admin/manager reassignment is unscoped by design (existing rule, unchanged)
        await notFound(w.conv.archiveConversation(me, w.lead));
        await notFound(w.conv.getConversationDetail(me, w.lead)); // the SCOPED check that confirmOrderDraft (an action) relies on
        await notFound(w.svc.sendTemplateMessage(me, { leadId: w.lead, templateName: "order_approval", params: [] } as never));
      }
      // the owning rep and the owning team's manager are unaffected
      assert.equal((await w.conv.getConversationDetail(as(w.repA, Role.SALESPERSON), w.lead)).leadId, w.lead);
      assert.equal((await w.conv.getConversationDetail(as(w.mgrA, Role.MANAGER), w.lead)).leadId, w.lead);
      assert.equal((await w.conv.getConversationDetail(as(w.admin, Role.ADMIN), w.lead)).leadId, w.lead);
    });
  });

  it("customer scoping is unchanged: another team's salesperson still cannot open the Customer 360 of that lead", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await tx.lead.update({ where: { id: w.lead }, data: { lifecycleStage: "CUSTOMER" } });
      const customers = new CustomersService(tx);
      await notFound(customers.getCustomer360(as(w.repB, Role.SALESPERSON), w.lead));
      assert.equal((await customers.getCustomer360(as(w.repA, Role.SALESPERSON), w.lead)).profile.leadId, w.lead);
    });
  });
});
