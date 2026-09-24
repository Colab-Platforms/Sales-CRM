// Database integration tests for AiSensy Project Webhook `message.status.updated` processing. Run
// with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - same convention as
// whatsapp.db-test.ts/whatsapp.messaging.db-test.ts. What's tested here is specifically the NEW
// integration: real captured AiSensy payload -> parseAiSensyMessageStatusUpdate -> a real
// WhatsAppMessage row. The underlying status-write rules themselves (monotonic rank, timestamp
// backfill, Activity creation) are whatsapp.service.ts's existing recordStatusUpdate() and are
// already exhaustively covered in whatsapp.db-test.ts's "delivery status updates" suite - not
// re-proven field-by-field here, only exercised through this new entry point.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { processAiSensyProjectWebhookEvent } from "./whatsapp.aisensy.webhook.processor.js";
import { AiSensyProvider } from "./whatsapp.aisensy.provider.js";
import { resolveWhatsAppConfig } from "./whatsapp.config.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import WhatsAppService from "./whatsapp.service.js";

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

// Deliberately NOT the real phone number this account has used for live end-to-end AiSensy testing
// (+919321614025, now a real committed Lead) - this is the same synthetic placeholder number
// whatsapp.db-test.ts/whatsapp.messaging.db-test.ts already use elsewhere, chosen specifically so
// these rolled-back-transaction tests never collide with real, already-committed production rows in
// this shared dev database.
async function makeLead(tx: Prisma.TransactionClient) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9876543210", normalizedMobile: "+919876543210" },
    select: { id: true },
  });
}

async function makeMessage(tx: Prisma.TransactionClient, leadId: string, providerMessageId: string, overrides: Partial<Prisma.WhatsAppMessageUncheckedCreateInput> = {}) {
  return tx.whatsAppMessage.create({
    data: {
      provider: "AISENSY",
      providerMessageId,
      direction: "OUTBOUND",
      messageType: "TEMPLATE",
      status: "QUEUED",
      leadId,
      toNumber: "+919321614025",
      normalizedContact: "+919321614025",
      templateName: "crm_order_confirmation",
      sentAt: null,
      ...overrides,
    },
    select: { id: true, status: true, sentAt: true, readAt: true },
  });
}

// The exact real payloads captured from this account's own AiSensy project (2026-09-22) - see the
// task that added this file. Never a fabricated shape.
const WAMID = "wamid.HBgMOTE5MzIxNjE0MDI1FQIAERgSNjhGREVCQTQ2RjdGMUU1NUQyAA==";

function realSentPayload(): Record<string, unknown> {
  return {
    id: "6ab27af6c0e602d3f99460ec",
    data: { message: { id: "6ab27af418d59a943d153073", status: "SENT", sent_at: 1790081781000, read_at: null, messageId: WAMID, phone_number: "919321614025" } },
    topic: "message.status.updated",
    created_at: "2026-09-22T12:56:27.308Z",
    project_id: "6a6088353b43790e9cbf6114",
  };
}

function realReadPayload(): Record<string, unknown> {
  return {
    id: "6ab27af7d6e40e29a25aea97",
    data: { message: { id: "6ab27af418d59a943d153073", status: "READ", sent_at: 1790081779530, read_at: 1790081781000, messageId: WAMID, phone_number: "919321614025" } },
    topic: "message.status.updated",
    created_at: "2026-09-22T12:56:24.550Z",
    project_id: "6a6088353b43790e9cbf6114",
  };
}

/** The exact same "record synchronously, process by id" shape the real handler/routes use. */
async function deliver(tx: Prisma.TransactionClient, payload: Record<string, unknown>, externalEventId: string, topic: string = "message.status.updated") {
  const store = createPrismaWebhookStore(tx, "AISENSY_PROJECT_WEBHOOK");
  const { id, duplicate } = await store.record({ eventType: topic, externalEventId, payload, ignored: false });
  if (duplicate) return { id, outcome: "duplicate-delivery" as const };
  const outcome = await processAiSensyProjectWebhookEvent(id, { store, db: tx });
  return { id, outcome };
}

// Same confirmed shape as the real inbound message.created delivery captured 2026-09-22 (sender
// "USER") - only messageId and phone_number are swapped for synthetic, run-unique values (see the
// makeLead comment above for why: that exact real messageId has since become a real committed
// WhatsAppMessage row in this shared dev database from live end-to-end testing, and reusing it here
// would make these tests silently read/match that real row instead of what each test creates).
const INBOUND_WAMID = `wamid.test-inbound-${uid()}`;
function realInboundMessageCreatedPayload(): Record<string, unknown> {
  return {
    id: "89400093-cdd5-48e6-a4b2-c23fa5aad244",
    data: {
      message: {
        id: "6ab27fae125cc1a4028e21d0",
        sender: "USER",
        messageId: INBOUND_WAMID,
        contact_id: "6a6452b80405540002a17805",
        project_id: "6a6088353b43790e9cbf6114",
        message_type: "TEXT",
        phone_number: "919876543210",
        sent_at: 1790082988000,
        message_content: { text: "Hello" },
      },
    },
    topic: "message.created",
    created_at: "2026-09-22T13:16:33.454Z",
    project_id: "6a6088353b43790e9cbf6114",
  };
}

function deliverCreated(tx: Prisma.TransactionClient, payload: Record<string, unknown>, externalEventId: string) {
  return deliver(tx, payload, externalEventId, "message.created");
}

describe("AiSensy message.status.updated - A/B: SENT and READ update a real CRM message", () => {
  it("A. a SENT update moves an existing message to SENT with the real sent_at timestamp", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID);

      const { outcome } = await deliver(tx, realSentPayload(), "delivery-1");
      assert.equal(outcome, "processed");

      const row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true, sentAt: true } });
      assert.equal(row.status, "SENT");
      assert.equal(row.sentAt?.getTime(), 1790081781000);
    });
  });

  it("B. a READ update moves an existing message to READ with the real read_at timestamp", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID, { status: "SENT", sentAt: new Date(1790081779530) });

      const { outcome } = await deliver(tx, realReadPayload(), "delivery-2");
      assert.equal(outcome, "processed");

      const row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true, readAt: true } });
      assert.equal(row.status, "READ");
      assert.equal(row.readAt?.getTime(), 1790081781000);

      const activity = await tx.activity.findFirst({ where: { type: ActivityType.WHATSAPP_READ, referenceId: message.id } });
      assert.ok(activity, "the existing Activity-on-READ behaviour still fires through this new entry point");
    });
  });
});

describe("AiSensy message.status.updated - C: duplicate delivery is idempotent", () => {
  it("processing the exact same delivery twice never re-applies or double-records", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID, { status: "SENT", sentAt: new Date(1790081779530) });

      const first = await deliver(tx, realReadPayload(), "delivery-dup");
      const second = await deliver(tx, realReadPayload(), "delivery-dup"); // identical externalEventId - a real AiSensy retry
      assert.equal(first.outcome, "processed");
      assert.equal(second.outcome, "duplicate-delivery"); // never even reaches the processor a second time

      assert.equal(await tx.whatsAppMessage.count({ where: { id: message.id } }), 1);
      assert.equal((await tx.activity.findMany({ where: { type: ActivityType.WHATSAPP_READ, referenceId: message.id } })).length, 1);
    });
  });

  it("a genuine second delivery (different id) that reports the SAME status change is a safe no-op, not a duplicate row", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID, { status: "SENT", sentAt: new Date(1790081779530) });

      await deliver(tx, realReadPayload(), "delivery-3a");
      const { outcome } = await deliver(tx, realReadPayload(), "delivery-3b"); // AiSensy resent under a new delivery id
      assert.equal(outcome, "processed"); // processed, but recordStatusUpdate's own idempotency means nothing new is written

      assert.equal(await tx.whatsAppMessage.count({ where: { id: message.id } }), 1);
      assert.equal((await tx.activity.findMany({ where: { type: ActivityType.WHATSAPP_READ, referenceId: message.id } })).length, 1, "the same READ transition is never audited twice");
    });
  });
});

describe("AiSensy message.status.updated - D: unmatched messageId", () => {
  it("stores the webhook event but creates no WhatsAppMessage", async () => {
    await inRollback(async (tx) => {
      const { outcome } = await deliver(tx, realSentPayload(), "delivery-unmatched");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: WAMID } }), 0);

      const stored = await tx.webhookEvent.findFirst({ where: { provider: "AISENSY_PROJECT_WEBHOOK", externalEventId: "delivery-unmatched" } });
      assert.ok(stored, "the raw event is preserved even though it could not be matched");
      assert.equal(stored!.status, "IGNORED");
    });
  });
});

describe("AiSensy message.status.updated - E: invalid/missing data.message", () => {
  it("is safely stored and never crashes or creates a message", async () => {
    await inRollback(async (tx) => {
      // A before/after delta, not an absolute 0: this shared dev database already has real
      // WhatsAppMessage rows from live end-to-end AiSensy testing, unrelated to this test.
      const before = await tx.whatsAppMessage.count();
      const { outcome } = await deliver(tx, { topic: "message.status.updated", data: {} }, "delivery-malformed");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), before);
    });
  });
});

describe("AiSensy message.status.updated - F: unsupported status", () => {
  it("is safely stored and never writes an invalid CRM status", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await makeMessage(tx, lead.id, WAMID, { status: "SENT" });
      const payload = { topic: "message.status.updated", data: { message: { messageId: WAMID, status: "FAILED" } } };

      const { outcome } = await deliver(tx, payload, "delivery-unsupported");
      assert.equal(outcome, "ignored");

      const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { providerMessageId: WAMID }, select: { status: true } });
      assert.equal(row.status, "SENT", "status is left exactly as it was - never guessed onto FAILED");
    });
  });
});

describe("AiSensy message.status.updated - G: status regression is rejected", () => {
  it("an old SENT event arriving after READ leaves the message at READ", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID, { status: "SENT", sentAt: new Date(1790081779530) });

      await deliver(tx, realReadPayload(), "delivery-4a");
      let row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true } });
      assert.equal(row.status, "READ");

      // A late/out-of-order SENT delivery for the same message - must never move status backwards.
      await deliver(tx, realSentPayload(), "delivery-4b");
      row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true } });
      assert.equal(row.status, "READ", "READ must not revert to SENT");
    });
  });
});

describe("AiSensy message.status.updated - H: timestamp conversion", () => {
  it("millisecond epoch fields become the correct Date values on the stored message", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID);
      await deliver(tx, realSentPayload(), "delivery-5");
      const row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { sentAt: true } });
      assert.equal(row.sentAt?.toISOString(), new Date(1790081781000).toISOString());
    });
  });
});

describe("AiSensy message.status.updated - newly confirmed DELIVERED: SENT -> DELIVERED -> READ", () => {
  function realDeliveredPayload(): Record<string, unknown> {
    return {
      id: "d1",
      data: { message: { messageId: WAMID, status: "DELIVERED", sent_at: 1790081779530, delivered_at: 1790081780200 } },
      topic: "message.status.updated",
      created_at: "2026-09-22T12:56:26.000Z",
    };
  }

  it("a DELIVERED update moves an existing SENT message to DELIVERED with the real delivered_at timestamp", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID, { status: "SENT", sentAt: new Date(1790081779530) });

      const { outcome } = await deliver(tx, realDeliveredPayload(), "delivery-f1");
      assert.equal(outcome, "processed");

      const row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true, deliveredAt: true } });
      assert.equal(row.status, "DELIVERED");
      assert.equal(row.deliveredAt?.getTime(), 1790081780200);
    });
  });

  it("DELIVERED then READ progresses correctly, and a late DELIVERED after READ never reverts it", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, lead.id, WAMID, { status: "SENT", sentAt: new Date(1790081779530) });

      await deliver(tx, realDeliveredPayload(), "delivery-f2a");
      let row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true } });
      assert.equal(row.status, "DELIVERED");

      await deliver(tx, realReadPayload(), "delivery-f2b");
      row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true } });
      assert.equal(row.status, "READ");

      // A late DELIVERED arriving after READ must never move status backwards.
      await deliver(tx, realDeliveredPayload(), "delivery-f2c");
      row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: message.id }, select: { status: true } });
      assert.equal(row.status, "READ", "READ must not revert to DELIVERED");
    });
  });
});

describe("AiSensy message.created - TEST A: real inbound message creates a CRM WhatsAppMessage", () => {
  it("matches the existing lead by phone, creates an INBOUND message with the real text/messageId, and audits it", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx); // normalizedMobile +919876543210, matches phone_number 919876543210

      const { outcome } = await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-1");
      assert.equal(outcome, "processed");

      const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { provider: "AISENSY", providerMessageId: INBOUND_WAMID } });
      assert.equal(row.direction, "INBOUND");
      assert.equal(row.messageType, "TEXT");
      assert.equal(row.body, "Hello");
      assert.equal(row.leadId, lead.id);
      assert.equal(row.status, "RECEIVED");
      assert.equal(row.receivedAt?.getTime(), 1790082988000);

      const activity = await tx.activity.findFirst({ where: { leadId: lead.id, type: "WHATSAPP_MESSAGE_RECEIVED" as any } });
      assert.ok(activity, "a matched inbound message is audited on the customer's timeline");
    });
  });
});

describe("AiSensy message.created - TEST B: duplicate delivery is idempotent", () => {
  it("the same inbound delivery processed twice creates exactly one WhatsAppMessage and one Activity", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);

      const first = await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-dup");
      const second = await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-dup"); // identical externalEventId
      assert.equal(first.outcome, "processed");
      assert.equal(second.outcome, "duplicate-delivery");

      assert.equal(await tx.whatsAppMessage.count({ where: { provider: "AISENSY", providerMessageId: INBOUND_WAMID } }), 1);
      assert.equal(await tx.lead.count({ where: { normalizedMobile: "+919876543210" } }), 1, "no duplicate lead/contact");
      assert.equal((await tx.activity.findMany({ where: { leadId: lead.id, type: "WHATSAPP_MESSAGE_RECEIVED" as any } })).length, 1);
    });
  });

  it("a genuine second delivery (different id) reporting the same message is also a safe no-op", async () => {
    await inRollback(async (tx) => {
      await makeLead(tx);
      await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-dup2a");
      const { outcome } = await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-dup2b"); // AiSensy resent under a new delivery id
      assert.equal(outcome, "processed"); // processed, but recordInboundMessage's own idempotency means nothing new is written
      assert.equal(await tx.whatsAppMessage.count({ where: { provider: "AISENSY", providerMessageId: INBOUND_WAMID } }), 1);
    });
  });
});

describe("AiSensy message.created - TEST C: existing contact is reused, never duplicated", () => {
  it("an inbound message from a phone number matching TWO different leads' normalizedMobile never happens - matches the one existing lead", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const before = await tx.lead.count();

      await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-existing");

      assert.equal(await tx.lead.count(), before, "no new lead/contact/customer was created");
      const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { provider: "AISENSY", providerMessageId: INBOUND_WAMID } });
      assert.equal(row.leadId, lead.id);
    });
  });
});

// WhatsApp Inbox + AI order-taking task, Phase 2: recordInboundMessage now creates a real Lead for
// an unmatched sender (leadService.createLeadFromSource, the same Source-attributed pattern Meta/
// Shopify already use) instead of leaving the message unattached - this describe block's own
// behavior changed accordingly; see whatsapp.db-test.ts's equivalent update for the primary path.
describe("AiSensy message.created - TEST D: unknown contact - creates a new lead, never a fabricated duplicate", () => {
  it("stores the WhatsAppMessage attached to a newly created lead, and audits both events", async () => {
    await inRollback(async (tx) => {
      // Deliberately no makeLead() - the payload's phone_number matches nothing in the CRM yet.
      const leadsBefore = await tx.lead.count();

      const { outcome } = await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-unknown");
      assert.equal(outcome, "processed");

      assert.equal(await tx.lead.count(), leadsBefore + 1, "exactly one new lead was created for the unmatched number");
      const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { provider: "AISENSY", providerMessageId: INBOUND_WAMID } });
      assert.ok(row.leadId, "the message is attached to the newly created lead, never left orphaned");

      const receivedActivity = await tx.activity.findFirst({ where: { leadId: row.leadId!, type: "WHATSAPP_MESSAGE_RECEIVED" as any } });
      assert.ok(receivedActivity);
      const createdActivity = await tx.activity.findFirst({ where: { leadId: row.leadId!, type: ActivityType.LEAD_CREATED } });
      assert.ok(createdActivity, "the new lead's own creation is audited too");
    });
  });
});

describe("AiSensy message.created - TEST K: malformed payload (missing data.message)", () => {
  it("is safely stored and never crashes or creates a message", async () => {
    await inRollback(async (tx) => {
      const before = await tx.whatsAppMessage.count();
      const { outcome } = await deliverCreated(tx, { topic: "message.created", data: {} }, "created-malformed");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), before);
    });
  });
});

describe("AiSensy message.created - TEST J: unsupported message type / chatbot reply", () => {
  it("a chatbot (ASSISTANT) reply is recognised and safely ignored - no CRM outbound message is fabricated", async () => {
    await inRollback(async (tx) => {
      await makeLead(tx);
      const before = await tx.whatsAppMessage.count();
      const payload = {
        topic: "message.created",
        data: { message: { sender: "ASSISTANT", messageId: `wamid.test-outbound-${uid()}`, phone_number: "919876543210", message_type: "TEXT", message_content: { text: "bot reply" } } },
      };
      const { outcome } = await deliverCreated(tx, payload, "created-outbound");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), before, "chatbot replies are not synced as CRM outbound messages");
    });
  });

  it("a non-TEXT message type is safely ignored, never crashes", async () => {
    await inRollback(async (tx) => {
      await makeLead(tx);
      const before = await tx.whatsAppMessage.count();
      const payload = { topic: "message.created", data: { message: { sender: "USER", messageId: `wamid.test-image-${uid()}`, phone_number: "919876543210", message_type: "IMAGE" } } };
      const { outcome } = await deliverCreated(tx, payload, "created-image");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), before);
    });
  });
});

// ---- Outbound round trip: proves the CRM's own send path and this webhook's status-update path are
// genuinely ONE pipeline, joined only by WhatsAppMessage.providerMessageId - not two halves that
// merely look compatible. Every other webhook test above hand-crafts a WhatsAppMessage row with a
// hardcoded wamid; this one instead sends through the real, existing WhatsAppService.sendTemplateMessage()
// (the same method the CRM's "Send WhatsApp" UI already uses - see whatsapp.service.ts, reused
// unmodified) and then delivers AiSensy webhooks against whatever providerMessageId that send
// actually produced.
//
// Caveat, stated plainly (see this task's own final report): AiSensyProvider.sendTemplateMessage()
// reads providerMessageId from the real Campaign API's response `id` field - a value NO real send
// has ever confirmed to actually be a wamid (the identifier the Project Webhook reports). The fake
// provider below returns a wamid-shaped id to prove the CRM's OWN wiring is correct; it does not and
// cannot prove what AiSensy's real Campaign API response actually contains.
describe("Outbound round trip: CRM send -> AiSensy status webhook updates the SAME WhatsAppMessage", () => {
  const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });

  function fakeSendingProvider(providerMessageId: string): WhatsAppProvider {
    return {
      id: "AISENSY",
      sendTemplateMessage: async () => ({ providerMessageId, raw: { ok: true } }),
      verifyWebhook: () => true,
      parseIncomingWebhook: () => [],
      parseDeliveryStatusWebhook: () => [],
      listTemplates: async () => ({ supported: false, reason: "not supported by this fake provider" }),
    };
  }

  it("SENT (from the send itself) -> DELIVERED -> READ, all on the message the CRM actually sent", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const sentWamid = `wamid.roundtrip-${uid()}`;

      // 1. The real, existing send path - not a hand-crafted row.
      const sendResult = await new WhatsAppService(tx, () => fakeSendingProvider(sentWamid)).sendTemplateMessage(as(admin, Role.ADMIN), {
        leadId: lead.id,
        templateName: "order_update",
        params: ["SHP-100"],
      });
      assert.equal(sendResult.direction, "OUTBOUND");
      assert.equal(sendResult.status, "SENT");
      assert.equal(sendResult.providerMessageId, sentWamid, "the CRM stored exactly what the provider returned - never fabricated");

      // 2. A DELIVERED webhook for that exact providerMessageId.
      const deliveredPayload = { data: { message: { messageId: sentWamid, status: "DELIVERED", sent_at: Date.now() - 2000, delivered_at: Date.now() - 1000 } }, topic: "message.status.updated" };
      let { outcome } = await deliver(tx, deliveredPayload, "roundtrip-delivered");
      assert.equal(outcome, "processed");
      let row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: sendResult.id }, select: { status: true, deliveredAt: true } });
      assert.equal(row.status, "DELIVERED");
      assert.ok(row.deliveredAt);

      // 3. A READ webhook for the same message.
      const readPayload = { data: { message: { messageId: sentWamid, status: "READ", sent_at: Date.now() - 2000, read_at: Date.now() } }, topic: "message.status.updated" };
      ({ outcome } = await deliver(tx, readPayload, "roundtrip-read"));
      assert.equal(outcome, "processed");
      row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: sendResult.id }, select: { status: true, deliveredAt: true } });
      assert.equal(row.status, "READ");

      const activity = await tx.activity.findFirst({ where: { type: ActivityType.WHATSAPP_READ, referenceId: sendResult.id } });
      assert.ok(activity, "the READ transition on a CRM-sent message is still audited on the customer's timeline");
    });
  });

  it("an out-of-order SENT delivered after READ never reverts the CRM-sent message", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const sentWamid = `wamid.roundtrip-${uid()}`;

      const sendResult = await new WhatsAppService(tx, () => fakeSendingProvider(sentWamid)).sendTemplateMessage(as(admin, Role.ADMIN), {
        leadId: lead.id,
        templateName: "order_update",
        params: ["SHP-101"],
      });

      await deliver(tx, { data: { message: { messageId: sentWamid, status: "READ", sent_at: Date.now() - 3000, read_at: Date.now() } }, topic: "message.status.updated" }, "roundtrip-read-first");
      let row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: sendResult.id }, select: { status: true } });
      assert.equal(row.status, "READ");

      // A stale/replayed SENT event for the exact same message the CRM itself sent - must never revert it.
      await deliver(tx, { data: { message: { messageId: sentWamid, status: "SENT", sent_at: Date.now() - 5000 } }, topic: "message.status.updated" }, "roundtrip-late-sent");
      row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: sendResult.id }, select: { status: true } });
      assert.equal(row.status, "READ", "READ must not revert to SENT, even on the CRM's own sent message");
    });
  });

  it("a duplicate DELIVERED delivery for a CRM-sent message never double-writes or double-audits", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const sentWamid = `wamid.roundtrip-${uid()}`;

      const sendResult = await new WhatsAppService(tx, () => fakeSendingProvider(sentWamid)).sendTemplateMessage(as(admin, Role.ADMIN), {
        leadId: lead.id,
        templateName: "order_update",
        params: ["SHP-102"],
      });

      const payload = { data: { message: { messageId: sentWamid, status: "DELIVERED", sent_at: Date.now() - 2000, delivered_at: Date.now() - 1000 } }, topic: "message.status.updated" };
      const first = await deliver(tx, payload, "roundtrip-dup-same-id");
      const second = await deliver(tx, payload, "roundtrip-dup-same-id"); // identical externalEventId - a real AiSensy retry
      assert.equal(first.outcome, "processed");
      assert.equal(second.outcome, "duplicate-delivery");

      assert.equal(await tx.whatsAppMessage.count({ where: { id: sendResult.id } }), 1);
      assert.equal((await tx.activity.findMany({ where: { type: ActivityType.WHATSAPP_DELIVERED, referenceId: sendResult.id } })).length, 1);
    });
  });

  // The exact real-world scenario this task fixed: a genuine send response whose only usable id is
  // `submitted_message_id`, and message.status.updated deliveries whose `messageId` is a DIFFERENT,
  // real wamid (never the same string the send returned) - captured 2026-09-23 from this account's
  // own AiSensy project. Uses the real AiSensyProvider class (not a hand-rolled fake) with a scripted
  // fetch returning the exact real response shape, so this proves the send-side fix and the
  // webhook-side fix work together, end to end, exactly as they did in production.
  it("REAL SHAPE: a send response with only submitted_message_id still correlates correctly, even though message.status.updated reports a totally different messageId", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);

      const config = (() => {
        const r = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "AISENSY", AISENSY_API_KEY: "key", AISENSY_SOURCE_NUMBER: "918976830778", AISENSY_WEBHOOK_SECRET: "whsec" });
        if (!r.ok || r.config.kind !== "AISENSY") throw new Error("bad test setup");
        return r.config;
      })();
      // The real Campaign API response for this account never includes a usable `id` - only
      // `submitted_message_id` (see AiSensyProvider.sendTemplateMessage()'s own comment for why).
      const fetchImpl = (async () => new Response(JSON.stringify({ submitted_message_id: "b75aee45-53ff-4f2f-80a6-e9343410276d" }), { status: 200 })) as unknown as typeof fetch;
      const provider = new AiSensyProvider(config, { fetchImpl });

      const sendResult = await new WhatsAppService(tx, () => provider).sendTemplateMessage(as(admin, Role.ADMIN), {
        leadId: lead.id,
        templateName: "CRM Outbound Test",
        params: ["Vishwaa"],
      });
      assert.equal(sendResult.providerMessageId, "b75aee45-53ff-4f2f-80a6-e9343410276d");
      assert.equal(sendResult.status, "SENT");

      // The real DELIVERED webhook - its own messageId is a real wamid, totally different from what
      // the send returned, and would never have matched under the old messageId-based correlation.
      const deliveredPayload = {
        data: {
          message: {
            messageId: "wamid.HBgMOTE5MzIxNjE0MDI1FQIAERgSRDE1NjU3REIyQUREQjk1QUFEAA==",
            submitted_message_id: "b75aee45-53ff-4f2f-80a6-e9343410276d",
            status: "DELIVERED",
            sent_at: 1790141882626,
            delivered_at: 1790141891000,
          },
        },
        topic: "message.status.updated",
      };
      let { outcome } = await deliver(tx, deliveredPayload, "real-shape-delivered");
      assert.equal(outcome, "processed");
      let row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: sendResult.id }, select: { status: true, deliveredAt: true } });
      assert.equal(row.status, "DELIVERED");
      assert.equal(row.deliveredAt?.getTime(), 1790141891000);

      // The real (out-of-order-looking) SENT webhook that followed - same submitted_message_id, same
      // wamid, must never move status backwards.
      const sentPayload = { ...deliveredPayload, data: { message: { ...deliveredPayload.data.message, status: "SENT" } } };
      ({ outcome } = await deliver(tx, sentPayload, "real-shape-sent"));
      assert.equal(outcome, "processed");
      row = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: sendResult.id }, select: { status: true, deliveredAt: true } });
      assert.equal(row.status, "DELIVERED", "a lower-rank SENT arriving after DELIVERED must never revert it");

      // Exactly one CRM message, exactly one DELIVERED activity - no duplicates from this real sequence.
      assert.equal(await tx.whatsAppMessage.count({ where: { id: sendResult.id } }), 1);
      assert.equal((await tx.activity.findMany({ where: { type: ActivityType.WHATSAPP_DELIVERED, referenceId: sendResult.id } })).length, 1);
    });
  });
});
