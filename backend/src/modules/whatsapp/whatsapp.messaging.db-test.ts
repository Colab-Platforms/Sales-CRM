// Database integration tests for E7.3 Template-Based Messaging. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - mirrors whatsapp.db-test.ts
// and whatsapp.template.db-test.ts. Every Lead read/write uses an explicit `select`, for the same
// pre-existing, out-of-scope reason documented in whatsapp.db-test.ts (the unapplied lead-import
// migration - not touched here either).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, OrderSource, OrderStatus, Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "../customers/customers.service.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";

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

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true },
  });
}

async function makeOrder(tx: Prisma.TransactionClient, leadId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return tx.order.create({
    data: { orderNumber: `AWL${Math.floor(Math.random() * 100000)}`, leadId, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "699.00", ...overrides },
    select: { id: true },
  });
}

async function makeTemplate(tx: Prisma.TransactionClient, overrides: Partial<Prisma.WhatsAppTemplateUncheckedCreateInput> = {}) {
  return tx.whatsAppTemplate.create({
    data: { name: `t_${uid()}`, provider: "AISENSY", language: "en", body: "Hi {{customer_name}}, your order {{order_number}} is confirmed.", variables: ["customer_name", "order_number"], status: WhatsAppTemplateStatus.APPROVED, ...overrides },
    select: { id: true, name: true, variables: true },
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

describe("previewing a template message", () => {
  it("resolves variables and renders the body, writing nothing to the database", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider());

      const preview = await svc.previewTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id, orderId: order.id });
      assert.equal(preview.resolvedBody, `Hi Mahadev Babar, your order ${(await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { orderNumber: true } })).orderNumber} is confirmed.`);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
      assert.equal(await tx.activity.count({ where: { leadId: lead.id } }), 0);
    });
  });

  it("does not require the configured provider to match the template's provider", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx, { provider: "GUPSHUP", body: "Hi {{customer_name}}", variables: ["customer_name"] });
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider({ id: "AISENSY" }));
      const preview = await svc.previewTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id });
      assert.equal(preview.resolvedBody, "Hi Mahadev Babar");
    });
  });

  for (const status of ["DRAFT", "PENDING", "REJECTED", "DISABLED"] as const) {
    it(`refuses to preview a ${status} template`, async () => {
      await inRollback(async (tx) => {
        const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
        const lead = await makeLead(tx);
        const template = await makeTemplate(tx, { status: WhatsAppTemplateStatus[status] });
        const svc = new WhatsAppMessagingService(tx, () => fakeProvider());
        await assert.rejects(() => svc.previewTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id }), (e: any) => e.statusCode === 400);
      });
    });
  }

  it("404s for a customer outside the caller's scope", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep2.id });
      const template = await makeTemplate(tx);
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider());
      await assert.rejects(() => svc.previewTemplate(as(rep1, Role.SALESPERSON), { leadId: lead.id, templateId: template.id }), (e: any) => e.statusCode === 404);
    });
  });
});

describe("sending a template message", () => {
  it("full happy path: resolves variables in template order, sends, persists, and audits", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      let capturedParams: string[] | null = null;
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider({
        sendTemplateMessage: async (input) => {
          capturedParams = input.params;
          return { providerMessageId: "wamid-happy-1", raw: {} };
        },
      }));

      const result = await svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id, orderId: order.id });

      assert.equal(result.status, "SENT");
      assert.equal(result.templateId, template.id);
      assert.equal(result.orderId, order.id);
      assert.deepEqual(capturedParams, ["Mahadev Babar", (await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { orderNumber: true } })).orderNumber]);

      const activity = await tx.activity.findFirst({ where: { type: ActivityType.WHATSAPP_MESSAGE_SENT, referenceId: result.id } });
      assert.ok(activity);
      assert.equal(activity!.orderId, order.id);
      assert.equal(activity!.actorId, admin.id);
    });
  });

  for (const status of ["DRAFT", "PENDING", "REJECTED", "DISABLED"] as const) {
    it(`never sends a ${status} template`, async () => {
      await inRollback(async (tx) => {
        const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
        const lead = await makeLead(tx);
        const template = await makeTemplate(tx, { status: WhatsAppTemplateStatus[status] });
        let called = false;
        const svc = new WhatsAppMessagingService(tx, () => fakeProvider({ sendTemplateMessage: async () => { called = true; return { providerMessageId: "x", raw: {} }; } }));

        await assert.rejects(() => svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id }), (e: any) => e.statusCode === 400);
        assert.equal(called, false);
        assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
      });
    });
  }

  it("refuses to send when the template belongs to a different provider than the one configured", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx, { provider: "GUPSHUP" });
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider({ id: "AISENSY" }));
      await assert.rejects(() => svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id }), (e: any) => e.statusCode === 400);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
    });
  });

  it("reports 503 when WhatsApp is not configured, and sends nothing", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx);
      const svc = new WhatsAppMessagingService(tx, () => null);
      await assert.rejects(() => svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id }), (e: any) => e.statusCode === 503);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
    });
  });

  it("refuses an order that belongs to a different customer", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const otherLead = await makeLead(tx);
      const otherOrder = await makeOrder(tx, otherLead.id);
      const template = await makeTemplate(tx);
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider());
      await assert.rejects(() => svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id, orderId: otherOrder.id }), (e: any) => e.statusCode === 400);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
    });
  });

  it("404s for a customer outside the caller's scope - never reveals whether the customer exists", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep2.id });
      const template = await makeTemplate(tx);
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider());
      await assert.rejects(() => svc.sendTemplate(as(rep1, Role.SALESPERSON), { leadId: lead.id, templateId: template.id }), (e: any) => e.statusCode === 404);
    });
  });

  it("lets a manager send to their team member's customer", async () => {
    await inRollback(async (tx) => {
      const manager = await tx.user.create({ data: { name: "Manager", email: `m-${uid()}@example.invalid`, role: Role.MANAGER } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id } });
      await tx.groupMember.create({ data: { groupId: group.id, userId: rep.id, joinedAt: new Date(), isActive: true } });
      const lead = await makeLead(tx, { ownerId: rep.id, groupId: group.id });
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}", variables: ["customer_name"] });
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider());
      const result = await svc.sendTemplate(as(manager, Role.MANAGER), { leadId: lead.id, templateId: template.id });
      assert.equal(result.status, "SENT");
    });
  });

  it("fails validation on a missing variable and persists nothing", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx); // needs order_number, no order given
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider());
      await assert.rejects(() => svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id }), (e: any) => e.statusCode === 400 && /order_number/.test(e.message));
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
    });
  });

  it("persists a FAILED message (never DELIVERED/SENT) when the provider rejects the request, and audits it", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}", variables: ["customer_name"] });
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider({ sendTemplateMessage: async () => { throw new WhatsAppSendError("AiSensy rejected the message (HTTP 400)"); } }));

      const result = await svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id });
      assert.equal(result.status, "FAILED");
      assert.equal(result.providerMessageId, null);
      assert.match(result.errorMessage ?? "", /rejected/);

      const activity = await tx.activity.findFirst({ where: { type: ActivityType.WHATSAPP_FAILED, referenceId: result.id } });
      assert.ok(activity, "a failed send is still audited");
    });
  });

  it("does not create a duplicate message for the same customer/template/order within the guard window", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      let sendCount = 0;
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider({ sendTemplateMessage: async () => { sendCount++; return { providerMessageId: `wamid-${sendCount}`, raw: {} }; } }));

      const first = await svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id, orderId: order.id });
      const second = await svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id, orderId: order.id });

      assert.equal(second.id, first.id, "the second call returns the same message, not a new one");
      assert.equal(sendCount, 1, "the provider is only ever called once");
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 1);
    });
  });

  it("a resend to a different order is not blocked by the duplicate guard", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order1 = await makeOrder(tx, lead.id);
      const order2 = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      const svc = new WhatsAppMessagingService(tx, () => fakeProvider());

      const first = await svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id, orderId: order1.id });
      const second = await svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id, orderId: order2.id });
      assert.notEqual(second.id, first.id);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 2);
    });
  });

  it("recovers cleanly if two sends race to the same provider message id", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}", variables: ["customer_name"] });
      // Simulate the other half of the race: a row already exists under the provider message id
      // the fake provider is about to "return" again, for a different customer (so the duplicate
      // guard above does not intervene first).
      const otherLead = await makeLead(tx);
      await tx.whatsAppMessage.create({ data: { provider: "AISENSY", providerMessageId: "wamid-race", direction: "OUTBOUND", messageType: "TEMPLATE", status: "SENT", leadId: otherLead.id, sentAt: new Date() } });

      const svc = new WhatsAppMessagingService(tx, () => fakeProvider({ sendTemplateMessage: async () => ({ providerMessageId: "wamid-race", raw: {} }) }));
      const result = await svc.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id });
      const stored = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: result.id }, select: { leadId: true } });
      assert.equal(stored.leadId, otherLead.id, "returns the row that actually won the unique constraint, not a crash");
    });
  });
});

describe("Customer 360 timeline shows a template send with provider and sender", () => {
  it("includes the template name, provider, and the sending user as actor", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin User", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx, { name: "order_confirmation", body: "Hi {{customer_name}}", variables: ["customer_name"] });
      const messaging = new WhatsAppMessagingService(tx, () => fakeProvider());
      await messaging.sendTemplate(as(admin, Role.ADMIN), { leadId: lead.id, templateId: template.id });

      const customers = new CustomersService(tx);
      const timeline = await customers.getTimeline(as(admin, Role.ADMIN), lead.id, { page: 1, pageSize: 50 });
      const sentEntry = timeline.entries.find((e) => e.type === "WHATSAPP_MESSAGE_SENT");
      assert.ok(sentEntry);
      assert.match(sentEntry!.title, /order_confirmation/);
      assert.match(sentEntry!.title, /AISENSY/);
      assert.equal(sentEntry!.actor?.name, "Admin User");
    });
  });
});
