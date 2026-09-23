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
import { ActivityType } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { createPrismaWebhookStore } from "../shopify/shopify.webhook.store.js";
import { processAiSensyProjectWebhookEvent } from "./whatsapp.aisensy.webhook.processor.js";

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

async function makeLead(tx: Prisma.TransactionClient) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9321614025", normalizedMobile: "+919321614025" },
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

// The exact real inbound message.created delivery captured 2026-09-22 (sender "USER").
const INBOUND_WAMID = "wamid.HBgMOTE5MzIxNjE0MDI1FQIAEhggQUM0MTFEMzc3N0YzQ0ExNjBCM0RBODg3OTMzRDRGQjYA";
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
        phone_number: "919321614025",
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
      const { outcome } = await deliver(tx, { topic: "message.status.updated", data: {} }, "delivery-malformed");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), 0);
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
      const lead = await makeLead(tx); // normalizedMobile +919321614025, matches phone_number 919321614025

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
      assert.equal(await tx.lead.count({ where: { normalizedMobile: "+919321614025" } }), 1, "no duplicate lead/contact");
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

describe("AiSensy message.created - TEST D: unknown contact - existing CRM architecture, no fabricated customer", () => {
  it("stores the WhatsAppMessage with no lead attached, creates no customer, and no Activity", async () => {
    await inRollback(async (tx) => {
      // Deliberately no makeLead() - phone_number 919321614025 matches nothing in the CRM.
      const before = await tx.lead.count();

      const { outcome } = await deliverCreated(tx, realInboundMessageCreatedPayload(), "created-unknown");
      assert.equal(outcome, "processed"); // the webhook itself is still fully, successfully processed

      assert.equal(await tx.lead.count(), before, "the existing architecture never auto-creates a lead/customer from an inbound WhatsApp message");
      const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { provider: "AISENSY", providerMessageId: INBOUND_WAMID } });
      assert.equal(row.leadId, null, "message is preserved, just unattached - never guessed onto a customer");
      assert.equal(await tx.activity.count({ where: { type: "WHATSAPP_MESSAGE_RECEIVED" as any } }), 0, "no Activity without a real customer to attach it to");
    });
  });
});

describe("AiSensy message.created - TEST K: malformed payload (missing data.message)", () => {
  it("is safely stored and never crashes or creates a message", async () => {
    await inRollback(async (tx) => {
      const { outcome } = await deliverCreated(tx, { topic: "message.created", data: {} }, "created-malformed");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), 0);
    });
  });
});

describe("AiSensy message.created - TEST J: unsupported message type / chatbot reply", () => {
  it("a chatbot (ASSISTANT) reply is recognised and safely ignored - no CRM outbound message is fabricated", async () => {
    await inRollback(async (tx) => {
      await makeLead(tx);
      const payload = {
        topic: "message.created",
        data: { message: { sender: "ASSISTANT", messageId: "wamid.outbound", phone_number: "919321614025", message_type: "TEXT", message_content: { text: "bot reply" } } },
      };
      const { outcome } = await deliverCreated(tx, payload, "created-outbound");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), 0, "chatbot replies are not synced as CRM outbound messages");
    });
  });

  it("a non-TEXT message type is safely ignored, never crashes", async () => {
    await inRollback(async (tx) => {
      await makeLead(tx);
      const payload = { topic: "message.created", data: { message: { sender: "USER", messageId: "wamid.image", phone_number: "919321614025", message_type: "IMAGE" } } };
      const { outcome } = await deliverCreated(tx, payload, "created-image");
      assert.equal(outcome, "ignored");
      assert.equal(await tx.whatsAppMessage.count(), 0);
    });
  });
});
