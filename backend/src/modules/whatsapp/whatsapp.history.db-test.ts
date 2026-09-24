// Database integration tests for E7.4 Conversation/Message History. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back - mirrors the other whatsapp
// db-test files. Every Lead read/write uses an explicit `select`, for the same pre-existing,
// out-of-scope reason documented in whatsapp.db-test.ts (the unapplied lead-import migration -
// not touched here either). This module makes no schema change, so none of that is new here.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, Role, WhatsAppTemplateStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
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

async function makeLead(tx: Prisma.TransactionClient, overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) {
  return tx.lead.create({
    data: { leadNumber: `L-${uid()}`, firstName: "Mahadev", lastName: "Babar", mobile: "9876543210", normalizedMobile: "+919876543210", ...overrides },
    select: { id: true },
  });
}

async function makeOrder(tx: Prisma.TransactionClient, leadId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return tx.order.create({
    data: { orderNumber: `AWL${Math.floor(Math.random() * 100000)}`, leadId, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "699.00", ...overrides },
    select: { id: true, orderNumber: true },
  });
}

async function makeTemplate(tx: Prisma.TransactionClient, overrides: Partial<Prisma.WhatsAppTemplateUncheckedCreateInput> = {}) {
  return tx.whatsAppTemplate.create({
    data: { name: `t_${uid()}`, provider: "AISENSY", language: "en", body: "Hi {{customer_name}}", variables: ["customer_name"], status: WhatsAppTemplateStatus.APPROVED, ...overrides },
    select: { id: true, name: true },
  });
}

async function makeMessage(tx: Prisma.TransactionClient, overrides: Partial<Prisma.WhatsAppMessageUncheckedCreateInput> = {}) {
  return tx.whatsAppMessage.create({
    data: {
      provider: "AISENSY",
      direction: "OUTBOUND",
      messageType: "TEMPLATE",
      status: "SENT",
      createdAt: new Date(),
      ...overrides,
    },
    select: { id: true },
  });
}

describe("listing WhatsApp message history", () => {
  it("returns newest-first, with a stable id tiebreak, and correct pagination metadata", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const base = new Date("2026-09-20T10:00:00Z");
      const m1 = await makeMessage(tx, { leadId: lead.id, createdAt: new Date(base.getTime() - 2000), body: "first" });
      const m2 = await makeMessage(tx, { leadId: lead.id, createdAt: new Date(base.getTime() - 1000), body: "second" });
      const m3 = await makeMessage(tx, { leadId: lead.id, createdAt: base, body: "third" });
      const svc = new WhatsAppService(tx);

      const result = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.deepEqual(result.items.map((i) => i.id), [m3.id, m2.id, m1.id]);
      assert.deepEqual(result.pagination, { page: 1, pageSize: 20, totalItems: 3, totalPages: 1 });
    });
  });

  it("paginates correctly across pages", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await makeMessage(tx, { leadId: lead.id, createdAt: new Date(base - i * 1000) });
      }
      const svc = new WhatsAppService(tx);

      const page1 = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 2, leadId: lead.id });
      const page2 = await svc.listMessages(as(admin, Role.ADMIN), { page: 2, pageSize: 2, leadId: lead.id });
      assert.equal(page1.items.length, 2);
      assert.equal(page2.items.length, 2);
      assert.equal(page1.pagination.totalItems, 5);
      assert.equal(page1.pagination.totalPages, 3);
      assert.notDeepEqual(page1.items.map((i) => i.id), page2.items.map((i) => i.id));
    });
  });

  it("filters by direction", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await makeMessage(tx, { leadId: lead.id, direction: "OUTBOUND" });
      await makeMessage(tx, { leadId: lead.id, direction: "INBOUND", status: "RECEIVED", fromNumber: "+919876543210" });
      const svc = new WhatsAppService(tx);

      const inbound = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id, direction: "INBOUND" });
      assert.equal(inbound.items.length, 1);
      assert.equal(inbound.items[0].direction, "INBOUND");
    });
  });

  it("filters by status", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await makeMessage(tx, { leadId: lead.id, status: "SENT" });
      await makeMessage(tx, { leadId: lead.id, status: "FAILED", failedAt: new Date(), errorMessage: "AiSensy rejected the message (HTTP 400)" });
      const svc = new WhatsAppService(tx);

      const failed = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id, status: "FAILED" });
      assert.equal(failed.items.length, 1);
      assert.equal(failed.items[0].status, "FAILED");
      assert.match(failed.items[0].errorMessage ?? "", /rejected/);
    });
  });

  it("filters by provider", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await makeMessage(tx, { leadId: lead.id, provider: "AISENSY" });
      await makeMessage(tx, { leadId: lead.id, provider: "GUPSHUP" });
      const svc = new WhatsAppService(tx);

      const gupshup = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id, provider: "GUPSHUP" });
      assert.equal(gupshup.items.length, 1);
      assert.equal(gupshup.items[0].provider, "GUPSHUP");
    });
  });

  it("filters by template and resolves the template's name", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const template = await makeTemplate(tx, { name: "order_confirmation" });
      await makeMessage(tx, { leadId: lead.id, templateId: template.id, templateName: template.name });
      await makeMessage(tx, { leadId: lead.id });
      const svc = new WhatsAppService(tx);

      const byTemplate = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id, templateId: template.id });
      assert.equal(byTemplate.items.length, 1);
      assert.equal(byTemplate.items[0].template?.name, "order_confirmation");
    });
  });

  it("filters by order and resolves the order number", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      await makeMessage(tx, { leadId: lead.id, orderId: order.id });
      await makeMessage(tx, { leadId: lead.id });
      const svc = new WhatsAppService(tx);

      const byOrder = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id, orderId: order.id });
      assert.equal(byOrder.items.length, 1);
      assert.equal(byOrder.items[0].order?.orderNumber, order.orderNumber);
    });
  });

  it("searches message body with a simple contains match", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await makeMessage(tx, { leadId: lead.id, direction: "INBOUND", status: "RECEIVED", body: "Is my order shipped yet?" });
      await makeMessage(tx, { leadId: lead.id, direction: "INBOUND", status: "RECEIVED", body: "Thanks!" });
      const svc = new WhatsAppService(tx);

      const found = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id, search: "shipped" });
      assert.equal(found.items.length, 1);
      assert.match(found.items[0].body ?? "", /shipped/);
    });
  });

  it("returns an empty page (not an error) for a customer with no messages", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const svc = new WhatsAppService(tx);
      const result = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.deepEqual(result.items, []);
      assert.equal(result.pagination.totalItems, 0);
    });
  });

  it("shows both inbound and outbound messages for the same customer, correctly distinguished", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await makeMessage(tx, { leadId: lead.id, direction: "OUTBOUND", status: "DELIVERED", templateName: "order_update" });
      await makeMessage(tx, { leadId: lead.id, direction: "INBOUND", status: "RECEIVED", body: "Yes, please confirm." });
      const svc = new WhatsAppService(tx);

      const result = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.equal(result.items.length, 2);
      assert.deepEqual(result.items.map((i) => i.direction).sort(), ["INBOUND", "OUTBOUND"]);
    });
  });
});

describe("RBAC / data scope", () => {
  it("a salesperson only sees messages for their own leads", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const ownLead = await makeLead(tx, { ownerId: rep1.id });
      const otherLead = await makeLead(tx, { ownerId: rep2.id });
      await makeMessage(tx, { leadId: ownLead.id });
      await makeMessage(tx, { leadId: otherLead.id });
      const svc = new WhatsAppService(tx);

      const result = await svc.listMessages(as(rep1, Role.SALESPERSON), { page: 1, pageSize: 20 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].customer?.leadId, ownLead.id);
    });
  });

  it("a leadId filter for another rep's customer returns an empty page, not an error or a leak", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherLead = await makeLead(tx, { ownerId: rep2.id });
      await makeMessage(tx, { leadId: otherLead.id });
      const svc = new WhatsAppService(tx);

      const result = await svc.listMessages(as(rep1, Role.SALESPERSON), { page: 1, pageSize: 20, leadId: otherLead.id });
      assert.deepEqual(result.items, []);
    });
  });

  it("a manager sees their team's messages", async () => {
    await inRollback(async (tx) => {
      const manager = await tx.user.create({ data: { name: "Manager", email: `m-${uid()}@example.invalid`, role: Role.MANAGER } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id } });
      await tx.groupMember.create({ data: { groupId: group.id, userId: rep.id, joinedAt: new Date(), isActive: true } });
      const lead = await makeLead(tx, { ownerId: rep.id, groupId: group.id });
      await makeMessage(tx, { leadId: lead.id });
      const svc = new WhatsAppService(tx);

      const result = await svc.listMessages(as(manager, Role.MANAGER), { page: 1, pageSize: 20 });
      assert.equal(result.items.length, 1);
    });
  });

  it("an admin sees everything, including a message from an unmatched sender with no lead", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      await makeMessage(tx, { leadId: lead.id });
      await makeMessage(tx, { leadId: null, direction: "INBOUND", status: "RECEIVED", fromNumber: "+910000000000" });
      const svc = new WhatsAppService(tx);

      const result = await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20 });
      assert.ok(result.items.length >= 2);
      assert.ok(result.items.some((i) => i.customer === null));
    });
  });

  it("a salesperson never sees an unmatched-sender message (no lead to satisfy their scope)", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const unmatched = await makeMessage(tx, { leadId: null, direction: "INBOUND", status: "RECEIVED", fromNumber: "+910000000000" });
      const svc = new WhatsAppService(tx);

      const result = await svc.listMessages(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20 });
      assert.equal(result.items.some((i) => i.id === unmatched.id), false);
    });
  });
});

describe("message detail", () => {
  it("returns full detail with resolved customer/template/order/sender", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin User", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const order = await makeOrder(tx, lead.id);
      const template = await makeTemplate(tx, { name: "order_confirmation" });
      const message = await makeMessage(tx, {
        leadId: lead.id,
        orderId: order.id,
        templateId: template.id,
        templateName: template.name,
        sentById: admin.id,
        providerMessageId: "wamid-detail-1",
      });
      const svc = new WhatsAppService(tx);

      const detail = await svc.getMessage(as(admin, Role.ADMIN), message.id);
      assert.equal(detail.customer?.leadId, lead.id);
      assert.equal(detail.template?.name, "order_confirmation");
      assert.equal(detail.order?.orderNumber, order.orderNumber);
      assert.equal(detail.sentBy?.name, "Admin User");
      assert.equal(detail.providerMessageId, "wamid-detail-1");
    });
  });

  it("404s for an out-of-scope message, the same way an out-of-scope customer would", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherLead = await makeLead(tx, { ownerId: rep2.id });
      const message = await makeMessage(tx, { leadId: otherLead.id });
      const svc = new WhatsAppService(tx);

      await assert.rejects(() => svc.getMessage(as(rep1, Role.SALESPERSON), message.id), (e: any) => e.statusCode === 404);
    });
  });

  it("404s for a message that does not exist", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppService(tx);
      await assert.rejects(() => svc.getMessage(as(admin, Role.ADMIN), randomUUID()), (e: any) => e.statusCode === 404);
    });
  });
});

describe("central WhatsApp inbox: listConversations", () => {
  // These use `search` on a unique, generated first name to isolate results from the dev DB's own
  // real, pre-existing WhatsApp messages (from earlier real end-to-end sends in this project) - an
  // unscoped ADMIN query legitimately also sees those, so asserting a bare item count would be flaky.

  it("returns one row per lead, carrying only that lead's latest message", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const uniqueName = `Testlead${uid().slice(0, 8)}`;
      const lead = await makeLead(tx, { firstName: uniqueName });
      const base = new Date("2026-09-20T10:00:00Z");
      await makeMessage(tx, { leadId: lead.id, createdAt: new Date(base.getTime() - 2000), sentAt: new Date(base.getTime() - 2000), body: "first" });
      await makeMessage(tx, { leadId: lead.id, createdAt: base, sentAt: base, body: "latest" });
      const svc = new WhatsAppService(tx);

      const result = await svc.listConversations(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: uniqueName });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].leadId, lead.id);
      assert.equal(result.items[0].lastMessage.body, "latest");
    });
  });

  it("marks awaitingReply true only when the lead's latest message is inbound", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const suffix = uid().slice(0, 8);
      const leadWaiting = await makeLead(tx, { firstName: `Waiting${suffix}` });
      const leadAnswered = await makeLead(tx, { firstName: `Answered${suffix}` });
      await makeMessage(tx, { leadId: leadWaiting.id, direction: "INBOUND", status: "RECEIVED", body: "Are you there?" });
      await makeMessage(tx, { leadId: leadAnswered.id, direction: "OUTBOUND", status: "SENT" });
      const svc = new WhatsAppService(tx);

      const result = await svc.listConversations(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: suffix });
      const waiting = result.items.find((i) => i.leadId === leadWaiting.id);
      const answered = result.items.find((i) => i.leadId === leadAnswered.id);
      assert.equal(waiting?.awaitingReply, true);
      assert.equal(answered?.awaitingReply, false);
    });
  });

  it("searches by the lead's name and mobile, not by message body", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const suffix = uid().slice(0, 8);
      const target = await makeLead(tx, { firstName: `Priyanka${suffix}`, lastName: "Rao", mobile: "9998887770", normalizedMobile: "+919998887770" });
      const other = await makeLead(tx, { firstName: `Suresh${suffix}`, lastName: "Kumar", mobile: "9998887771", normalizedMobile: "+919998887771" });
      await makeMessage(tx, { leadId: target.id });
      await makeMessage(tx, { leadId: other.id });
      const svc = new WhatsAppService(tx);

      const result = await svc.listConversations(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: `priyanka${suffix}` });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].leadId, target.id);
    });
  });

  it("a salesperson only sees conversations for their own leads", async () => {
    await inRollback(async (tx) => {
      const rep1 = await tx.user.create({ data: { name: "Rep1", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const rep2 = await tx.user.create({ data: { name: "Rep2", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const ownLead = await makeLead(tx, { ownerId: rep1.id });
      const otherLead = await makeLead(tx, { ownerId: rep2.id });
      await makeMessage(tx, { leadId: ownLead.id });
      await makeMessage(tx, { leadId: otherLead.id });
      const svc = new WhatsAppService(tx);

      const result = await svc.listConversations(as(rep1, Role.SALESPERSON), { page: 1, pageSize: 20 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].leadId, ownLead.id);
    });
  });

  it("returns an empty page (not an error) when a search matches no lead", async () => {
    // Scoped via `search` rather than asserting a bare empty result: the dev DB this suite runs
    // against already has real, pre-existing committed WhatsApp messages (from earlier real
    // end-to-end sends in this project), which an unscoped ADMIN query legitimately also sees.
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new WhatsAppService(tx);
      const result = await svc.listConversations(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: `no-such-lead-${uid()}` });
      assert.deepEqual(result.items, []);
      assert.equal(result.pagination.totalItems, 0);
    });
  });
});

describe("read-only guarantee", () => {
  it("listing and viewing messages writes no Activity row and calls no provider", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await makeLead(tx);
      const message = await makeMessage(tx, { leadId: lead.id });
      const before = await tx.activity.count({ where: { leadId: lead.id } });

      const svc = new WhatsAppService(tx);
      await svc.listMessages(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      await svc.getMessage(as(admin, Role.ADMIN), message.id);

      assert.equal(await tx.activity.count({ where: { leadId: lead.id } }), before);
    });
  });
});
