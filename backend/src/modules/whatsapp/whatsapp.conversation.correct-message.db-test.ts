// "Correct Message" sends a real outbound reply through the EXACT SAME pipeline as plain "Reply" -
// sendConversationText's own resolveReplyToProviderMessageId() - so these tests exercise that shared
// resolution/RBAC boundary directly. No backend route or sending logic is new for this feature; see
// whatsapp.freetext.test.ts for the already-existing "Meta receives the real context.message_id"
// coverage at the provider-call level. Every test runs inside one rolled-back transaction - no real
// Meta/provider call is ever made, and no real customer data is touched.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { resolveReplyToProviderMessageId } from "./whatsapp.conversation.controller.js";

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

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true },
  });
}

async function makeMessage(tx: Prisma.TransactionClient, overrides: Partial<Prisma.WhatsAppMessageUncheckedCreateInput> = {}) {
  return tx.whatsAppMessage.create({
    data: { provider: "META", direction: "OUTBOUND", messageType: "TEXT", status: "SENT", body: "Your order amount is ₹999.", providerMessageId: `wamid.${uid()}`, createdAt: new Date(), ...overrides },
    select: { id: true },
  });
}

describe("Correct Message / Reply: resolveReplyToProviderMessageId", () => {
  it("resolves the real providerMessageId for a message inside the same conversation (the normal case)", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const original = await makeMessage(tx, { leadId: lead.id, providerMessageId: "wamid.original-1" });

      const resolved = await resolveReplyToProviderMessageId(lead.id, original.id, tx);
      assert.equal(resolved, "wamid.original-1");
    });
  });

  it("returns undefined when no reply target is given - a plain, non-reply send", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const resolved = await resolveReplyToProviderMessageId(lead.id, undefined, tx);
      assert.equal(resolved, undefined);
    });
  });

  it("the original message is never read as mutated or re-created by resolving it as a reply target", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const original = await makeMessage(tx, { leadId: lead.id, providerMessageId: "wamid.original-2", body: "Your order amount is ₹999." });

      await resolveReplyToProviderMessageId(lead.id, original.id, tx);

      const row = await tx.whatsAppMessage.findUnique({ where: { id: original.id } });
      assert.equal(row?.body, "Your order amount is ₹999.", "the original message body must remain exactly as sent - correction never edits it");
      const count = await tx.whatsAppMessage.count({ where: { leadId: lead.id } });
      assert.equal(count, 1, "resolving a reply target never creates a second copy of the original message");
    });
  });

  it("rejects a message id that belongs to a DIFFERENT lead's conversation - cannot correct/reply across conversations", async () => {
    await inRollback(async (tx) => {
      const myLead = await makeLead(tx);
      const otherLead = await makeLead(tx, { normalizedMobile: "+919876500099", mobile: "9876500099" });
      const otherMessage = await makeMessage(tx, { leadId: otherLead.id, providerMessageId: "wamid.other-conversation" });

      await assert.rejects(
        () => resolveReplyToProviderMessageId(myLead.id, otherMessage.id, tx),
        /not available to quote/i,
      );
    });
  });

  it("rejects a reply target with no real providerMessageId (e.g. still queued) - never fabricates one", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const queued = await makeMessage(tx, { leadId: lead.id, providerMessageId: null, status: "QUEUED" });

      await assert.rejects(
        () => resolveReplyToProviderMessageId(lead.id, queued.id, tx),
        /not available to quote/i,
      );
    });
  });

  it("rejects a non-existent message id", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await assert.rejects(() => resolveReplyToProviderMessageId(lead.id, randomUUID(), tx), /not available to quote/i);
    });
  });
});
