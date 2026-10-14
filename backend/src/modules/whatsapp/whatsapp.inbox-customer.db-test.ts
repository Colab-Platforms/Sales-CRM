// Database tests: the customer behind a WhatsApp conversation (the Inbox's right-hand panel) is READABLE across teams for admin, manager and salesperson - details, Next Best Action and
// orders - while everything that changes a customer keeps its scope. Run with: npm run test:db. Rolled-back transaction only; nothing is sent.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { OrderSource, OrderStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "../customers/customers.service.js";
import WhatsAppService from "./whatsapp.service.js";
import { resolveConversationLeadId } from "./whatsapp.conversation.controller.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 90_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role }) as never;
const notFound = (p: Promise<unknown>) => assert.rejects(p, (e: any) => e.statusCode === 404);

let phoneSeq = 0;
async function world(tx: Prisma.TransactionClient) {
  const mk = (role: Role, name: string) => tx.user.create({ data: { name, username: `u-${uid()}`, role }, select: { id: true, username: true } });
  const [admin, mgrB, repA, repB] = [await mk(Role.ADMIN, "Admin"), await mk(Role.MANAGER, "MgrB"), await mk(Role.SALESPERSON, "RepA"), await mk(Role.SALESPERSON, "RepB")];
  const lead = (over: Partial<Prisma.LeadUncheckedCreateInput> = {}) => {
    phoneSeq += 1;
    const mobile = `98763${String(10000 + phoneSeq).padStart(5, "0")}`;
    return tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Test1", lastName: "Pip", mobile, normalizedMobile: `+91${mobile}`, email: "vinayak@gmail.com", ownerId: repA.id, ...over }, select: { id: true, mobile: true } });
  };
  const conversation = (leadId: string) => tx.whatsAppMessage.create({ data: { provider: "META", providerMessageId: `wamid-${uid()}`, direction: "INBOUND", messageType: "TEXT", status: "RECEIVED", leadId, body: "hi" } });
  const order = (leadId: string, over: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    tx.order.create({ data: { orderNumber: `CRM-${uid().slice(0, 10)}`, leadId, source: OrderSource.SALESPERSON, status: OrderStatus.PENDING_PAYMENT, currency: "INR", totalAmount: "584.10", ...over }, select: { id: true, orderNumber: true } });
  return { admin, mgrB, repA, repB, lead, conversation, order, customers: new CustomersService(tx) };
}
const VIEWERS = (w: Awaited<ReturnType<typeof world>>) => [["ADMIN", w.admin, Role.ADMIN], ["MANAGER (other team)", w.mgrB, Role.MANAGER], ["SALESPERSON/TELECALLER (not the owner)", w.repB, Role.SALESPERSON]] as const;

describe("Inbox customer panel: details and orders are readable across teams", () => {
  it("another team's customer: admin, manager and salesperson see the identity, owner, source, Next Best Action (outstanding payment) and orders, marked read-only", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const source = await tx.source.create({ data: { name: "Facebook", code: `fb-${uid()}` }, select: { id: true } });
      const lead = await w.lead({ sourceId: source.id });
      await w.conversation(lead.id);
      const order = await w.order(lead.id);
      for (const [label, u, role] of VIEWERS(w)) {
        const c = await w.customers.getCustomer360(as(u, role), lead.id, { inboxRead: true });
        assert.equal(c.profile.leadId, lead.id, label);
        assert.equal(c.profile.email, "vinayak@gmail.com", label);
        assert.equal(c.profile.owner?.name, "RepA", label);
        assert.equal(c.profile.source?.name, "Facebook", label);
        assert.deepEqual(c.orders.map((o) => o.orderNumber), [order.orderNumber], `${label}: orders`);
        assert.equal(c.nextBestAction.action, "FOLLOW_UP_PAYMENT", `${label}: NBA`);
        assert.equal(c.nextBestAction.metrics.outstandingAmount, "584.10", `${label}: outstanding payment`);
        // an admin has no scope limit (full access, so not read-only); a manager / salesperson outside the customer's team is read-only
        assert.equal(c.readOnly, role === Role.ADMIN ? undefined : true, `${label}: read-only flag`);
      }
      // the owner is unaffected: same data, no read-only flag
      const own = await w.customers.getCustomer360(as(w.repA, Role.SALESPERSON), lead.id, { inboxRead: true });
      assert.equal(own.readOnly, undefined);
      assert.equal(own.orders.length, 1);
    });
  });

  it("a customer with no orders still renders its details (empty orders); a lead with only a name and phone renders too", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const bare = await w.lead({ lastName: null, email: null, ownerId: null });
      await w.conversation(bare.id);
      const c = await w.customers.getCustomer360(as(w.repB, Role.SALESPERSON), bare.id, { inboxRead: true });
      assert.equal(c.orders.length, 0);
      assert.equal(c.profile.email, null);
      assert.equal(c.profile.owner, null);
      assert.ok(c.profile.name);
      assert.ok(c.nextBestAction, "the recommendation is still derived");
    });
  });

  it("a contact created from WhatsApp (a brand-new number) resolves to its new lead immediately, for another team's manager too", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await new WhatsAppService(tx).recordInboundMessage("META", { providerMessageId: `wamid-${uid()}`, from: "919812366001", to: null, messageType: "TEXT", text: "hello", timestamp: new Date() });
      const created = await tx.lead.findFirstOrThrow({ where: { normalizedMobile: "+919812366001" }, select: { id: true } });
      const c = await w.customers.getCustomer360(as(w.mgrB, Role.MANAGER), created.id, { inboxRead: true });
      assert.equal(c.profile.leadId, created.id);
      assert.match(c.profile.mobile ?? "", /9812366001/);
      assert.deepEqual(c.orders, []);
    });
  });

  it("duplicate leads sharing a phone: each lead shows only ITS OWN orders - no mixing, deterministic by the lead the conversation belongs to", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.lead({ createdAt: new Date("2026-09-01T00:00:00Z") });
      const b = await w.lead({ mobile: a.mobile!, normalizedMobile: `+91${a.mobile}`, createdAt: new Date("2026-10-01T00:00:00Z") });
      await w.conversation(a.id);
      await w.conversation(b.id);
      const oa = await w.order(a.id);
      const ob = await w.order(b.id);
      const ca = await w.customers.getCustomer360(as(w.mgrB, Role.MANAGER), a.id, { inboxRead: true });
      const cb = await w.customers.getCustomer360(as(w.mgrB, Role.MANAGER), b.id, { inboxRead: true });
      assert.deepEqual(ca.orders.map((o) => o.orderNumber), [oa.orderNumber]);
      assert.deepEqual(cb.orders.map((o) => o.orderNumber), [ob.orderNumber]);
    });
  });

  it("conversation -> customer resolution: a lead id, a conversation id and an unknown id", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const lead = await w.lead();
      const conv = await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: "META" }, select: { id: true } });
      assert.equal(await resolveConversationLeadId(lead.id, tx as never), lead.id);
      assert.equal(await resolveConversationLeadId(conv.id, tx as never), lead.id);
      assert.equal(await resolveConversationLeadId(uid(), tx as never), null);
    });
  });
});

describe("Inbox customer panel: reading does not grant writes, and other scopes are unchanged", () => {
  it("without the Inbox flag, Customer 360 is unchanged (another team's customer is 'not found'); a customer with NO conversation stays hidden even with the flag; HR sees nothing", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const withConv = await w.lead();
      await w.conversation(withConv.id);
      const without = await w.lead();
      await notFound(w.customers.getCustomer360(as(w.repB, Role.SALESPERSON), withConv.id)); // the Customer 360 page: unchanged
      await notFound(w.customers.getCustomer360(as(w.repB, Role.SALESPERSON), without.id, { inboxRead: true })); // no conversation -> not widened
      await notFound(w.customers.getCustomer360({ id: uid(), username: "hr", role: Role.HR } as never, withConv.id, { inboxRead: true }));
    });
  });

  it("editing/removing a customer and viewing the deactivation impact remain scoped: another team's salesperson and manager are refused", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const lead = await w.lead({ ownerId: w.repA.id });
      await w.conversation(lead.id);
      for (const [, u, role] of VIEWERS(w).slice(1)) {
        await notFound(w.customers.deactivateCustomer(as(u, role), lead.id));
        await notFound(w.customers.getDeactivationImpact(as(u, role), lead.id));
      }
      assert.notEqual((await tx.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { workingStatus: true } })).workingStatus, "DEACTIVATED");
    });
  });
});
