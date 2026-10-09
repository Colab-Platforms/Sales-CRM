// Database tests: one Inbox conversation per customer phone, a conversation that always opens (with its own contact), and the company-wide reply policy.
// Run with: npm run test:db. Rolled-back transaction only; no provider is called, nothing is sent.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import WhatsAppService from "./whatsapp.service.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";
import { loadInboxLead } from "./whatsapp.conversation.controller.js";
import { siblingLeadIds } from "./whatsapp.matching.js";
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

async function setup(tx: Prisma.TransactionClient) {
  const tag = `Dup${uid().slice(0, 8)}`;
  const mk = (role: Role, name: string) => tx.user.create({ data: { name, username: `u-${uid()}`, role }, select: { id: true, username: true } });
  const admin = await mk(Role.ADMIN, "Admin");
  const mgrA = await mk(Role.MANAGER, "MgrA");
  const mgrB = await mk(Role.MANAGER, "MgrB");
  const repA = await mk(Role.SALESPERSON, "RepA");
  const repB = await mk(Role.SALESPERSON, "RepB");
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: mgrA.id }, select: { id: true } });
  await tx.groupMember.create({ data: { groupId: group.id, userId: repA.id, joinedAt: new Date(), isActive: true } });
  const lead = (over: Partial<Prisma.LeadUncheckedCreateInput>) => tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: tag, lastName: "Customer", ...over }, select: { id: true } });
  const msg = (leadId: string, direction: "INBOUND" | "OUTBOUND", at: Date, contact = "+919812399001") =>
    tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `wamid-${uid()}`, direction, messageType: "TEXT", status: direction === "INBOUND" ? "RECEIVED" : "SENT", leadId, normalizedContact: contact, body: direction, createdAt: at }, select: { id: true } });
  return { tag, admin, mgrA, mgrB, repA, repB, group, lead, msg, svc: new WhatsAppService(tx), conv: new WhatsAppConversationService(tx) };
}
const inbound = (id: string, from = "919812399001"): NormalizedIncomingMessage => ({ providerMessageId: id, from, to: null, messageType: "TEXT", text: "hi", timestamp: new Date() });

describe("one Inbox conversation per customer phone", () => {
  it("two leads with the same phone (even stored in different shapes) show as ONE row: newest message, unread summed, both threads read together", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const older = await w.lead({ mobile: "9812399001", normalizedMobile: "9812399001", createdAt: new Date("2026-09-29T10:00:00Z") }); // legacy 10-digit shape
      const newer = await w.lead({ mobile: "9812399001", normalizedMobile: "+919812399001", createdAt: new Date("2026-10-08T10:00:00Z"), ownerId: w.repA.id, groupId: w.group.id });
      const t0 = Date.now() - 600_000;
      await w.msg(older.id, "INBOUND", new Date(t0));
      await w.msg(newer.id, "OUTBOUND", new Date(t0 + 60_000));
      const last = await w.msg(newer.id, "INBOUND", new Date(t0 + 120_000));

      for (const [u, role] of [[w.admin, Role.ADMIN], [w.mgrB, Role.MANAGER], [w.repB, Role.SALESPERSON]] as const) {
        const rows = (await w.svc.listConversations(as(u, role), { page: 1, pageSize: 100, search: w.tag })).items;
        assert.equal(rows.length, 1, `${role}: one row for the phone, not one per lead`);
        assert.equal(rows[0]!.leadId, newer.id, "the lead of the newest message represents the customer");
        assert.equal(rows[0]!.lastMessage.id, last.id);
        assert.equal(rows[0]!.unreadCount, 2, "unread covers both leads' inbound messages");
      }
      // opening the conversation reads the whole thread (both leads) and clears the unread count for the customer
      const me = as(w.repB, Role.SALESPERSON);
      const thread = await w.svc.listMessages(me, { page: 1, pageSize: 50, leadId: newer.id });
      assert.equal(thread.items.length, 3, "history of the customer's phone, across both leads");
      assert.equal((await w.conv.viewConversationDetail(me, newer.id)).unreadCount, 2);
      await w.conv.markRead(me, newer.id);
      assert.equal((await w.svc.listConversations(as(w.admin, Role.ADMIN), { page: 1, pageSize: 100, search: w.tag })).items[0]!.unreadCount, 0);
    });
  });

  it("different phones are never merged, even for customers with the same name", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const a = await w.lead({ mobile: "9812399001", normalizedMobile: "+919812399001" });
      const b = await w.lead({ mobile: "9812399002", normalizedMobile: "+919812399002" });
      await w.msg(a.id, "INBOUND", new Date());
      await w.msg(b.id, "INBOUND", new Date(), "+919812399002");
      const rows = (await w.svc.listConversations(as(w.admin, Role.ADMIN), { page: 1, pageSize: 100, search: w.tag })).items;
      assert.deepEqual(rows.map((r) => r.leadId).sort(), [a.id, b.id].sort());
      assert.deepEqual((await siblingLeadIds(tx, a.id)), [a.id]);
    });
  });

  it("a reply from a number that already has leads reuses the conversation instead of creating another; a duplicate delivery adds nothing", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const lead = await w.lead({ mobile: "9812399001", normalizedMobile: "+919812399001" });
      await w.msg(lead.id, "OUTBOUND", new Date(Date.now() - 60_000));
      const id = `wamid-in-${uid()}`;
      await w.svc.recordInboundMessage("META", inbound(id));
      await w.svc.recordInboundMessage("META", inbound(id));
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: id } }), 1);
      assert.equal(await tx.lead.count({ where: { normalizedMobile: { in: ["+919812399001", "9812399001", "919812399001"] } } }), 1);
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: lead.id } }), 1);
      assert.equal((await w.svc.listConversations(as(w.admin, Role.ADMIN), { page: 1, pageSize: 100, search: w.tag })).items.length, 1);
    });
  });
});

describe("a conversation always opens, with its own contact, and cross-team replies are allowed", () => {
  it("the conversation detail carries the contact (name, phone) for every viewer, including an unknown WhatsApp number that became a lead named after its phone", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      await w.svc.recordInboundMessage("META", inbound(`wamid-in-${uid()}`, "919812399777")); // brand-new number
      const created = await tx.lead.findFirstOrThrow({ where: { normalizedMobile: "+919812399777" }, select: { id: true } });
      for (const [u, role] of [[w.admin, Role.ADMIN], [w.mgrB, Role.MANAGER], [w.repB, Role.SALESPERSON]] as const) {
        const detail = await w.conv.viewConversationDetail(as(u, role), created.id);
        assert.ok(detail.contact, `${role}: contact present`);
        assert.match(detail.contact!.mobile ?? "", /9812399777/);
        assert.ok(detail.contact!.name.length > 0, "a usable display name (the phone number) rather than an error");
      }
    });
  });

  it("admin, manager and salesperson may reply to ANOTHER team's conversation; an out-of-scope role may not; a missing lead is a clear 404", async () => {
    await inRollback(async (tx) => {
      const w = await setup(tx);
      const lead = await w.lead({ mobile: "9812399001", normalizedMobile: "+919812399001", ownerId: w.repA.id, groupId: w.group.id });
      for (const [u, role] of [[w.admin, Role.ADMIN], [w.mgrB, Role.MANAGER], [w.repB, Role.SALESPERSON], [w.mgrA, Role.MANAGER], [w.repA, Role.SALESPERSON]] as const) {
        assert.equal((await loadInboxLead(as(u, role), lead.id, tx)).id, lead.id, `${role} can reach the conversation to reply`);
      }
      await notFound(loadInboxLead(as({ id: uid(), username: "hr" }, Role.HR), lead.id, tx)); // HR keeps the normal (empty) scope
      await notFound(loadInboxLead(as(w.repB, Role.SALESPERSON), uid(), tx));
      await w.conv.getOrCreateConversation(lead.id, "META");
      // replying does not widen archive / assign / order-draft: those still use the scoped check
      await notFound(w.conv.archiveConversation(as(w.repB, Role.SALESPERSON), lead.id));
      await notFound(w.conv.getConversationDetail(as(w.mgrB, Role.MANAGER), lead.id));
    });
  });
});
