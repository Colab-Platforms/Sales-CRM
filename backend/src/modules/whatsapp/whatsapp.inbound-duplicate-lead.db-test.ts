// Database tests: a customer's reply must land in the thread the CRM was talking to them in, even when the same phone number sits on more than one lead.
//
// The reported bug: the CRM sent an approval template from a lead, the customer replied, and the reply never showed in that conversation. Real data showed why - the reply was attached
// to a DIFFERENT, older lead that has the same number (the matcher always took the oldest lead), which a salesperson/manager scoped to the sending lead cannot see.
// Run with: npm run test:db. Rolled-back transaction only; no provider is called.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";
import WhatsAppService from "./whatsapp.service.js";
import type { NormalizedIncomingMessage } from "./whatsapp.provider.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const PHONE = "+919812377001";
const inbound = (id: string, text = "Yes, approved"): NormalizedIncomingMessage => ({ providerMessageId: id, from: "919812377001", to: null, messageType: "TEXT", text, timestamp: new Date() });

async function makeLead(tx: Prisma.TransactionClient, over: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Dup", lastName: "Customer", mobile: "9812377001", normalizedMobile: PHONE, ...over }, select: { id: true } });
}
const sentTemplate = (tx: Prisma.TransactionClient, leadId: string, createdAt: Date, contact: string | null = PHONE) =>
  tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `wamid-out-${uid()}`, direction: "OUTBOUND", messageType: "TEMPLATE", status: "DELIVERED", leadId, toNumber: PHONE, normalizedContact: contact, templateName: "order_approval", createdAt } });
const as = (u: { id: string; username: string }, role: Role): AuthUser => ({ id: u.id, username: u.username, role }) as AuthUser;

describe("WhatsApp inbound reply with the same phone number on more than one lead", () => {
  it("the reply lands on the lead the approval template was SENT from (not the oldest lead with that number), in the same conversation, visible to that lead's owner", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true } });
      const older = await makeLead(tx, { createdAt: new Date("2026-09-29T10:00:00Z") }); // unowned, the one the old matcher always picked
      const newer = await makeLead(tx, { createdAt: new Date("2026-10-08T12:00:00Z"), ownerId: rep.id }); // the lead the template was sent from
      const sentAt = new Date(Date.now() - 60_000);
      await sentTemplate(tx, newer.id, sentAt);

      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound(`wamid-in-${uid()}`));

      const reply = await tx.whatsAppMessage.findFirstOrThrow({ where: { direction: "INBOUND", normalizedContact: PHONE } });
      assert.equal(reply.leadId, newer.id, "attached to the lead that sent the template");
      assert.equal(reply.body, "Yes, approved");
      assert.equal(reply.status, "RECEIVED");
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: older.id } }), 0, "nothing is put on the unrelated older lead");
      assert.equal(await tx.lead.count({ where: { normalizedMobile: PHONE } }), 2, "no third lead is invented");
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: newer.id } }), 1);

      // The Inbox for the lead's owner shows ONE thread whose newest message is the customer's reply, right after the template.
      const list = await svc.listConversations(as(rep, Role.SALESPERSON), { page: 1, pageSize: 50 });
      const mine = list.items.find((i) => i.leadId === newer.id);
      assert.ok(mine, "the sending lead's conversation is in the owner's Inbox");
      assert.equal(mine!.lastMessage.direction, "INBOUND");
      assert.equal(list.items.some((i) => i.leadId === older.id), false, "the owner is not shown the unrelated lead's conversation");
      const thread = await tx.whatsAppMessage.findMany({ where: { leadId: newer.id }, orderBy: { createdAt: "asc" }, select: { direction: true, messageType: true } });
      assert.deepEqual(thread.map((m) => `${m.direction}:${m.messageType}`), ["OUTBOUND:TEMPLATE", "INBOUND:TEXT"]);
    });
  });

  it("a duplicate provider delivery of the same reply never creates a second message, lead or conversation", async () => {
    await inRollback(async (tx) => {
      await makeLead(tx, { createdAt: new Date("2026-09-29T10:00:00Z") });
      const newer = await makeLead(tx, { createdAt: new Date("2026-10-08T12:00:00Z") });
      await sentTemplate(tx, newer.id, new Date(Date.now() - 60_000));
      const svc = new WhatsAppService(tx);
      const id = `wamid-in-${uid()}`;
      await svc.recordInboundMessage("META", inbound(id));
      await svc.recordInboundMessage("META", inbound(id));
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: id } }), 1);
      assert.equal(await tx.lead.count({ where: { normalizedMobile: PHONE } }), 2);
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: newer.id } }), 1);
    });
  });

  it("the MOST RECENT send decides the thread: after a template goes out from the older lead, the next reply follows it", async () => {
    await inRollback(async (tx) => {
      const older = await makeLead(tx, { createdAt: new Date("2026-09-29T10:00:00Z") });
      const newer = await makeLead(tx, { createdAt: new Date("2026-10-08T12:00:00Z") });
      await sentTemplate(tx, newer.id, new Date(Date.now() - 120_000));
      await sentTemplate(tx, older.id, new Date(Date.now() - 30_000));
      await new WhatsAppService(tx).recordInboundMessage("META", inbound(`wamid-in-${uid()}`));
      assert.equal((await tx.whatsAppMessage.findFirstOrThrow({ where: { direction: "INBOUND", normalizedContact: PHONE } })).leadId, older.id);
    });
  });

  it("an outbound row whose contact was stored in the legacy 10-digit shape still anchors the thread", async () => {
    await inRollback(async (tx) => {
      await makeLead(tx, { createdAt: new Date("2026-09-29T10:00:00Z") });
      const newer = await makeLead(tx, { createdAt: new Date("2026-10-08T12:00:00Z") });
      await sentTemplate(tx, newer.id, new Date(Date.now() - 60_000), "9812377001");
      await new WhatsAppService(tx).recordInboundMessage("META", inbound(`wamid-in-${uid()}`));
      assert.equal((await tx.whatsAppMessage.findFirstOrThrow({ where: { direction: "INBOUND", normalizedContact: PHONE } })).leadId, newer.id);
    });
  });

  it("with no outbound history the oldest matching lead is still used (unchanged behaviour), and an unknown number still creates exactly one lead", async () => {
    await inRollback(async (tx) => {
      const older = await makeLead(tx, { createdAt: new Date("2026-09-29T10:00:00Z") });
      await makeLead(tx, { createdAt: new Date("2026-10-08T12:00:00Z") });
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound(`wamid-in-${uid()}`));
      assert.equal((await tx.whatsAppMessage.findFirstOrThrow({ where: { direction: "INBOUND", normalizedContact: PHONE } })).leadId, older.id);

      await svc.recordInboundMessage("META", { ...inbound(`wamid-in-${uid()}`), from: "919812377999" });
      assert.equal(await tx.lead.count({ where: { normalizedMobile: "+919812377999" } }), 1);
    });
  });
});
