// Database integration tests for E7.7 Campaign & Bulk Messaging. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - mirrors every other WhatsApp
// db-test file. Every Lead read/write uses an explicit `select`, for the same pre-existing,
// out-of-scope reason documented in whatsapp.db-test.ts (the unapplied lead-import migration - not
// touched here either).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "../customers/customers.service.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import WhatsAppService from "./whatsapp.service.js";
import WhatsAppCampaignService from "./whatsapp.campaign.service.js";
import { claimNextBatch, processCampaignBatch, tickCampaigns } from "./whatsapp.campaign.scheduler.js";

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

let mobileSeq = 0;
async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  mobileSeq += 1;
  const mobile = `98765${String(400000 + mobileSeq).padStart(6, "0")}`;
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Kiran", lastName: "Verma", mobile, normalizedMobile: `+91${mobile}`, ...overrides },
    select: { id: true, mobile: true },
  });
}

async function makeOrder(tx: Prisma.TransactionClient, leadId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return tx.order.create({
    data: { orderNumber: `AWL${Math.floor(Math.random() * 1_000_000)}`, leadId, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "1000.00", ...overrides },
    select: { id: true },
  });
}

async function makeTemplate(tx: Prisma.TransactionClient, overrides: Partial<Prisma.WhatsAppTemplateUncheckedCreateInput> = {}) {
  return tx.whatsAppTemplate.create({
    data: { name: `t_${uid()}`, provider: "AISENSY", language: "en", body: "Hi {{customer_name}}!", variables: ["customer_name"], status: WhatsAppTemplateStatus.APPROVED, ...overrides },
    select: { id: true, name: true },
  });
}

function fakeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    id: "AISENSY",
    sendTemplateMessage: async () => ({ providerMessageId: `wamid-${uid()}`, raw: { ok: true } }),
    verifyWebhook: () => true,
    parseIncomingWebhook: () => [],
    parseDeliveryStatusWebhook: () => [],
    listTemplates: async () => ({ supported: false, reason: "n/a" }),
    ...overrides,
  };
}

function services(tx: Prisma.TransactionClient, providerOverrides: Partial<WhatsAppProvider> = {}) {
  const messaging = new WhatsAppMessagingService(tx, () => fakeProvider(providerOverrides));
  const customers = new CustomersService(tx);
  const campaign = new WhatsAppCampaignService(tx, customers);
  return { messaging, customers, campaign };
}

async function admin(tx: Prisma.TransactionClient) {
  return tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
}

describe("campaign CRUD", () => {
  it("creates a DRAFT campaign with an APPROVED template", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);

      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "Welcome blast", description: "test", templateId: template.id, filters: {} });

      assert.equal(created.status, "DRAFT");
      assert.equal(created.template?.id, template.id);
      assert.equal(created.createdBy?.id, a.id);
      assert.equal(created.stats.totalRecipients, 0);
      assert.equal(await tx.activity.count({ where: { referenceType: "WhatsAppCampaign", referenceId: created.id, type: "WHATSAPP_CAMPAIGN_CREATED" } }), 1);
    });
  });

  it("rejects creating a campaign with a non-APPROVED template", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx, { status: WhatsAppTemplateStatus.PENDING });
      await assert.rejects(() => campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: {} }), (e: any) => e.statusCode === 400);
    });
  });

  it("allows editing a DRAFT campaign, but not a launched one", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "Draft name", templateId: template.id, filters: {} });

      const updated = await campaign.updateCampaign(as(a, Role.ADMIN), created.id, { name: "Renamed" });
      assert.equal(updated.name, "Renamed");

      const lead = await makeLead(tx);
      void lead;
      await tx.whatsAppCampaign.update({ where: { id: created.id }, data: { status: "RUNNING" } });
      await assert.rejects(() => campaign.updateCampaign(as(a, Role.ADMIN), created.id, { name: "Too late" }), (e: any) => e.statusCode === 400);
    });
  });

  it("views a campaign and lists campaigns", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "Listed campaign", templateId: template.id, filters: {} });

      const detail = await campaign.getCampaign(as(a, Role.ADMIN), created.id);
      assert.equal(detail.id, created.id);
      assert.deepEqual(detail.filters, {});

      const list = await campaign.listCampaigns(as(a, Role.ADMIN), { page: 1, pageSize: 20, status: "DRAFT" });
      assert.ok(list.items.some((c) => c.id === created.id));
    });
  });

  it("cancels a DRAFT campaign", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "To cancel", templateId: template.id, filters: {} });

      const cancelled = await campaign.cancelCampaign(as(a, Role.ADMIN), created.id);
      assert.equal(cancelled.status, "CANCELLED");
      await assert.rejects(() => campaign.cancelCampaign(as(a, Role.ADMIN), created.id), (e: any) => e.statusCode === 400);
    });
  });
});

describe("audience filtering and preview", () => {
  it("previews the recipient count and a small sample, reusing E6.7 segmentation, without loading everything", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      for (let i = 0; i < 8; i++) await makeLead(tx);

      const preview = await campaign.previewAudience(as(a, Role.ADMIN), {});
      assert.ok(preview.count >= 8);
      assert.ok(preview.sample.length <= 5, "never returns more than the small sample size");
    });
  });

  it("excludes recipients with no mobile number from the audience, and reports how many were excluded", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const tag = `NoMobile${uid().slice(0, 8)}`;
      const withMobile = await makeLead(tx, { firstName: tag, lastName: "HasMobile" });
      const noMobile = await makeLead(tx, { firstName: tag, lastName: "NoMobile", mobile: null, normalizedMobile: null });

      const preview = await campaign.previewAudience(as(a, Role.ADMIN), { search: tag });
      assert.ok(preview.sample.every((s) => s.leadId !== noMobile.id));
      assert.equal(preview.excludedNoMobile, 1);
      assert.equal(preview.count, 1);
      assert.ok(preview.sample.some((s) => s.leadId === withMobile.id));
    });
  });

  it("filters the audience by payment status, reusing the same reconciliation logic as the customer list", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const paidLead = await makeLead(tx, { firstName: "PaidCust" });
      const paidOrder = await makeOrder(tx, paidLead.id, { totalAmount: "500.00" });
      await tx.payment.create({ data: { orderId: paidOrder.id, amount: "500.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });

      const pendingLead = await makeLead(tx, { firstName: "PendingCust" });
      const pendingOrder = await makeOrder(tx, pendingLead.id, { totalAmount: "500.00" });
      await tx.payment.create({ data: { orderId: pendingOrder.id, amount: "500.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });

      const preview = await campaign.previewAudience(as(a, Role.ADMIN), { paymentStatus: "PENDING", search: "Cust" });
      const ids = preview.sample.map((s) => s.leadId);
      assert.ok(ids.includes(pendingLead.id) || preview.count >= 1);
      assert.ok(!ids.includes(paidLead.id));
    });
  });

  it("scopes the audience to the caller's own leads for a salesperson", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const { campaign } = services(tx);
      const own = await makeLead(tx, { ownerId: rep1.id, firstName: "OwnLead" });
      const other = await makeLead(tx, { ownerId: rep2.id, firstName: "OtherLead" });

      const preview = await campaign.previewAudience(as(rep1, Role.SALESPERSON), { search: "Lead" });
      const ids = preview.sample.map((s) => s.leadId);
      assert.ok(!ids.includes(other.id));
      void own;
    });
  });
});

describe("launch: template restriction and recipient creation", () => {
  it("rejects launching when the template is no longer APPROVED, and the campaign stays DRAFT", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: {} });
      await makeLead(tx);
      await tx.whatsAppTemplate.update({ where: { id: template.id }, data: { status: WhatsAppTemplateStatus.REJECTED } });

      await assert.rejects(() => campaign.launchCampaign(as(a, Role.ADMIN), created.id, {}), (e: any) => e.statusCode === 400);
      const row = await tx.whatsAppCampaign.findUniqueOrThrow({ where: { id: created.id }, select: { status: true } });
      assert.equal(row.status, "DRAFT");
    });
  });

  it("rejects launching with no eligible recipients, and the campaign stays DRAFT", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: `nobody-matches-${uid()}` } });

      await assert.rejects(() => campaign.launchCampaign(as(a, Role.ADMIN), created.id, {}), (e: any) => e.statusCode === 400);
      const row = await tx.whatsAppCampaign.findUniqueOrThrow({ where: { id: created.id }, select: { status: true } });
      assert.equal(row.status, "DRAFT");
    });
  });

  it("launching creates one PENDING recipient per matched customer, sets recipientCount, and moves to RUNNING", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Launch${uid().slice(0, 8)}`;
      const l1 = await makeLead(tx, { firstName: tag });
      const l2 = await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });

      const launched = await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      assert.equal(launched.status, "RUNNING");
      assert.equal(launched.stats.totalRecipients, 2);
      assert.equal(launched.stats.pending, 2);
      const recipients = await tx.whatsAppCampaignRecipient.findMany({ where: { campaignId: created.id } });
      assert.deepEqual(recipients.map((r) => r.leadId).sort(), [l1.id, l2.id].sort());
      assert.ok(recipients.every((r) => r.status === "PENDING"));
      assert.equal(await tx.activity.count({ where: { referenceType: "WhatsAppCampaign", referenceId: created.id, type: "WHATSAPP_CAMPAIGN_LAUNCHED" } }), 1);
    });
  });

  it("sending a batch resolves each recipient's real variables, calls the provider, and persists a WhatsAppMessage per recipient", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign, messaging } = services(tx);
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}, order {{order_number}}!", variables: ["customer_name", "order_number"] });
      const tag = `Send${uid().slice(0, 8)}`;
      const lead = await makeLead(tx, { firstName: tag, lastName: "One" });
      const order = await makeOrder(tx, lead.id);
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      const captured: string[][] = [];
      const { messaging: capturingMessaging } = services(tx, { sendTemplateMessage: async (input) => { captured.push(input.params); return { providerMessageId: `wamid-${uid()}`, raw: {} }; } });
      void messaging;
      const result = await processCampaignBatch(tx, capturingMessaging, created.id, template.id);

      assert.equal(result.claimed, 1);
      assert.equal(result.sent, 1);
      const orderNumber = (await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { orderNumber: true } })).orderNumber;
      assert.deepEqual(captured[0], [`${tag} One`, orderNumber]);

      const recipient = await tx.whatsAppCampaignRecipient.findFirstOrThrow({ where: { campaignId: created.id } });
      assert.equal(recipient.status, "SENT");
      assert.ok(recipient.whatsAppMessageId);
      const message = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: recipient.whatsAppMessageId! } });
      assert.equal(message.leadId, lead.id);
      assert.equal(message.orderId, order.id);
      assert.equal(message.templateId, template.id);
    });
  });
});

describe("idempotency", () => {
  it("launching the same campaign twice is rejected the second time, and never creates duplicate recipients", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Dup${uid().slice(0, 8)}`;
      await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });

      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});
      await assert.rejects(() => campaign.launchCampaign(as(a, Role.ADMIN), created.id, {}), (e: any) => e.statusCode === 409 || e.statusCode === 400);

      assert.equal(await tx.whatsAppCampaignRecipient.count({ where: { campaignId: created.id } }), 1);
    });
  });

  it("two truly concurrent launch attempts (Promise.all, not sequential) still result in exactly one launch and one recipient set - E7.8 hardening check", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `ConcurrentLaunch${uid().slice(0, 8)}`;
      const l1 = await makeLead(tx, { firstName: tag });
      const l2 = await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });

      const results = await Promise.allSettled([
        campaign.launchCampaign(as(a, Role.ADMIN), created.id, {}),
        campaign.launchCampaign(as(a, Role.ADMIN), created.id, {}),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one of the two concurrent launches wins");
      assert.equal(rejected.length, 1, "the other is rejected, not silently duplicated");

      const row = await tx.whatsAppCampaign.findUniqueOrThrow({ where: { id: created.id }, select: { status: true, recipientCount: true } });
      assert.equal(row.status, "RUNNING");
      assert.equal(row.recipientCount, 2);
      const recipients = await tx.whatsAppCampaignRecipient.findMany({ where: { campaignId: created.id } });
      assert.equal(recipients.length, 2, "no duplicate recipient rows from the losing launch attempt");
      assert.deepEqual(recipients.map((r) => r.leadId).sort(), [l1.id, l2.id].sort());
    });
  });

  it("the campaignId+leadId unique constraint means the same recipient can never be created twice for one campaign", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Uniq${uid().slice(0, 8)}`;
      const lead = await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      const { count } = await tx.whatsAppCampaignRecipient.createMany({ data: [{ campaignId: created.id, leadId: lead.id, status: "PENDING" }], skipDuplicates: true });
      assert.equal(count, 0, "a repeat insert for the same campaign+lead is silently rejected by the unique constraint");
      assert.equal(await tx.whatsAppCampaignRecipient.count({ where: { campaignId: created.id, leadId: lead.id } }), 1);
    });
  });

  it("concurrent claims never let two workers process the same recipient", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Race${uid().slice(0, 8)}`;
      for (let i = 0; i < 5; i++) await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      const [batchA, batchB] = await Promise.all([claimNextBatch(tx, created.id, 10), claimNextBatch(tx, created.id, 10)]);
      const allClaimedIds = [...batchA, ...batchB].map((r) => r.id);
      const uniqueIds = new Set(allClaimedIds);
      assert.equal(allClaimedIds.length, uniqueIds.size, "no recipient id was claimed by both concurrent batches");
      assert.equal(allClaimedIds.length, 5, "every recipient was claimed exactly once across both attempts");
    });
  });
});

describe("failures: one bad recipient never stops the campaign", () => {
  it("a provider rejection for one recipient does not stop the rest of the batch, and creates a FAILED WhatsAppMessage", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Fail${uid().slice(0, 8)}`;
      const bad = await makeLead(tx, { firstName: tag, lastName: "Bad" });
      const good = await makeLead(tx, { firstName: tag, lastName: "Good" });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      const badMobile = (await tx.lead.findUniqueOrThrow({ where: { id: bad.id }, select: { normalizedMobile: true } })).normalizedMobile;
      const { messaging: rejecting } = services(tx, {
        sendTemplateMessage: async (input) => {
          if (input.to === badMobile) throw new WhatsAppSendError("template paused");
          return { providerMessageId: `wamid-${uid()}`, raw: {} };
        },
      });
      const result = await processCampaignBatch(tx, rejecting, created.id, template.id);

      assert.equal(result.claimed, 2);
      assert.equal(result.sent, 2, "a provider rejection still counts as an attempted SENT - see the recipient-status doc comment");
      const badRecipient = await tx.whatsAppCampaignRecipient.findFirstOrThrow({ where: { campaignId: created.id, leadId: bad.id } });
      const goodRecipient = await tx.whatsAppCampaignRecipient.findFirstOrThrow({ where: { campaignId: created.id, leadId: good.id } });
      assert.equal((await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: badRecipient.whatsAppMessageId! } })).status, "FAILED");
      assert.equal((await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: goodRecipient.whatsAppMessageId! } })).status, "SENT");
    });
  });

  it("a recipient with a missing required variable is safely SKIPPED, never sent broken", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign, messaging } = services(tx);
      // order_number needs an order - this recipient has none, so the variable cannot resolve.
      const template = await makeTemplate(tx, { body: "Order {{order_number}}", variables: ["order_number"] });
      const tag = `Missing${uid().slice(0, 8)}`;
      await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      const result = await processCampaignBatch(tx, messaging, created.id, template.id);
      assert.equal(result.skipped, 1);
      assert.equal(result.sent, 0);
      const recipient = await tx.whatsAppCampaignRecipient.findFirstOrThrow({ where: { campaignId: created.id } });
      assert.equal(recipient.status, "SKIPPED");
      assert.match(recipient.failureReason ?? "", /order_number/);
      assert.equal(recipient.whatsAppMessageId, null);
    });
  });

  it("no provider configured skips every recipient safely, without crashing the batch", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `NoProvider${uid().slice(0, 8)}`;
      await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      const unconfigured = new WhatsAppMessagingService(tx, () => null);
      const result = await processCampaignBatch(tx, unconfigured, created.id, template.id);

      assert.equal(result.skipped, 1);
      const recipient = await tx.whatsAppCampaignRecipient.findFirstOrThrow({ where: { campaignId: created.id } });
      assert.match(recipient.failureReason ?? "", /not configured/i);
    });
  });
});

describe("scheduling", () => {
  it("a future scheduledAt launches into SCHEDULED, not RUNNING, and is not processed before its time", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Sched${uid().slice(0, 8)}`;
      await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      const future = new Date(Date.now() + 60 * 60 * 1000);

      const launched = await campaign.launchCampaign(as(a, Role.ADMIN), created.id, { scheduledAt: future });
      assert.equal(launched.status, "SCHEDULED");

      const tick = await tickCampaigns(tx, () => fakeProvider());
      assert.equal(tick.started, 0, "not due yet");
      const row = await tx.whatsAppCampaign.findUniqueOrThrow({ where: { id: created.id }, select: { status: true } });
      assert.equal(row.status, "SCHEDULED");
    });
  });

  it("a due SCHEDULED campaign starts and sends on the next tick, and reaches COMPLETED", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Due${uid().slice(0, 8)}`;
      await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      // A future scheduledAt at launch time (launchCampaign only ever honours a genuinely future
      // one - see its own doc comment), then the tick is given an overridden "now" past that time,
      // so the test proves the due-detection logic itself without an actual sleep.
      const future = new Date(Date.now() + 5000);

      const launched = await campaign.launchCampaign(as(a, Role.ADMIN), created.id, { scheduledAt: future });
      assert.equal(launched.status, "SCHEDULED");
      const tick1 = await tickCampaigns(tx, () => fakeProvider(), new Date(future.getTime() + 1000));
      assert.equal(tick1.started, 1);
      assert.equal(tick1.processed, 1);
      assert.equal(tick1.completed, 1, "one recipient, one batch - completes on the same tick it starts");

      const row = await tx.whatsAppCampaign.findUniqueOrThrow({ where: { id: created.id }, select: { status: true, completedAt: true } });
      assert.equal(row.status, "COMPLETED");
      assert.ok(row.completedAt);
      assert.equal(await tx.activity.count({ where: { referenceType: "WhatsAppCampaign", referenceId: created.id, type: "WHATSAPP_CAMPAIGN_COMPLETED" } }), 1);
    });
  });

  it("running the tick twice never double-sends or double-completes", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `TickTwice${uid().slice(0, 8)}`;
      await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      const future = new Date(Date.now() + 5000);
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, { scheduledAt: future });
      const dueNow = new Date(future.getTime() + 1000);

      await tickCampaigns(tx, () => fakeProvider(), dueNow);
      const second = await tickCampaigns(tx, () => fakeProvider(), dueNow);
      assert.equal(second.started, 0);
      assert.equal(second.processed, 0);
      assert.equal(second.completed, 0);
      assert.equal(await tx.whatsAppCampaignRecipient.count({ where: { campaignId: created.id } }), 1, "no duplicate recipient was ever created");
      assert.equal(await tx.whatsAppCampaignRecipient.count({ where: { campaignId: created.id, status: "SENT" } }), 1, "no double-send");
    });
  });
});

describe("cancel", () => {
  it("cancelling a RUNNING campaign skips unclaimed recipients but never touches an already-sent message", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign, messaging } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Cancel${uid().slice(0, 8)}`;
      await makeLead(tx, { firstName: tag, lastName: "Sent" });
      await makeLead(tx, { firstName: tag, lastName: "Pending" });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      // Send to just one recipient first (simulating a partially-processed batch), then cancel.
      const one = await claimNextBatch(tx, created.id, 1);
      for (const r of one) {
        const message = await messaging.sendTemplateAsSystem({ leadId: r.leadId, templateId: template.id });
        await tx.whatsAppCampaignRecipient.update({ where: { id: r.id }, data: { status: "SENT", whatsAppMessageId: message.id } });
      }

      const cancelled = await campaign.cancelCampaign(as(a, Role.ADMIN), created.id);
      assert.equal(cancelled.status, "CANCELLED");

      const recipients = await tx.whatsAppCampaignRecipient.findMany({ where: { campaignId: created.id } });
      const sentCount = recipients.filter((r) => r.status === "SENT").length;
      const skippedCount = recipients.filter((r) => r.status === "SKIPPED").length;
      assert.equal(sentCount, 1, "the message already sent is never undone");
      assert.equal(skippedCount, 1, "the unclaimed recipient is stopped, not sent");
    });
  });
});

describe("Customer 360, Audit, E7.4 history and E7.5 tracking all reflect a campaign send correctly", () => {
  it("a campaign-sent message appears once on the timeline/audit/history, and its status can still be advanced by E7.5", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const { campaign, messaging } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `C360${uid().slice(0, 8)}`;
      const lead = await makeLead(tx, { firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});
      const result = await processCampaignBatch(tx, messaging, created.id, template.id);
      assert.equal(result.sent, 1);

      // Exactly one Activity for this one logical message - never duplicated for being a campaign send.
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: "WHATSAPP_MESSAGE_SENT" } }), 1);

      const customers = new CustomersService(tx);
      const timeline = await customers.getTimeline(as(a, Role.ADMIN), lead.id, { page: 1, pageSize: 50 });
      assert.equal(timeline.entries.filter((e) => e.type === "WHATSAPP_MESSAGE_SENT").length, 1);

      const recipient = await tx.whatsAppCampaignRecipient.findFirstOrThrow({ where: { campaignId: created.id, leadId: lead.id } });
      const whatsapp = new WhatsAppService(tx);
      const history = await whatsapp.listMessages(as(a, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.ok(history.items.some((i) => i.id === recipient.whatsAppMessageId));

      const providerMessageId = (await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: recipient.whatsAppMessageId! }, select: { providerMessageId: true } })).providerMessageId!;
      await whatsapp.recordStatusUpdate("AISENSY", { providerMessageId, status: "DELIVERED", timestamp: new Date() });
      const updatedStats = (await campaign.getCampaign(as(a, Role.ADMIN), created.id)).stats;
      assert.equal(updatedStats.delivered, 1, "campaign stats reflect E7.5's live message status, computed on read");
    });
  });

  it("recipient visibility is scoped to the viewer's own leads for a salesperson", async () => {
    await inRollback(async (tx) => {
      const a = await admin(tx);
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const { campaign } = services(tx);
      const template = await makeTemplate(tx);
      const tag = `Scope${uid().slice(0, 8)}`;
      await makeLead(tx, { ownerId: rep1.id, firstName: tag });
      await makeLead(tx, { ownerId: rep2.id, firstName: tag });
      const created = await campaign.createCampaign(as(a, Role.ADMIN), { name: "x", templateId: template.id, filters: { search: tag } });
      await campaign.launchCampaign(as(a, Role.ADMIN), created.id, {});

      const asRep1 = await campaign.listRecipients(as(rep1, Role.SALESPERSON), created.id, { page: 1, pageSize: 20 });
      assert.equal(asRep1.pagination.totalItems, 1);
      const asAdmin = await campaign.listRecipients(as(a, Role.ADMIN), created.id, { page: 1, pageSize: 20 });
      assert.equal(asAdmin.pagination.totalItems, 2);
    });
  });
});
