// Create Order from a WhatsApp chat for a telecaller who is the conversation's ASSIGNEE but does not own the lead: the order-flow scope (normal lead scope OR this chat is assigned to me) lets the
// order, its payment options, its address prefill and its payment link work - while everyone else stays out, edits/deletes stay strict, consent and templates are still enforced, and retries never duplicate.
// The REAL OrdersService, CashfreePaymentsService (with a fake provider API - Cashfree is never called), and WhatsAppConversationService run inside ONE always-rolled-back transaction.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShopifyClient } from "../shopify/shopify.client.js";
import { loadCashfreeConfig } from "../cashfree/cashfree.config.js";
import CashfreePaymentsService, { type CashfreeApi } from "../cashfree/cashfree.payments.service.js";
import type { CashfreeLink } from "../cashfree/cashfree.client.js";
import WhatsAppConversationService from "../whatsapp/whatsapp.conversation.service.js";
import OrdersService from "./orders.service.js";

class Rollback extends Error {}
async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
after(() => prisma.$disconnect());

const uid = () => randomUUID();
const CONFIG = loadCashfreeConfig({ CASHFREE_ENABLED: "true", CASHFREE_CLIENT_ID: "TEST_APP", CASHFREE_CLIENT_SECRET: "test-secret", PUBLIC_BACKEND_URL: "https://crm.example.com" });
const fakeShopify = () => ({ query: async () => ({ orderCreate: { order: { id: `gid://shopify/Order/${uid()}`, name: "#T1" }, userErrors: [] } }) }) as unknown as ShopifyClient;
const asUser = (u: { id: string; username: string }, role: Role) => ({ id: u.id, username: u.username, role });

async function world(tx: Prisma.TransactionClient) {
  const mkUser = (name: string, role: Role) => tx.user.create({ data: { name, username: `${name}-${uid()}`, role }, select: { id: true, username: true } });
  const [owner, assignee, stranger, hr, admin] = await Promise.all([mkUser("owner", Role.SALESPERSON), mkUser("assignee", Role.SALESPERSON), mkUser("stranger", Role.SALESPERSON), mkUser("hr", Role.HR), mkUser("admin", Role.ADMIN)]);
  const mkLead = (over: Partial<Prisma.LeadUncheckedCreateInput> = {}) =>
    tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Vishwa", mobile: "9876543210", normalizedMobile: "+919876543210", ownerId: owner.id, ...over }, select: { id: true } });
  const lead = await mkLead();
  // The chat for this lead is assigned to `assignee` - who does NOT own the lead.
  await tx.whatsAppConversation.create({ data: { leadId: lead.id, provider: "META", assignedToId: assignee.id } });
  const product = await tx.product.create({ data: { name: "Herbal Tea", type: ProductType.PRODUCT, sku: `SKU-${uid()}`, basePrice: "449.00" }, select: { id: true } });

  const calls = { create: 0 };
  const api: CashfreeApi = {
    createLink: async (request) => { calls.create++; return { cfLinkId: "1", linkId: request.link_id, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${request.link_id}`, linkAmount: String(request.link_amount), linkAmountPaid: "0", linkExpiryTime: null } as unknown as CashfreeLink; },
    getLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "ACTIVE", linkUrl: `https://pay.test/${linkId}`, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
    cancelLink: async (linkId) => ({ cfLinkId: "1", linkId, linkStatus: "CANCELLED", linkUrl: null, linkAmount: null, linkAmountPaid: "0", linkExpiryTime: null }) as unknown as CashfreeLink,
  };
  const cashfree = new CashfreePaymentsService({ $transaction: (cb: (t: never) => unknown) => cb(tx as never) } as never, { config: () => CONFIG, client: () => api });
  const notify = { confirmation: async () => ({ sent: false, via: null, provider: null }), paymentLink: async () => ({ sent: false, via: null, provider: null }) } as never;
  const orders = new OrdersService(tx as never, () => fakeShopify(), () => cashfree as never, notify);
  const conv = new WhatsAppConversationService(tx);
  const create = (u: { id: string; username: string }, role: Role, extra: Record<string, unknown> = {}, leadId = lead.id) =>
    orders.createManualOrder(asUser(u, role), { leadId, items: [{ productId: product.id, quantity: 1, unitPrice: "449.00" }], paymentMethod: "PAYMENT_LINK", ...extra } as never);
  return { tx, owner, assignee, stranger, hr, admin, lead, product, orders, conv, create, calls, mkLead };
}

describe("order flow for the chat's assignee (not the lead's owner)", () => {
  it("the assignee can load payment options and the address prefill; a stranger, and HR, get 'not found' - no data", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const opts = await w.orders.getWhatsAppPaymentOptions(asUser(w.assignee, Role.SALESPERSON), w.lead.id);
      assert.equal(opts.hasWhatsAppNumber, true);
      assert.deepEqual((await w.orders.getLastShippingAddress(asUser(w.assignee, Role.SALESPERSON), w.lead.id)), { address: null });
      for (const [u, role] of [[w.stranger, Role.SALESPERSON], [w.hr, Role.HR]] as const) {
        await assert.rejects(() => w.orders.getWhatsAppPaymentOptions(asUser(u, role), w.lead.id), /Customer not found/);
        await assert.rejects(() => w.orders.getLastShippingAddress(asUser(u, role), w.lead.id), /Customer not found/);
      }
    });
  });

  it("the assignee creates a prepaid order and the REAL payment-link step succeeds: one order, one Cashfree link, lead ownership untouched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const r = await w.create(w.assignee, Role.SALESPERSON, { sendPaymentLinkViaWhatsApp: false });
      assert.equal(r.paymentLink?.status, "created", JSON.stringify(r.paymentLink));
      assert.equal(w.calls.create, 1);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
      assert.equal((await tx.payment.count({ where: { orderId: r.order.id, externalSource: "CASHFREE" } })), 1);
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: w.lead.id }, select: { ownerId: true } });
      assert.equal(lead.ownerId, w.owner.id, "creating the order never reassigns the lead");
    });
  });

  it("a stranger (not the owner, not the assignee) cannot create an order: 'not found', nothing created, no link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(() => w.create(w.stranger, Role.SALESPERSON), /Customer not found/);
      await assert.rejects(() => w.create(w.hr, Role.HR), /Customer not found/);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 0);
      assert.equal(w.calls.create, 0);
    });
  });

  it("the assignee's access is for THIS chat only: another lead of the same owner is still out of scope", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const other = await w.mkLead({ mobile: "9000000001", normalizedMobile: "+919000000001" });
      await assert.rejects(() => w.create(w.assignee, Role.SALESPERSON, {}, other.id), /Customer not found/);
    });
  });

  it("retries never duplicate: the same idempotency key replays the SAME order and creates no second link", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const key = uid();
      const first = await w.create(w.assignee, Role.SALESPERSON, { idempotencyKey: key });
      const again = await w.create(w.assignee, Role.SALESPERSON, { idempotencyKey: key });
      assert.equal(again.order.id, first.order.id);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 1);
      assert.equal(w.calls.create, 1, "the provider is asked for one link only");
    });
  });

  it("consent and templates are still enforced for sending; 'Don't send' needs neither", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await assert.rejects(() => w.create(w.assignee, Role.SALESPERSON, { sendPaymentLinkViaWhatsApp: true }), /consent is required/i);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 0, "nothing is created when a send is refused up front");
      await assert.rejects(() => w.create(w.assignee, Role.SALESPERSON, { sendPaymentLinkViaWhatsApp: true, whatsappConsent: true, whatsappTemplateId: uid() }), /template/i);
      assert.equal(await tx.order.count({ where: { leadId: w.lead.id } }), 0);
      const ok = await w.create(w.assignee, Role.SALESPERSON, { sendPaymentLinkViaWhatsApp: false });
      assert.equal(ok.paymentLink?.status, "created");
      assert.equal(await tx.communicationPreference.count({ where: { leadId: w.lead.id } }), 0, "no consent is fabricated");
    });
  });
});

describe("the chat's Create Order decision (conversation detail)", () => {
  it("owner, assignee and admin may; a stranger is blocked with an actionable reason; HR cannot even open the chat's detail", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const d = (u: { id: string; username: string }, role: Role) => w.conv.viewConversationDetail(asUser(u, role), w.lead.id);
      assert.equal((await d(w.owner, Role.SALESPERSON)).canCreateOrder, true);
      assert.equal((await d(w.assignee, Role.SALESPERSON)).canCreateOrder, true);
      assert.equal((await d(w.admin, Role.ADMIN)).canCreateOrder, true);
      const blocked = await d(w.stranger, Role.SALESPERSON);
      assert.equal(blocked.canCreateOrder, false);
      assert.match(blocked.createOrderBlockedReason ?? "", /not assigned to you.*Ask a manager or admin/);
      assert.equal((await d(w.stranger, Role.SALESPERSON)).contact?.name, "Vishwa", "the chat itself stays readable");
    });
  });

  it("a missing or invalid phone number is blocked with a clear reason - even for an admin", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const nophone = await w.mkLead({ mobile: null, normalizedMobile: null });
      await tx.whatsAppConversation.create({ data: { leadId: nophone.id, provider: "META", assignedToId: w.assignee.id } });
      for (const [u, role] of [[w.admin, Role.ADMIN], [w.assignee, Role.SALESPERSON]] as const) {
        const detail = await w.conv.viewConversationDetail(asUser(u, role), nophone.id);
        assert.equal(detail.canCreateOrder, false);
        assert.match(detail.createOrderBlockedReason ?? "", /no valid phone number/);
      }
    });
  });

  it("the decision does not depend on WhatsApp consent or on templates", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await tx.whatsAppTemplate.updateMany({ where: { status: "APPROVED" }, data: { status: "DISABLED" } });
      assert.equal((await w.conv.viewConversationDetail(asUser(w.assignee, Role.SALESPERSON), w.lead.id)).canCreateOrder, true);
      assert.equal(await tx.communicationPreference.count({ where: { leadId: w.lead.id } }), 0);
    });
  });
});

describe("normal scope is unchanged", () => {
  it("a manager outside the lead's team is blocked; the lead's own owner still works with no conversation assignment", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const manager = await tx.user.create({ data: { name: "mgr", username: `m-${uid()}`, role: Role.MANAGER }, select: { id: true, username: true } });
      await assert.rejects(() => w.create(manager, Role.MANAGER), /Customer not found/);
      const plain = await w.mkLead({ mobile: "9000000002", normalizedMobile: "+919000000002" });
      const r = await w.create(w.owner, Role.SALESPERSON, { sendPaymentLinkViaWhatsApp: false }, plain.id);
      assert.equal(r.paymentLink?.status, "created");
    });
  });
});

describe("one chat per phone: the order goes under the lead the user is entitled to (no new customer, no wrong person)", () => {
  // The chat's representative lead is `rep` (newest message) and belongs to someone else; the user owns a SIBLING lead with the same phone.
  async function twoLeads(w: Awaited<ReturnType<typeof world>>, phone = "+919811100001") {
    const rep = await w.mkLead({ mobile: phone.slice(3), normalizedMobile: phone, ownerId: w.owner.id, firstName: "Rep" });
    const mine = await w.mkLead({ mobile: phone.slice(3), normalizedMobile: phone, ownerId: w.stranger.id, firstName: "Mine" });
    return { rep, mine };
  }
  const detail = (w: Awaited<ReturnType<typeof world>>, u: { id: string; username: string }, role: Role, leadId: string) => w.conv.viewConversationDetail(asUser(u, role), leadId);

  it("a telecaller who owns a sibling lead may create the order from the shared chat - under THEIR lead, not the representative's", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { rep, mine } = await twoLeads(w);
      const d = await detail(w, w.stranger, Role.SALESPERSON, rep.id);
      assert.equal(d.canCreateOrder, true);
      assert.equal(d.orderLead?.id, mine.id);
      assert.equal(d.orderLead?.name, "Mine");
      const before = await tx.lead.count();
      const r = await w.create(w.stranger, Role.SALESPERSON, { sendPaymentLinkViaWhatsApp: false }, d.orderLead!.id);
      assert.equal(r.paymentLink?.status, "created");
      assert.equal(await tx.lead.count(), before, "no customer/lead is created or duplicated");
      assert.equal(await tx.order.count({ where: { leadId: mine.id } }), 1);
      assert.equal(await tx.order.count({ where: { leadId: rep.id } }), 0, "nothing lands on someone else's lead");
    });
  });

  it("creating directly under the representative lead is still refused for that user", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { rep } = await twoLeads(w);
      await assert.rejects(() => w.create(w.stranger, Role.SALESPERSON, {}, rep.id), /Customer not found/);
    });
  });

  it("the chat's own lead is preferred when the user is entitled to it; a different phone is never matched", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { rep, mine } = await twoLeads(w);
      assert.equal((await detail(w, w.owner, Role.SALESPERSON, rep.id)).orderLead?.id, rep.id, "the owner of the representative lead keeps it");
      assert.equal((await detail(w, w.stranger, Role.SALESPERSON, mine.id)).orderLead?.id, mine.id);
      const other = await w.mkLead({ mobile: "9811100002", normalizedMobile: "+919811100002", ownerId: w.stranger.id, firstName: "OtherPerson" });
      const blocked = await detail(w, w.stranger, Role.SALESPERSON, w.lead.id); // a chat for a different phone that this user cannot work
      assert.equal(blocked.canCreateOrder, false);
      assert.notEqual(blocked.orderLead?.id, other.id, "a lead with another phone is never substituted");
    });
  });

  it("with several entitled siblings the pick is deterministic (the oldest owned one), so a retry never switches customer records", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { rep, mine } = await twoLeads(w);
      await w.mkLead({ mobile: "9811100001", normalizedMobile: "+919811100001", ownerId: w.stranger.id, firstName: "Later" });
      const a = await detail(w, w.stranger, Role.SALESPERSON, rep.id);
      const b = await detail(w, w.stranger, Role.SALESPERSON, rep.id);
      assert.equal(a.orderLead?.id, mine.id);
      assert.equal(b.orderLead?.id, a.orderLead?.id);
    });
  });

  it("nobody entitled on any sibling: blocked with the reason", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const { rep } = await twoLeads(w);
      const nobody = await tx.user.create({ data: { name: "nobody", username: `n-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true } });
      const d = await detail(w, nobody, Role.SALESPERSON, rep.id);
      assert.equal(d.canCreateOrder, false);
      assert.equal(d.orderLead ?? null, null);
      assert.match(d.createOrderBlockedReason ?? "", /not assigned to you/);
    });
  });
});
