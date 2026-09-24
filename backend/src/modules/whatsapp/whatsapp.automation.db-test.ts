// Database integration tests for E7.6 WhatsApp Lifecycle Automation. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - mirrors every other WhatsApp
// db-test file. Every Lead read/write uses an explicit `select`, for the same pre-existing,
// out-of-scope reason documented in whatsapp.db-test.ts (the unapplied lead-import migration - not
// touched here either).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role, TaskStatus, TaskType, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "../customers/customers.service.js";
import { WhatsAppSendError } from "./whatsapp.provider.js";
import type { WhatsAppProvider } from "./whatsapp.provider.js";
import WhatsAppMessagingService from "./whatsapp.messaging.service.js";
import WhatsAppService from "./whatsapp.service.js";
import LifecycleAutomationService from "./whatsapp.automation.service.js";
import { dispatchOrderLifecycleAutomation, orderAutomationEventKey } from "./whatsapp.automation.triggers.js";
import { sweepFollowUpDueAutomation, sweepPaymentPendingAutomation } from "./whatsapp.automation.scheduler.js";

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
    data: { leadNumber: `L-${uid()}`, firstName: "Anita", lastName: "Rao", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true },
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
    data: { name: `t_${uid()}`, provider: "AISENSY", language: "en", body: "Hi {{customer_name}}, order {{order_number}}.", variables: ["customer_name", "order_number"], status: WhatsAppTemplateStatus.APPROVED, ...overrides },
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

/** Wires a LifecycleAutomationService to a fake (never-real-network) provider, all bound to the same tx. */
function automationWith(tx: Prisma.TransactionClient, providerOverrides: Partial<WhatsAppProvider> = {}) {
  const messaging = new WhatsAppMessagingService(tx, () => fakeProvider(providerOverrides));
  return new LifecycleAutomationService(tx, messaging);
}

async function enableAutomation(tx: Prisma.TransactionClient, admin: { id: string; email: string }, type: string, templateId: string) {
  const automation = automationWith(tx);
  await automation.updateConfig(as(admin, Role.ADMIN), type as any, { enabled: true, templateId });
}

describe("order-level automations (ORDER_CONFIRMED/SHIPPED/OUT_FOR_DELIVERY/DELIVERED)", () => {
  for (const type of ["ORDER_CONFIRMED", "ORDER_SHIPPED", "ORDER_OUT_FOR_DELIVERY", "ORDER_DELIVERED"] as const) {
    it(`${type} sends the configured APPROVED template`, async () => {
      await inRollback(async (tx) => {
        const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
        const lead = await makeLead(tx);
        const order = await makeOrder(tx, lead.id);
        const template = await makeTemplate(tx);
        await enableAutomation(tx, admin, type, template.id);
        const automation = automationWith(tx);

        const outcome = await automation.dispatch({ type, leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey(type, order.id) });

        assert.equal(outcome.outcome, "sent");
        const message = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: (outcome as any).whatsAppMessageId } });
        assert.equal(message.templateId, template.id);
        assert.equal(message.orderId, order.id);
        assert.equal(message.leadId, lead.id);
        assert.equal(message.direction, "OUTBOUND");
      });
    });
  }

  it("does not trigger repeatedly for unrelated updates to the same confirmed order - dispatchOrderLifecycleAutomation only fires on a real status transition", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id, { status: OrderStatus.CONFIRMED });
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_CONFIRMED", template.id);
      const automation = automationWith(tx);

      // A real transition: DRAFT/never-existed -> CONFIRMED.
      await dispatchOrderLifecycleAutomation({ action: "created", orderId: order.id, lead: { leadId: lead.id, action: "created", matchedBy: null }, items: 0, payments: { created: 0, updated: 0, deleted: 0 }, shipments: { created: 0, updated: 0, deleted: 0 }, previousStatus: null, status: OrderStatus.CONFIRMED }, automation);
      // An unrelated re-sync of the same, still-CONFIRMED order (previousStatus === status): must not re-fire.
      await dispatchOrderLifecycleAutomation({ action: "updated", orderId: order.id, lead: { leadId: lead.id, action: "matched", matchedBy: null }, items: 0, payments: { created: 0, updated: 0, deleted: 0 }, shipments: { created: 0, updated: 0, deleted: 0 }, previousStatus: OrderStatus.CONFIRMED, status: OrderStatus.CONFIRMED }, automation);

      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 1);
      assert.equal(await tx.whatsAppAutomationRun.count({ where: { orderId: order.id } }), 1);
    });
  });
});

describe("idempotency", () => {
  it("a duplicate order-confirmed event never sends a second message", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_CONFIRMED", template.id);
      const automation = automationWith(tx);
      const key = orderAutomationEventKey("ORDER_CONFIRMED", order.id);

      const first = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: key });
      const second = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: key });

      assert.equal(first.outcome, "sent");
      assert.equal(second.outcome, "duplicate");
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 1);
    });
  });

  it("a duplicate shipped/out-for-delivery/delivered event never sends a second message (same eventKey mechanism)", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_DELIVERED", template.id);
      const automation = automationWith(tx);
      const key = orderAutomationEventKey("ORDER_DELIVERED", order.id);

      await Promise.all([
        automation.dispatch({ type: "ORDER_DELIVERED", leadId: lead.id, orderId: order.id, eventKey: key }),
        automation.dispatch({ type: "ORDER_DELIVERED", leadId: lead.id, orderId: order.id, eventKey: key }),
      ]);

      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 1, "concurrent duplicate triggers still send at most once");
      assert.equal(await tx.whatsAppAutomationRun.count({ where: { eventKey: key } }), 1);
    });
  });

  it("a payment-pending scheduler run twice the same day never sends a second reminder", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id, { status: OrderStatus.CONFIRMED, totalAmount: "1000.00" });
      await tx.payment.create({ data: { orderId: order.id, amount: "400.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "PAYMENT_PENDING", template.id);

      const now = new Date("2026-09-20T09:00:00Z");
      const scope = { id: order.id };
      const first = await sweepPaymentPendingAutomation(now, tx, automationWith(tx), scope);
      const second = await sweepPaymentPendingAutomation(new Date("2026-09-20T18:00:00Z"), tx, automationWith(tx), scope);

      assert.equal(first.dispatched, 1);
      assert.equal(second.dispatched, 0, "the same calendar day never re-sends");
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 1);
    });
  });

  it("a follow-up-due scheduler run twice never sends a second follow-up", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep.id });
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}, checking in!", variables: ["customer_name"] });
      await enableAutomation(tx, admin, "FOLLOW_UP_DUE", template.id);
      await tx.task.create({ data: { leadId: lead.id, assignedToId: rep.id, type: TaskType.FOLLOW_UP, status: TaskStatus.PENDING, title: "Follow up", scheduledAt: new Date("2026-09-19T00:00:00Z") } });

      const now = new Date("2026-09-20T09:00:00Z");
      const first = await sweepFollowUpDueAutomation(now, tx, automationWith(tx));
      const second = await sweepFollowUpDueAutomation(now, tx, automationWith(tx));

      assert.equal(first.dispatched, 1);
      assert.equal(second.dispatched, 0);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 1);
    });
  });
});

describe("payment pending automation", () => {
  it("sends a reminder for an order with a genuinely outstanding balance (existing reconciliation definition)", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id, { status: OrderStatus.CONFIRMED, totalAmount: "1000.00" });
      await tx.payment.create({ data: { orderId: order.id, amount: "1000.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}, {{outstanding_amount}} is due for order {{order_number}}.", variables: ["customer_name", "outstanding_amount", "order_number"] });
      await enableAutomation(tx, admin, "PAYMENT_PENDING", template.id);

      const result = await sweepPaymentPendingAutomation(new Date(), tx, automationWith(tx), { id: order.id });
      assert.equal(result.dispatched, 1);
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 1);
    });
  });

  it("never reminds a fully paid order", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id, { status: OrderStatus.CONFIRMED, totalAmount: "1000.00" });
      await tx.payment.create({ data: { orderId: order.id, amount: "1000.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "PAYMENT_PENDING", template.id);

      const result = await sweepPaymentPendingAutomation(new Date(), tx, automationWith(tx), { id: order.id });
      assert.equal(result.dispatched, 0);
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 0);
    });
  });

  it("never reminds a cancelled or refunded order", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "PAYMENT_PENDING", template.id);

      const lead1 = await makeLead(tx);
      const cancelled = await makeOrder(tx, lead1.id, { status: OrderStatus.CANCELLED, totalAmount: "1000.00" });
      const lead2 = await makeLead(tx, { normalizedMobile: "+919876500002" });
      const refunded = await makeOrder(tx, lead2.id, { status: OrderStatus.REFUNDED, totalAmount: "1000.00" });

      const result = await sweepPaymentPendingAutomation(new Date(), tx, automationWith(tx), { id: { in: [cancelled.id, refunded.id] } });
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: { in: [cancelled.id, refunded.id] } } }), 0);
      assert.equal(result.dispatched, 0);
    });
  });
});

describe("follow-up due automation", () => {
  it("sends WhatsApp follow-up for a due, pending follow-up task", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep.id });
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}!", variables: ["customer_name"] });
      await enableAutomation(tx, admin, "FOLLOW_UP_DUE", template.id);
      const task = await tx.task.create({ data: { leadId: lead.id, assignedToId: rep.id, type: TaskType.FOLLOW_UP, status: TaskStatus.PENDING, title: "Follow up", scheduledAt: new Date("2026-09-19T00:00:00Z") }, select: { id: true } });

      const result = await sweepFollowUpDueAutomation(new Date("2026-09-20T00:00:00Z"), tx, automationWith(tx));
      assert.equal(result.dispatched, 1);
      const run = await tx.whatsAppAutomationRun.findFirst({ where: { orderId: null, leadId: lead.id, automationType: "FOLLOW_UP_DUE" } });
      assert.equal(run?.status, "SENT");
      void task;
    });
  });

  it("does not send for a follow-up task that is not yet due", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep.id });
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}!", variables: ["customer_name"] });
      await enableAutomation(tx, admin, "FOLLOW_UP_DUE", template.id);
      await tx.task.create({ data: { leadId: lead.id, assignedToId: rep.id, type: TaskType.FOLLOW_UP, status: TaskStatus.PENDING, title: "Follow up", scheduledAt: new Date("2026-09-25T00:00:00Z") } });

      const result = await sweepFollowUpDueAutomation(new Date("2026-09-20T00:00:00Z"), tx, automationWith(tx));
      assert.equal(result.dispatched, 0);
    });
  });

  it("ignores a completed/cancelled task and a non-follow-up task type", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const template = await makeTemplate(tx, { body: "Hi {{customer_name}}!", variables: ["customer_name"] });
      await enableAutomation(tx, admin, "FOLLOW_UP_DUE", template.id);

      const lead1 = await makeLead(tx, { ownerId: rep.id });
      await tx.task.create({ data: { leadId: lead1.id, assignedToId: rep.id, type: TaskType.FOLLOW_UP, status: TaskStatus.COMPLETED, title: "Done", scheduledAt: new Date("2026-09-19T00:00:00Z") } });
      const lead2 = await makeLead(tx, { ownerId: rep.id, normalizedMobile: "+919876500003" });
      await tx.task.create({ data: { leadId: lead2.id, assignedToId: rep.id, type: TaskType.CALL, status: TaskStatus.PENDING, title: "Call", scheduledAt: new Date("2026-09-19T00:00:00Z") } });

      const result = await sweepFollowUpDueAutomation(new Date("2026-09-20T00:00:00Z"), tx, automationWith(tx));
      assert.equal(result.dispatched, 0);
    });
  });
});

describe("configuration gating", () => {
  it("a disabled automation does not send", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      const automation = automationWith(tx);
      await automation.updateConfig(as(admin, Role.ADMIN), "ORDER_CONFIRMED" as any, { enabled: false, templateId: template.id });

      const outcome = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id) });

      assert.equal(outcome.outcome, "skipped");
      assert.match((outcome as any).reason, /disabled/i);
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 0);
    });
  });

  it("no template configured does not send", async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const automation = automationWith(tx);

      // Nothing configured at all - the six automations still "work out of the box" (enabled by
      // default), they just have nothing to send until an admin picks a template.
      const outcome = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id) });

      assert.equal(outcome.outcome, "skipped");
      assert.match((outcome as any).reason, /no whatsapp template/i);
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 0);
    });
  });

  it("a template that is not (or no longer) APPROVED is never sent, even if configured", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx, { status: WhatsAppTemplateStatus.APPROVED });
      const automation = automationWith(tx);
      await automation.updateConfig(as(admin, Role.ADMIN), "ORDER_CONFIRMED" as any, { enabled: true, templateId: template.id });
      // The provider later un-approves it (a real sync could do this) - the config still points at
      // it, but dispatch must re-check the template's current status, not trust the config blindly.
      await tx.whatsAppTemplate.update({ where: { id: template.id }, data: { status: WhatsAppTemplateStatus.REJECTED } });

      const outcome = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id) });

      assert.equal(outcome.outcome, "skipped");
      assert.match((outcome as any).reason, /REJECTED/);
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 0);
    });
  });

  it("refuses to assign a non-APPROVED template to an automation in the first place", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const template = await makeTemplate(tx, { status: WhatsAppTemplateStatus.PENDING });
      const automation = automationWith(tx);
      await assert.rejects(() => automation.updateConfig(as(admin, Role.ADMIN), "ORDER_CONFIRMED" as any, { enabled: true, templateId: template.id }), (e: any) => e.statusCode === 400);
    });
  });
});

describe("variable resolution safety", () => {
  it("safely skips when a required variable cannot be resolved, instead of sending a broken message", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const lead = await makeLead(tx, { ownerId: rep.id });
      // A follow-up automation has no order context; a template needing order_number cannot resolve.
      const template = await makeTemplate(tx, { body: "Your order {{order_number}} needs attention.", variables: ["order_number"] });
      await enableAutomation(tx, admin, "FOLLOW_UP_DUE", template.id);

      const automation = automationWith(tx);
      const outcome = await automation.dispatch({ type: "FOLLOW_UP_DUE", leadId: lead.id, eventKey: "FOLLOW_UP_DUE:task-x" });

      assert.equal(outcome.outcome, "skipped");
      assert.match((outcome as any).reason, /order_number/);
      assert.equal(await tx.whatsAppMessage.count({ where: { leadId: lead.id } }), 0);
    });
  });
});

describe("provider and failure behaviour", () => {
  it("WhatsApp not configured skips the automation and never breaks the caller", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_CONFIRMED", template.id);
      const automation = new LifecycleAutomationService(tx, new WhatsAppMessagingService(tx, () => null)); // no configured provider

      const outcome = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id) });

      assert.equal(outcome.outcome, "skipped");
      assert.match((outcome as any).reason, /not configured/i);
      assert.equal(await tx.whatsAppMessage.count({ where: { orderId: order.id } }), 0);
    });
  });

  it("a provider rejection still produces a FAILED WhatsAppMessage, and the run is recorded as an attempted send", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_CONFIRMED", template.id);
      const automation = automationWith(tx, { sendTemplateMessage: async () => { throw new WhatsAppSendError("template paused by provider"); } });

      const outcome = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id) });

      assert.equal(outcome.outcome, "sent");
      const message = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: (outcome as any).whatsAppMessageId } });
      assert.equal(message.status, "FAILED");
      assert.equal(message.errorMessage, "template paused by provider");
      const run = await tx.whatsAppAutomationRun.findUniqueOrThrow({ where: { id: (outcome as any).runId } });
      assert.equal(run.status, "SENT");
    });
  });

  it("an unexpected error during the automation's own execution is recorded as FAILED, safely, without throwing", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_CONFIRMED", template.id);
      const automation = automationWith(tx, { sendTemplateMessage: async () => { throw new Error("ECONNRESET"); } });

      const outcome = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id) });

      assert.equal(outcome.outcome, "failed");
      assert.match((outcome as any).reason, /ECONNRESET/);
      const run = await tx.whatsAppAutomationRun.findFirst({ where: { orderId: order.id } });
      assert.equal(run?.status, "FAILED");
    });
  });

  it("dispatchOrderLifecycleAutomation (the shopify.sync.ts integration point) never throws even when the automation fails unexpectedly", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_CONFIRMED", template.id);
      const automation = automationWith(tx, { sendTemplateMessage: async () => { throw new Error("boom"); } });

      await assert.doesNotReject(() =>
        dispatchOrderLifecycleAutomation({ action: "created", orderId: order.id, lead: { leadId: lead.id, action: "created", matchedBy: null }, items: 0, payments: { created: 0, updated: 0, deleted: 0 }, shipments: { created: 0, updated: 0, deleted: 0 }, previousStatus: null, status: OrderStatus.CONFIRMED }, automation),
      );
    });
  });
});

describe("Customer 360, Audit Trail, E7.4 history and E7.5 status tracking all still work for an automated message", () => {
  it("the automated send appears exactly once on the timeline/audit, in E7.4's history API, and its status can still be advanced by E7.5", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx);
      await enableAutomation(tx, admin, "ORDER_CONFIRMED", template.id);
      const automation = automationWith(tx);

      const outcome = await automation.dispatch({ type: "ORDER_CONFIRMED", leadId: lead.id, orderId: order.id, eventKey: orderAutomationEventKey("ORDER_CONFIRMED", order.id) });
      assert.equal(outcome.outcome, "sent");
      const messageId = (outcome as any).whatsAppMessageId as string;

      // Exactly one Activity for this one logical message - never a second row for the same event.
      assert.equal(await tx.activity.count({ where: { leadId: lead.id, type: "WHATSAPP_MESSAGE_SENT" } }), 1);
      const activity = await tx.activity.findFirstOrThrow({ where: { leadId: lead.id, type: "WHATSAPP_MESSAGE_SENT" } });
      assert.equal(activity.source, "SYSTEM");
      assert.equal(activity.actorId, null, "never attributed to a fabricated human user");

      const customers = new CustomersService(tx);
      const timeline = await customers.getTimeline(as(admin, Role.ADMIN), lead.id, { page: 1, pageSize: 50 });
      assert.equal(timeline.entries.filter((e) => e.type === "WHATSAPP_MESSAGE_SENT").length, 1);

      const whatsapp = new WhatsAppService(tx);
      const history = await whatsapp.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      const historyItem = history.items.find((i) => i.id === messageId);
      assert.ok(historyItem, "the automated message shows up in E7.4's message history");
      assert.equal(historyItem!.template?.id, template.id);

      const message = await tx.whatsAppMessage.findUniqueOrThrow({ where: { id: messageId }, select: { providerMessageId: true } });
      await whatsapp.recordStatusUpdate("AISENSY", { providerMessageId: message.providerMessageId!, status: "DELIVERED", timestamp: new Date() });
      const detail = await whatsapp.getMessage(as(admin, Role.ADMIN), messageId);
      assert.equal(detail.status, "DELIVERED", "E7.5 status tracking works the same for an automation-originated message");
    });
  });
});

describe("automation configuration API", () => {
  it("lists all six required automations even with nothing configured yet, and reflects an update", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const automation = automationWith(tx);

      const before = await automation.listConfigs();
      assert.equal(before.length, 6);
      assert.ok(before.every((c) => c.enabled === true && c.template === null));

      const template = await makeTemplate(tx);
      const updated = await automation.updateConfig(as(admin, Role.ADMIN), "PAYMENT_PENDING" as any, { enabled: true, templateId: template.id });
      assert.equal(updated.template?.id, template.id);
      assert.equal(updated.updatedBy?.id, admin.id);
    });
  });
});
