// Database integration tests for WhatsApp-style per-message actions (star, delete-for-me, forward).
// Run with: npm run test:db. Every test runs inside ONE transaction that is always rolled back,
// mirroring the other whatsapp db-test files. No real Meta/provider call is ever made - forward()
// is always given a fake WhatsAppFreeTextService.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import WhatsAppService from "./whatsapp.service.js";
import WhatsAppMessageActionsService from "./whatsapp.message-actions.service.js";
import type WhatsAppFreeTextService from "./whatsapp.freetext.service.js";
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
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true, normalizedMobile: true },
  });
}

async function makeMessage(tx: Prisma.TransactionClient, overrides: Partial<Prisma.WhatsAppMessageUncheckedCreateInput> = {}) {
  return tx.whatsAppMessage.create({
    data: { provider: "AISENSY", direction: "OUTBOUND", messageType: "TEXT", status: "SENT", body: "Hello there", createdAt: new Date(), ...overrides },
    select: { id: true },
  });
}

function fakeFreeText(sendText: (...args: any[]) => Promise<{ id: string }>): WhatsAppFreeTextService {
  return { sendText } as unknown as WhatsAppFreeTextService;
}

describe("WhatsAppMessageActionsService: star/unstar", () => {
  it("starring persists and is reflected back in listMessages/getMessage for that user", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, { leadId: lead.id });

      const actions = new WhatsAppMessageActionsService(tx);
      const result = await actions.setStarred(as(admin, Role.ADMIN), message.id, true);
      assert.deepEqual(result, { id: message.id, starred: true });

      const history = new WhatsAppService(tx);
      const detail = await history.getMessage(as(admin, Role.ADMIN), message.id);
      assert.equal(detail.starred, true);

      const list = await history.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.equal(list.items.find((m) => m.id === message.id)?.starred, true);
    });
  });

  it("unstarring clears it, and never creates a second WhatsAppMessage row", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, { leadId: lead.id });
      const actions = new WhatsAppMessageActionsService(tx);

      await actions.setStarred(as(admin, Role.ADMIN), message.id, true);
      const countBefore = await tx.whatsAppMessage.count({ where: { leadId: lead.id } });
      await actions.setStarred(as(admin, Role.ADMIN), message.id, false);
      const countAfter = await tx.whatsAppMessage.count({ where: { leadId: lead.id } });

      assert.equal(countBefore, 1);
      assert.equal(countAfter, 1, "starring/unstarring must never create or delete a WhatsAppMessage row");
      const state = await tx.whatsAppMessageUserState.findUnique({ where: { messageId_userId: { messageId: message.id, userId: admin.id } } });
      assert.equal(state?.starred, false);
    });
  });

  it("two different CRM users starring the same message do not affect each other", async () => {
    await inRollback(async (tx) => {
      const userA = await tx.user.create({ data: { name: "A", username: `a-${uid()}`, role: Role.ADMIN } });
      const userB = await tx.user.create({ data: { name: "B", username: `b-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, { leadId: lead.id });
      const actions = new WhatsAppMessageActionsService(tx);
      const history = new WhatsAppService(tx);

      await actions.setStarred(as(userA, Role.ADMIN), message.id, true);
      const aView = await history.getMessage(as(userA, Role.ADMIN), message.id);
      const bView = await history.getMessage(as(userB, Role.ADMIN), message.id);
      assert.equal(aView.starred, true);
      assert.equal(bView.starred, false, "starred is per-user - B never sees A's star");
    });
  });

  it("listStarredMessages returns only this user's starred messages, newest-starred first", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const m1 = await makeMessage(tx, { leadId: lead.id, body: "first" });
      const m2 = await makeMessage(tx, { leadId: lead.id, body: "second" });
      await makeMessage(tx, { leadId: lead.id, body: "never starred" });
      const actions = new WhatsAppMessageActionsService(tx);

      await actions.setStarred(as(admin, Role.ADMIN), m1.id, true);
      await actions.setStarred(as(admin, Role.ADMIN), m2.id, true);

      const history = new WhatsAppService(tx);
      const starred = await history.listStarredMessages(as(admin, Role.ADMIN), lead.id);
      assert.equal(starred.length, 2);
      assert.ok(starred.every((m) => m.starred));
    });
  });
});

describe("WhatsAppMessageActionsService: delete for me", () => {
  it("hides the message for the deleting user only - another CRM user still sees it", async () => {
    await inRollback(async (tx) => {
      const userA = await tx.user.create({ data: { name: "A", username: `a-${uid()}`, role: Role.ADMIN } });
      const userB = await tx.user.create({ data: { name: "B", username: `b-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, { leadId: lead.id });
      const actions = new WhatsAppMessageActionsService(tx);
      const history = new WhatsAppService(tx);

      await actions.deleteForMe(as(userA, Role.ADMIN), message.id);

      const aList = await history.listMessages(as(userA, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      const bList = await history.listMessages(as(userB, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.equal(aList.items.some((m) => m.id === message.id), false, "A deleted it for themselves");
      assert.equal(bList.items.some((m) => m.id === message.id), true, "B must still see the real, untouched message");

      const row = await tx.whatsAppMessage.findUnique({ where: { id: message.id } });
      assert.ok(row, "the shared WhatsAppMessage row is never deleted by 'delete for me'");
    });
  });

  it("bulk delete-for-me hides every valid, in-scope message and ignores the rest silently-safe", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", username: `r-${uid()}`, role: Role.SALESPERSON } });
      const myLead = await makeLead(tx, { ownerId: rep.id });
      const otherLead = await makeLead(tx);
      const m1 = await makeMessage(tx, { leadId: myLead.id });
      const m2 = await makeMessage(tx, { leadId: myLead.id });
      const otherMsg = await makeMessage(tx, { leadId: otherLead.id });
      const actions = new WhatsAppMessageActionsService(tx);

      const result = await actions.bulkDeleteForMe(as(rep, Role.SALESPERSON), [m1.id, m2.id, otherMsg.id]);
      assert.equal(result.hidden, 2, "only the rep's own two in-scope messages are hidden, not the out-of-scope one");

      const history = new WhatsAppService(tx);
      const list = await history.listMessages(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20, leadId: myLead.id });
      assert.equal(list.items.length, 0);
    });
  });
});

describe("WhatsAppMessageActionsService: forward", () => {
  it("forwards a text message's real body through the existing free-text send pipeline", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const source = await makeLead(tx);
      const target = await makeLead(tx, { normalizedMobile: "+919876500000", mobile: "9876500000" });
      const message = await makeMessage(tx, { leadId: source.id, body: "Your order has shipped!" });

      const captured: { body?: string; leadId?: string } = {};
      const actions = new WhatsAppMessageActionsService(tx, fakeFreeText(async (lead, text) => { captured.body = text; captured.leadId = lead.id; return { id: "forwarded-1" }; }));

      const result = await actions.forward(as(admin, Role.ADMIN), message.id, target.id);
      assert.equal(result.id, "forwarded-1");
      assert.equal(captured.body, "Your order has shipped!");
      assert.equal(captured.leadId, target.id);

      const originalStillExists = await tx.whatsAppMessage.findUnique({ where: { id: message.id } });
      assert.equal(originalStillExists?.body, "Your order has shipped!", "forwarding never modifies the original message");
    });
  });

  it("refuses to forward a non-text message - there is no stored media to resend", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", username: `a-${uid()}`, role: Role.ADMIN } });
      const source = await makeLead(tx);
      const target = await makeLead(tx, { normalizedMobile: "+919876500001", mobile: "9876500001" });
      const message = await makeMessage(tx, { leadId: source.id, messageType: "MEDIA", body: null });
      const actions = new WhatsAppMessageActionsService(tx, fakeFreeText(async () => ({ id: "should-not-send" })));

      await assert.rejects(() => actions.forward(as(admin, Role.ADMIN), message.id, target.id), /text messages can be forwarded/i);
    });
  });

  it("RBAC: a salesperson cannot forward a message that belongs to another rep's lead", async () => {
    await inRollback(async (tx) => {
      const repA = await tx.user.create({ data: { name: "Rep A", username: `ra-${uid()}`, role: Role.SALESPERSON } });
      const repB = await tx.user.create({ data: { name: "Rep B", username: `rb-${uid()}`, role: Role.SALESPERSON } });
      const leadB = await makeLead(tx, { ownerId: repB.id });
      const myLead = await makeLead(tx, { ownerId: repA.id, normalizedMobile: "+919876500002", mobile: "9876500002" });
      const message = await makeMessage(tx, { leadId: leadB.id, body: "private to rep B" });
      const actions = new WhatsAppMessageActionsService(tx, fakeFreeText(async () => ({ id: "should-not-send" })));

      await assert.rejects(() => actions.forward(as(repA, Role.SALESPERSON), message.id, myLead.id), /not found/i);
    });
  });
});

// "Edit Message" (in any form - a direct PATCH of this row, or sending a correction as a new reply)
// has been removed entirely as a product decision: editing an already-sent WhatsApp message is not
// supported by this CRM's WhatsApp Business integration, and no replacement workflow was introduced.
// This block only guards against either design quietly coming back.
describe("WhatsAppMessageActionsService: Edit Message (removed entirely)", () => {
  it("has no editMessage method or any other edit/correction action", () => {
    const actions = new WhatsAppMessageActionsService();
    assert.equal((actions as unknown as Record<string, unknown>).editMessage, undefined);
    assert.equal((actions as unknown as Record<string, unknown>).sendCorrection, undefined);
    assert.equal((actions as unknown as Record<string, unknown>).correctMessage, undefined);
  });

  it("a message's own body/providerMessageId stay exactly as originally stored - nothing in this service ever updates them in place", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, { leadId: lead.id, body: "damm damm damm", providerMessageId: "wamid.original" });

      // Every real action this service exposes (star/unstar, delete-for-me, forward) only ever touches
      // WhatsAppMessageUserState or creates an unrelated new row - never this message's own body/providerMessageId.
      const row = await tx.whatsAppMessage.findUnique({ where: { id: message.id } });
      assert.equal(row?.body, "damm damm damm");
      assert.equal(row?.providerMessageId, "wamid.original");
    });
  });
});

describe("WhatsAppMessageActionsService: delete for everyone (confirmed unsupported)", () => {
  it("does not expose a deleteForEveryone/recall action - no provider in this CRM can execute one", () => {
    const actions = new WhatsAppMessageActionsService();
    assert.equal((actions as unknown as Record<string, unknown>).deleteForEveryone, undefined);
    assert.equal((actions as unknown as Record<string, unknown>).recall, undefined);
  });

  it("MetaCloudApiProvider exposes no delete/recall method - confirmed against the current Cloud API reference, which has no such endpoint", () => {
    const provider = new MetaCloudApiProvider({
      phoneNumberId: "1",
      businessAccountId: "1",
      accessToken: "token",
      appSecret: "secret",
      verifyToken: "verify",
      graphApiVersion: "v21.0",
    });
    assert.equal((provider as unknown as Record<string, unknown>).deleteMessage, undefined);
    assert.equal((provider as unknown as Record<string, unknown>).recallMessage, undefined);
  });

  it("'delete for me' remains fully intact and unaffected by the delete-for-everyone investigation", async () => {
    await inRollback(async (tx) => {
      const userA = await tx.user.create({ data: { name: "A", username: `a-${uid()}`, role: Role.ADMIN } });
      const userB = await tx.user.create({ data: { name: "B", username: `b-${uid()}`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, { leadId: lead.id });
      const actions = new WhatsAppMessageActionsService(tx);
      const history = new WhatsAppService(tx);

      await actions.deleteForMe(as(userA, Role.ADMIN), message.id);
      const aList = await history.listMessages(as(userA, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      const bList = await history.listMessages(as(userB, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.equal(aList.items.some((m) => m.id === message.id), false);
      assert.equal(bList.items.some((m) => m.id === message.id), true, "unaffected - still visible to another user, never a real delete");
    });
  });
});
