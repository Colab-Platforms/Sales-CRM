// Database integration tests for the WhatsApp inbound-reply threading fix. Run with: npm run test:db
//
// Two independent bugs could both split a customer's WhatsApp Inbox conversation in two:
//  1. A DATA-FORMAT bug: matchSenderToLead did an exact string match against Lead.normalizedMobile,
//     so a lead whose stored value predated consistent normalizeMobile() use (e.g. missing the
//     leading "+", or in some other legacy shape) silently failed to match a perfectly normal inbound
//     reply - see whatsapp.matching.ts and whatsapp.matching.test.ts for the unit-level coverage.
//  2. A RACE-CONDITION bug: match -> create-if-unmatched -> get-or-create-conversation ran as
//     separate, unguarded steps against the database, so two inbound messages for the same brand-new
//     number arriving close together could each see "no existing lead" and each create one.
// This file exercises both, end to end, through the real WhatsAppService.recordInboundMessage - the
// exact method the Meta/AiSensy/Gupshup webhook processor calls for every inbound message.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { AuthUser } from "@/middlewares/auth.js";
import LeadService from "../lead/lead.service.js";
import WhatsAppService from "./whatsapp.service.js";
import type { NormalizedIncomingMessage } from "./whatsapp.provider.js";

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

function inbound(overrides: Partial<NormalizedIncomingMessage> & { providerMessageId: string; from: string }): NormalizedIncomingMessage {
  return { to: null, messageType: "TEXT", text: "Hello", timestamp: new Date(), ...overrides };
}

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Test", lastName: "Customer", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true, normalizedMobile: true },
  });
}

describe("WhatsApp inbound threading: existing lead + outbound history, various stored phone formats", () => {
  it("existing lead + outbound template already sent + inbound reply -> lands in the SAME lead/conversation, never a second one", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { normalizedMobile: "+919812300001" });
      // Simulate a template already sent before the reply arrives (real messaging.service.ts writes
      // rows like this - reproduced directly here to isolate the inbound path being tested).
      await tx.whatsAppMessage.create({
        data: { provider: "META", providerMessageId: `wamid-out-${uid()}`, direction: "OUTBOUND", messageType: "TEMPLATE", status: "READ", leadId: lead.id, toNumber: lead.normalizedMobile, normalizedContact: lead.normalizedMobile, templateName: "webinar_feedback_form", body: "Thanks for attending!" },
      });

      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound({ providerMessageId: `wamid-in-${uid()}`, from: "919812300001", text: "more info" }));

      assert.equal(await tx.lead.count({ where: { normalizedMobile: "+919812300001" } }), 1, "no duplicate lead was created");
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: lead.id } }), 1, "exactly one conversation for this lead");
      const reply = await tx.whatsAppMessage.findFirstOrThrow({ where: { leadId: lead.id, direction: "INBOUND" } });
      assert.equal(reply.body, "more info");
      const outbound = await tx.whatsAppMessage.findFirstOrThrow({ where: { leadId: lead.id, direction: "OUTBOUND" } });
      assert.equal(outbound.leadId, reply.leadId, "outbound and inbound share the same lead - one thread, not two");
    });
  });

  it("lead stored with '+91' + inbound arrives as digits-only (no +) -> matches the SAME lead", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { normalizedMobile: "+919812300002" });
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound({ providerMessageId: `wamid-${uid()}`, from: "919812300002" }));
      const stored = await tx.whatsAppMessage.findFirstOrThrow({ where: { direction: "INBOUND", normalizedContact: "+919812300002" }, select: { leadId: true } });
      assert.equal(stored.leadId, lead.id);
      assert.equal(await tx.lead.count({ where: { normalizedMobile: { in: ["+919812300002", "919812300002"] } } }), 1);
    });
  });

  // The exact bug pattern that actually split Komal vini's and Ritika BD's real conversations in
  // production: a lead's normalizedMobile legacy-stored WITHOUT the leading "+".
  it("lead stored WITHOUT the leading '+' (legacy data) + inbound arrives normalized with '+91' -> matches the SAME lead, never creates a duplicate", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { normalizedMobile: "919812300003" }); // legacy shape, exactly as found in production
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound({ providerMessageId: `wamid-${uid()}`, from: "+91 98123 00003" }));
      const stored = await tx.whatsAppMessage.findFirstOrThrow({ where: { direction: "INBOUND", normalizedContact: "+919812300003" }, select: { leadId: true } });
      assert.equal(stored.leadId, lead.id, "must attach to the existing lead, never a new duplicate one");
      assert.equal(await tx.lead.count({ where: { normalizedMobile: { in: ["+919812300003", "919812300003"] } } }), 1);
    });
  });

  it("lead stored with spaces/hyphens in the raw mobile + inbound arrives fully normalized -> matches the SAME lead", async () => {
    await inRollback(async (tx) => {
      // mobile (display) is messy; normalizedMobile is what matching actually keys on - already
      // canonical here, proving the inbound side normalizes consistently regardless of formatting noise.
      const lead = await makeLead(tx, { mobile: "+91 98123-00004", normalizedMobile: "+919812300004" });
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound({ providerMessageId: `wamid-${uid()}`, from: "(91)-9812-300004" }));
      const stored = await tx.whatsAppMessage.findFirstOrThrow({ where: { direction: "INBOUND", normalizedContact: "+919812300004" }, select: { leadId: true } });
      assert.equal(stored.leadId, lead.id);
    });
  });

  it("an existing WhatsAppConversation for the lead is reused, not replaced by a second one, on a later reply", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { normalizedMobile: "+919812300005" });
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound({ providerMessageId: `wamid-a-${uid()}`, from: "919812300005", text: "first" }));
      const conversationAfterFirst = await tx.whatsAppConversation.findUniqueOrThrow({ where: { leadId: lead.id } });

      await svc.recordInboundMessage("META", inbound({ providerMessageId: `wamid-b-${uid()}`, from: "919812300005", text: "second" }));
      const conversationAfterSecond = await tx.whatsAppConversation.findUniqueOrThrow({ where: { leadId: lead.id } });

      assert.equal(conversationAfterSecond.id, conversationAfterFirst.id, "the same conversation row, not a new one");
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: lead.id } }), 1);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id, direction: "INBOUND" } }), 2);
    });
  });

  it("no existing lead at all -> creates exactly one new lead and exactly one conversation", async () => {
    await inRollback(async (tx) => {
      const brandNewNumber = `9${Date.now()}`.slice(0, 10);
      const svc = new WhatsAppService(tx);
      await svc.recordInboundMessage("META", inbound({ providerMessageId: `wamid-${uid()}`, from: brandNewNumber }));

      const leads = await tx.lead.findMany({ where: { normalizedMobile: `+91${brandNewNumber}` }, select: { id: true } });
      assert.equal(leads.length, 1, "exactly one new lead");
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: leads[0]!.id } }), 1, "exactly one new conversation");
    });
  });

  it("a duplicate webhook delivery (same providerMessageId) never creates a duplicate lead, conversation, or message", async () => {
    await inRollback(async (tx) => {
      const brandNewNumber = `9${Date.now()}`.slice(0, 10);
      const svc = new WhatsAppService(tx);
      const msg = inbound({ providerMessageId: `wamid-dup-${uid()}`, from: brandNewNumber });

      await svc.recordInboundMessage("META", msg);
      await svc.recordInboundMessage("META", msg); // exact repeat delivery
      await svc.recordInboundMessage("META", msg); // and again, for good measure

      const leads = await tx.lead.findMany({ where: { normalizedMobile: `+91${brandNewNumber}` }, select: { id: true } });
      assert.equal(leads.length, 1);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: leads[0]!.id } }), 1);
      assert.equal(await tx.whatsAppConversation.count({ where: { leadId: leads[0]!.id } }), 1);
    });
  });
});

// Genuine concurrency cannot be exercised inside the shared single-connection inRollback transaction
// every other test in this file uses (Postgres serializes statements on one connection anyway, which
// would hide the exact race this is meant to catch) - this uses the real `prisma` client directly (a
// real connection pool, matching how the webhook route actually constructs WhatsAppService in
// production), with real commits, and cleans up everything it created itself afterward.
describe("WhatsApp inbound threading: concurrent delivery of two different messages for the same brand-new number", () => {
  it("two DIFFERENT inbound messages for the same never-before-seen number, processed concurrently, create exactly one lead and one conversation - never two", async () => {
    const brandNewNumber = `9${Date.now()}`.slice(0, 10);
    const canonical = `+91${brandNewNumber}`;
    const svcA = new WhatsAppService(prisma);
    const svcB = new WhatsAppService(prisma);

    try {
      await Promise.all([
        svcA.recordInboundMessage("META", inbound({ providerMessageId: `wamid-race-a-${uid()}`, from: brandNewNumber, text: "Hi" })),
        svcB.recordInboundMessage("META", inbound({ providerMessageId: `wamid-race-b-${uid()}`, from: brandNewNumber, text: "there" })),
      ]);

      const leads = await prisma.lead.findMany({ where: { normalizedMobile: canonical }, select: { id: true } });
      assert.equal(leads.length, 1, "the advisory-lock-guarded transaction must serialize this, not race into two leads");
      const leadId = leads[0]!.id;

      const messages = await prisma.whatsAppMessage.findMany({ where: { leadId }, select: { body: true } });
      assert.equal(messages.length, 2, "both real messages are still recorded");

      assert.equal(await prisma.whatsAppConversation.count({ where: { leadId } }), 1, "exactly one conversation, never two");
    } finally {
      // Real commits (not a rolled-back transaction) - clean up everything this test created, exactly
      // like the CRM's own "Delete Customer" cleanup, so the dev database is left as it was found.
      const leads = await prisma.lead.findMany({ where: { normalizedMobile: canonical }, select: { id: true } });
      for (const l of leads) {
        await prisma.whatsAppMessage.deleteMany({ where: { leadId: l.id } });
        await prisma.whatsAppConversation.deleteMany({ where: { leadId: l.id } });
        await prisma.activity.deleteMany({ where: { leadId: l.id } });
        await prisma.lead.delete({ where: { id: l.id } });
      }
    }
  });
});

// Regression: reproduces the exact "Ankit Manager" bug class live-caught in production. Root cause
// was NOT the matching function (which was already correct) - it was that LeadService.createLead
// (the "Create Contact" button's own backend path) imported normalizeMobile from a second, divergent
// implementation (@/utils/normalize.js: strips non-digits only, never adds "+", never infers the
// default country code) instead of the canonical @/lib/leadIdentity.js every other identity lookup
// in the codebase agrees on. A contact created this way got a non-canonical normalizedMobile with no
// self-correction step (unlike WhatsApp-inbound-created leads, which whatsapp.service.ts already
// re-aligns right after creation) - manufacturing exactly the kind of "legacy-format" data the
// matching-side tolerance was built to work around, forever, for every single new contact. Fixed by
// consolidating on one canonical normalizer (lead.service.ts now imports from leadIdentity.js) -
// this test proves a lead created via the real Create Contact path now gets a canonical
// normalizedMobile, and that a real inbound reply for it threads into the SAME lead/conversation.
describe("WhatsApp inbound threading: a contact created via the real 'Create Contact' path (LeadService.createLead)", () => {
  it("gets a canonical normalizedMobile, and a real inbound reply threads into the SAME lead - never a duplicate", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { role: Role.ADMIN }, select: { id: true, username: true, role: true } });
    const leadService = new LeadService();
    const whatsapp = new WhatsAppService(prisma);
    const brandNewNumber = `8${Date.now()}`.slice(0, 10);
    const canonical = `+91${brandNewNumber}`;
    // Exactly how a human types it into the Create Contact form: "+91 XXXXX XXXXX".
    const prettyMobile = `+91 ${brandNewNumber.slice(0, 5)} ${brandNewNumber.slice(5)}`;

    try {
      const created = await leadService.createLead(admin as AuthUser, { firstName: "Ankit", lastName: "TestManager", mobile: prettyMobile });
      const createdLead = await prisma.lead.findUniqueOrThrow({ where: { id: created.id }, select: { id: true, normalizedMobile: true } });
      assert.equal(createdLead.normalizedMobile, canonical, "Create Contact must produce the SAME canonical form matchSenderToLead looks for - not a divergent one");

      await whatsapp.recordInboundMessage("META", inbound({ providerMessageId: `wamid-createcontact-${uid()}`, from: brandNewNumber, text: "hello" }));

      const leads = await prisma.lead.findMany({ where: { normalizedMobile: canonical }, select: { id: true } });
      assert.equal(leads.length, 1, "no duplicate lead was created for the reply");
      assert.equal(leads[0]!.id, created.id, "the reply must attach to the contact Create Contact just made, not a new one");

      assert.equal(await prisma.whatsAppConversation.count({ where: { leadId: created.id } }), 1, "exactly one conversation");
      const inboundMsg = await prisma.whatsAppMessage.findFirstOrThrow({ where: { leadId: created.id, direction: "INBOUND" }, select: { body: true } });
      assert.equal(inboundMsg.body, "hello");
    } finally {
      const leads = await prisma.lead.findMany({ where: { normalizedMobile: canonical }, select: { id: true } });
      for (const l of leads) {
        await prisma.whatsAppMessage.deleteMany({ where: { leadId: l.id } });
        await prisma.whatsAppConversation.deleteMany({ where: { leadId: l.id } });
        await prisma.activity.deleteMany({ where: { leadId: l.id } });
        await prisma.lead.delete({ where: { id: l.id } });
      }
    }
  });
});
