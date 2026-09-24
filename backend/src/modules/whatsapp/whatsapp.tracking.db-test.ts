// Database integration tests for E7.5 WhatsApp Delivery & Read Tracking.
//
// Unlike whatsapp.db-test.ts's "delivery status updates" describe block (which drives
// WhatsAppService.recordStatusUpdate directly), these tests exercise the *whole* webhook pipeline -
// handleWhatsAppWebhook -> the real webhook_events store -> processWhatsAppWebhookEvent -> the real
// AiSensyProvider/GupshupProvider parsers -> WhatsAppService - using realistic fixture payloads for
// both providers, the same wiring server.ts/whatsapp.webhook.routes.ts use in production (minus the
// setImmediate scheduling, replaced here with an immediate awaited call so tests stay deterministic).
//
// Every test runs inside one rolled-back transaction; see whatsapp.db-test.ts's header comment for
// why every Lead read/write here uses an explicit `select`.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "../customers/customers.service.js";
import { AiSensyProvider } from "./whatsapp.aisensy.provider.js";
import { resolveWhatsAppConfig } from "./whatsapp.config.js";
import { GupshupProvider } from "./whatsapp.gupshup.provider.js";
import { computeAiSensyHmac } from "./whatsapp.hmac.js";
import type { WhatsAppProvider, WhatsAppProviderId } from "./whatsapp.provider.js";
import { handleWhatsAppWebhook } from "./whatsapp.webhook.handler.js";
import { processWhatsAppWebhookEvent } from "./whatsapp.webhook.processor.js";
import { createWhatsAppWebhookStore } from "./whatsapp.webhook.store.js";
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
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });
const LEAD_SELECT = { id: true, normalizedMobile: true } as const;

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: LEAD_SELECT,
  });
}

/** An OUTBOUND message already recorded as sent, as sendTemplateMessage would have left it. */
async function sentMessage(tx: Prisma.TransactionClient, provider: WhatsAppProviderId, leadId: string, providerMessageId: string, status: "QUEUED" | "SENT" = "SENT") {
  return tx.whatsAppMessage.create({
    data: { provider, providerMessageId, direction: "OUTBOUND", messageType: "TEMPLATE", status, leadId, sentAt: status === "SENT" ? new Date("2026-09-20T10:00:00Z") : null },
    select: { id: true, status: true },
  });
}

// A fetchImpl that fails the test if the provider ever tries to reach the network - status-webhook
// processing must never call the provider (task requirement 17: "no provider is called while
// processing webhook"). Real AiSensyProvider/GupshupProvider only use fetch from
// sendTemplateMessage/listTemplates, neither of which recordStatusUpdate/recordInboundMessage calls.
const noNetworkFetch = (async () => { throw new Error("provider network call made during webhook processing"); }) as unknown as typeof fetch;

function aisensyProvider() {
  const r = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "AISENSY", AISENSY_API_KEY: "key", AISENSY_SOURCE_NUMBER: "919876500000", AISENSY_WEBHOOK_SECRET: "whsec" });
  if (!r.ok || r.config.kind !== "AISENSY") throw new Error("bad test setup");
  return new AiSensyProvider(r.config, { fetchImpl: noNetworkFetch });
}

function gupshupProvider() {
  const r = resolveWhatsAppConfig({ WHATSAPP_PROVIDER: "GUPSHUP", GUPSHUP_API_KEY: "gs-key", GUPSHUP_APP_NAME: "DemoApp", GUPSHUP_SOURCE_NUMBER: "917834811114", GUPSHUP_WEBHOOK_TOKEN: "gs-token" });
  if (!r.ok || r.config.kind !== "GUPSHUP") throw new Error("bad test setup");
  return new GupshupProvider(r.config, { fetchImpl: noNetworkFetch });
}

const aiSensyAuthHeaders = (rawBody: string) => ({ "x-aisensy-signature": computeAiSensyHmac(Buffer.from(rawBody), "whsec") });
const gupshupAuthHeaders = () => ({ authorization: "gs-token" });

/** AiSensy's Meta Cloud API status envelope, as parsed by AiSensyProvider.parseDeliveryStatusWebhook. */
function aiSensyStatusPayload(providerMessageId: string, status: string, timestampSec: number, errors?: { code: number; title: string }[]) {
  return { entry: [{ changes: [{ value: { statuses: [{ id: providerMessageId, status, timestamp: String(timestampSec), ...(errors ? { errors } : {}) }] } }] }] };
}

/** Gupshup's message-event status envelope, as parsed by GupshupProvider.parseDeliveryStatusWebhook. */
function gupshupStatusPayload(providerMessageId: string, type: string, timestampMs: number, failure?: { code: number; reason: string }) {
  return { app: "DemoApp", timestamp: timestampMs, version: 2, type: "message-event", payload: { id: providerMessageId, gsId: `gs-internal-${uid()}`, type, destination: "919876543210", payload: failure ?? {} } };
}

/** Runs one webhook delivery through the exact production pipeline (receive -> store -> process),
 *  synchronously rather than via setImmediate, so assertions can run right after. */
async function deliver(tx: Prisma.TransactionClient, provider: WhatsAppProvider, providerId: WhatsAppProviderId, payload: unknown, headers: Record<string, string>) {
  const store = createWhatsAppWebhookStore(tx, providerId);
  const svc = new WhatsAppService(tx);
  const rawBody = Buffer.from(JSON.stringify(payload));
  let scheduledId: string | null = null;
  const received = await handleWhatsAppWebhook({ rawBody, headers }, { provider, store, schedule: (id) => { scheduledId = id; } });
  let outcome: string | null = null;
  if (scheduledId) {
    outcome = await processWhatsAppWebhookEvent(scheduledId, {
      store,
      provider,
      persist: { message: (m) => svc.recordInboundMessage(providerId, m), status: (s) => svc.recordStatusUpdate(providerId, s) },
    });
  }
  return { received, outcome };
}

describe("E7.5: end-to-end status tracking via the real webhook pipeline (AiSensy)", () => {
  it("a SENT webhook advances a QUEUED message to SENT", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-e2e-sent", "QUEUED");
      const provider = aisensyProvider();
      const payload = aiSensyStatusPayload("wamid-e2e-sent", "sent", 1700000000);
      const { received, outcome } = await deliver(tx, provider, "AISENSY", payload, aiSensyAuthHeaders(JSON.stringify(payload)));

      assert.equal(received.status, 200);
      assert.equal(outcome, "processed");
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "SENT");
      assert.ok(stored.sentAt);
    });
  });

  it("a DELIVERED webhook advances a SENT message and records one WHATSAPP_DELIVERED activity", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-e2e-delivered");
      const provider = aisensyProvider();
      const payload = aiSensyStatusPayload("wamid-e2e-delivered", "delivered", 1700000100);
      const { outcome } = await deliver(tx, provider, "AISENSY", payload, aiSensyAuthHeaders(JSON.stringify(payload)));

      assert.equal(outcome, "processed");
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "DELIVERED");
      assert.ok(stored.deliveredAt);
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_DELIVERED } }), 1);
    });
  });

  it("a READ webhook advances a DELIVERED message and records one WHATSAPP_READ activity", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-e2e-read");
      const provider = aisensyProvider();
      const delivered = aiSensyStatusPayload("wamid-e2e-read", "delivered", 1700000100);
      await deliver(tx, provider, "AISENSY", delivered, aiSensyAuthHeaders(JSON.stringify(delivered)));
      const read = aiSensyStatusPayload("wamid-e2e-read", "read", 1700000200);
      const { outcome } = await deliver(tx, provider, "AISENSY", read, aiSensyAuthHeaders(JSON.stringify(read)));

      assert.equal(outcome, "processed");
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "READ");
      assert.ok(stored.readAt);
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_READ } }), 1);
    });
  });

  it("a FAILED webhook records the safe provider error reason without crashing", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-e2e-failed");
      const provider = aisensyProvider();
      const payload = aiSensyStatusPayload("wamid-e2e-failed", "failed", 1700000100, [{ code: 131047, title: "Re-engagement message" }]);
      const { outcome } = await deliver(tx, provider, "AISENSY", payload, aiSensyAuthHeaders(JSON.stringify(payload)));

      assert.equal(outcome, "processed");
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "FAILED");
      assert.equal(stored.errorCode, "131047");
      assert.equal(stored.errorMessage, "Re-engagement message");

      const activity = await tx.activity.findFirst({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_FAILED } });
      assert.equal(activity?.description, "Re-engagement message");
    });
  });
});

describe("E7.5: end-to-end status tracking via the real webhook pipeline (Gupshup)", () => {
  it("normalizes Gupshup's delivered/read/failed event types onto the CRM's own status enum", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "GUPSHUP", lead.id, "gs-e2e-1");
      const provider = gupshupProvider();

      await deliver(tx, provider, "GUPSHUP", gupshupStatusPayload("gs-e2e-1", "delivered", 1700000100000), gupshupAuthHeaders());
      assert.equal((await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } })).status, "DELIVERED");

      await deliver(tx, provider, "GUPSHUP", gupshupStatusPayload("gs-e2e-1", "read", 1700000200000), gupshupAuthHeaders());
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "READ");
      // Gupshup's own event-type strings ("read") never leak past the provider adapter - the row
      // carries only the CRM's canonical enum value.
      assert.notEqual(stored.status as string, "read");
    });
  });

  it("records a FAILED event with Gupshup's failure code/reason", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "GUPSHUP", lead.id, "gs-e2e-2");
      const provider = gupshupProvider();
      await deliver(tx, provider, "GUPSHUP", gupshupStatusPayload("gs-e2e-2", "failed", 1700000100000, { code: 1002, reason: "Invalid destination number" }), gupshupAuthHeaders());

      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "FAILED");
      assert.equal(stored.errorCode, "1002");
      assert.equal(stored.errorMessage, "Invalid destination number");
    });
  });
});

describe("E7.5: idempotency and duplicate protection", () => {
  it("the exact same delivery repeated is deduplicated at the webhook layer - never reprocessed, no duplicate activity", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-dup-1");
      const provider = aisensyProvider();
      const payload = aiSensyStatusPayload("wamid-dup-1", "delivered", 1700000100);
      const headers = aiSensyAuthHeaders(JSON.stringify(payload));

      const first = await deliver(tx, provider, "AISENSY", payload, headers);
      const second = await deliver(tx, provider, "AISENSY", payload, headers);

      assert.equal(first.received.status, 200);
      assert.equal(second.received.message, "Duplicate delivery ignored");
      assert.equal(second.outcome, null, "the duplicate was never even scheduled for processing");
      assert.equal((await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } })).status, "DELIVERED");
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_DELIVERED } }), 1);
    });
  });

  it("a provider re-sending the same DELIVERED status as a fresh delivery is still idempotent at the service layer", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-dup-2");
      const provider = aisensyProvider();
      const first = aiSensyStatusPayload("wamid-dup-2", "delivered", 1700000100);
      const resend = aiSensyStatusPayload("wamid-dup-2", "delivered", 1700000105); // a different delivery id (different body), same logical event
      await deliver(tx, provider, "AISENSY", first, aiSensyAuthHeaders(JSON.stringify(first)));
      const { outcome } = await deliver(tx, provider, "AISENSY", resend, aiSensyAuthHeaders(JSON.stringify(resend)));

      assert.equal(outcome, "processed"); // the delivery itself is new and recognised, even though it changes nothing
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "DELIVERED");
      assert.deepEqual(stored.deliveredAt, new Date(1700000100 * 1000), "the original, earlier timestamp is kept - a later duplicate never overwrites it");
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_DELIVERED } }), 1, "no duplicate activity");
    });
  });

  it("a repeated READ status is likewise idempotent", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-dup-3");
      const provider = aisensyProvider();
      const first = aiSensyStatusPayload("wamid-dup-3", "read", 1700000200);
      const resend = aiSensyStatusPayload("wamid-dup-3", "read", 1700000210);
      await deliver(tx, provider, "AISENSY", first, aiSensyAuthHeaders(JSON.stringify(first)));
      await deliver(tx, provider, "AISENSY", resend, aiSensyAuthHeaders(JSON.stringify(resend)));

      assert.equal((await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } })).status, "READ");
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_READ } }), 1);
    });
  });
});

describe("E7.5: status transitions never move backwards", () => {
  it("a stale SENT webhook cannot downgrade an already-DELIVERED message", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-downgrade-1");
      const provider = aisensyProvider();
      const delivered = aiSensyStatusPayload("wamid-downgrade-1", "delivered", 1700000100);
      await deliver(tx, provider, "AISENSY", delivered, aiSensyAuthHeaders(JSON.stringify(delivered)));
      const staleSent = aiSensyStatusPayload("wamid-downgrade-1", "sent", 1700000050); // arrives late, from before delivery
      await deliver(tx, provider, "AISENSY", staleSent, aiSensyAuthHeaders(JSON.stringify(staleSent)));

      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "DELIVERED", "never downgraded to SENT");
      assert.deepEqual(stored.sentAt, new Date("2026-09-20T10:00:00Z"), "the original send timestamp is untouched");
    });
  });

  it("READ arriving before a delayed DELIVERED keeps the final state READ, while still recording when delivery actually happened", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-outoforder-1");
      const provider = aisensyProvider();
      // READ is processed first (e.g. the DELIVERED webhook was delayed in transit).
      const read = aiSensyStatusPayload("wamid-outoforder-1", "read", 1700000200);
      await deliver(tx, provider, "AISENSY", read, aiSensyAuthHeaders(JSON.stringify(read)));
      const delayedDelivered = aiSensyStatusPayload("wamid-outoforder-1", "delivered", 1700000100); // genuinely earlier timestamp, arriving late
      await deliver(tx, provider, "AISENSY", delayedDelivered, aiSensyAuthHeaders(JSON.stringify(delayedDelivered)));

      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } });
      assert.equal(stored.status, "READ", "status is never regressed by the late-arriving event");
      assert.deepEqual(stored.deliveredAt, new Date(1700000100 * 1000), "the real delivery timestamp is still captured, not invented and not dropped");
      assert.ok(stored.readAt);
      // The out-of-order DELIVERED must not manufacture a second, contradictory timeline event -
      // only the one real transition (READ) produced an activity.
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_DELIVERED } }), 0);
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: ActivityType.WHATSAPP_READ } }), 1);
    });
  });
});

describe("E7.5: safe handling of bad or unrecognised input", () => {
  it("a status update for a provider message id the CRM never sent is acknowledged and safely ignored - no row is fabricated", async () => {
    await inRollback(async (tx) => {
      const provider = aisensyProvider();
      const payload = aiSensyStatusPayload("wamid-never-sent", "delivered", 1700000100);
      const { received, outcome } = await deliver(tx, provider, "AISENSY", payload, aiSensyAuthHeaders(JSON.stringify(payload)));

      assert.equal(received.status, 200);
      assert.equal(outcome, "processed"); // the shape is recognised; recordStatusUpdate itself is the one that safely no-ops
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: "wamid-never-sent" } }), 0);
    });
  });

  it("rejects a delivery with an invalid signature, and records nothing", async () => {
    await inRollback(async (tx) => {
      const provider = aisensyProvider();
      const payload = aiSensyStatusPayload("wamid-bad-auth", "delivered", 1700000100);
      const { received } = await deliver(tx, provider, "AISENSY", payload, { "x-aisensy-signature": "not-the-right-signature" });

      assert.equal(received.status, 401);
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: "wamid-bad-auth" } }), 0);
    });
  });

  it("rejects a Gupshup delivery with a wrong Authorization token, and records nothing", async () => {
    await inRollback(async (tx) => {
      const provider = gupshupProvider();
      const payload = gupshupStatusPayload("gs-bad-auth", "delivered", 1700000100000);
      const { received } = await deliver(tx, provider, "GUPSHUP", payload, { authorization: "wrong-token" });

      assert.equal(received.status, 401);
      assert.equal(await tx.whatsAppMessage.count({ where: { providerMessageId: "gs-bad-auth" } }), 0);
    });
  });

  it("a malformed (non-JSON) body is rejected with 400 and never reaches the processor", async () => {
    await inRollback(async (tx) => {
      const provider = aisensyProvider();
      const store = createWhatsAppWebhookStore(tx, "AISENSY");
      const rawBody = Buffer.from("{not valid json");
      const received = await handleWhatsAppWebhook(
        { rawBody, headers: { "x-aisensy-signature": computeAiSensyHmac(rawBody, "whsec") } },
        { provider, store, schedule: () => assert.fail("must not schedule a delivery that failed to parse") },
      );
      assert.equal(received.status, 400);
    });
  });

  it("a well-formed but unrecognised payload shape is stored and marked IGNORED, without crashing", async () => {
    await inRollback(async (tx) => {
      const provider = aisensyProvider();
      const payload = { unexpected: "shape", nested: { a: 1 } };
      const { outcome } = await deliver(tx, provider, "AISENSY", payload, aiSensyAuthHeaders(JSON.stringify(payload)));
      assert.equal(outcome, "ignored");
    });
  });
});

describe("E7.5: Customer 360 timeline and E7.4 conversation history reflect the latest status", () => {
  it("shows DELIVERED then READ on both the timeline and the message-history API, exactly once each, with no provider call made", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const msg = await sentMessage(tx, "AISENSY", lead.id, "wamid-c360-1");
      const provider = aisensyProvider(); // fetchImpl throws if ever called - proves no provider network call happens here

      const delivered = aiSensyStatusPayload("wamid-c360-1", "delivered", 1700000100);
      await deliver(tx, provider, "AISENSY", delivered, aiSensyAuthHeaders(JSON.stringify(delivered)));
      const read = aiSensyStatusPayload("wamid-c360-1", "read", 1700000200);
      await deliver(tx, provider, "AISENSY", read, aiSensyAuthHeaders(JSON.stringify(read)));

      const customers = new CustomersService(tx);
      const timeline = await customers.getTimeline(as(admin, Role.ADMIN), lead.id, { page: 1, pageSize: 50 });
      assert.equal(timeline.entries.filter((e) => e.type === "WHATSAPP_DELIVERED").length, 1);
      assert.equal(timeline.entries.filter((e) => e.type === "WHATSAPP_READ").length, 1);

      const whatsapp = new WhatsAppService(tx);
      const history = await whatsapp.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      const item = history.items.find((i) => i.id === msg.id);
      assert.ok(item, "the message appears in E7.4's history API");
      assert.equal(item!.status, "READ");

      const detail = await whatsapp.getMessage(as(admin, Role.ADMIN), msg.id);
      assert.equal(detail.status, "READ");
    });
  });
});
