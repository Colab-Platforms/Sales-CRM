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
async function deliver(tx: Prisma.TransactionClient, payload: Record<string, unknown>, externalEventId: string) {
  const store = createPrismaWebhookStore(tx, "AISENSY_PROJECT_WEBHOOK");
  const { id, duplicate } = await store.record({ eventType: "message.status.updated", externalEventId, payload, ignored: false });
  if (duplicate) return { id, outcome: "duplicate-delivery" as const };
  const outcome = await processAiSensyProjectWebhookEvent(id, { store, db: tx });
  return { id, outcome };
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
      const payload = { topic: "message.status.updated", data: { message: { messageId: WAMID, status: "DELIVERED" } } };

      const { outcome } = await deliver(tx, payload, "delivery-unsupported");
      assert.equal(outcome, "ignored");

      const row = await tx.whatsAppMessage.findFirstOrThrow({ where: { providerMessageId: WAMID }, select: { status: true } });
      assert.equal(row.status, "SENT", "status is left exactly as it was - never guessed onto DELIVERED");
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
