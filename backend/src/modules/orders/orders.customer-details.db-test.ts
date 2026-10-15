// "View Customer Details" on an order opens the abandoned lead of THE customer on that order: the checkout the order was created from when there is one, else the customer's latest - and only
// one the viewer is allowed to open. Never another customer's. ONE rolled-back transaction on the isolated test database.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentStatus, AbandonmentType, OrderSource, OrderStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
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

async function world(tx: Prisma.TransactionClient) {
  const mk = (name: string, role: Role) => tx.user.create({ data: { name, username: `${name}-${uid()}`, role }, select: { id: true, username: true, role: true } });
  const [owner, other, manager, otherManager, admin] = await Promise.all([mk("owner", Role.SALESPERSON), mk("other", Role.SALESPERSON), mk("mgr", Role.MANAGER), mk("mgr2", Role.MANAGER), mk("adm", Role.ADMIN)]);
  const source = await tx.source.create({ data: { name: "Checkout", code: `chk-${uid()}` }, select: { id: true } });
  const lead = (label: string, over: Partial<Prisma.LeadUncheckedCreateInput> = {}) =>
    tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: label, mobile: "9811500001", normalizedMobile: "+919811500001", ownerId: owner.id, assignedManagerId: manager.id, ...over }, select: { id: true } });
  const customer = await lead("Customer");
  const stranger = await lead("Stranger", { mobile: "9811500002", normalizedMobile: "+919811500002" });
  const checkout = (leadId: string, minutesAgo: number) =>
    tx.abandonment.create({
      data: { leadId, type: AbandonmentType.CHECKOUT, sourceId: source.id, referenceType: "ShiprocketCheckoutCart", referenceId: `cart-${uid()}`, detectedAt: new Date(Date.now() - minutesAgo * 60_000), status: AbandonmentStatus.ACTIVE },
      select: { id: true },
    });
  const order = (leadId: string, metadata?: Prisma.InputJsonValue, over: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
    tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId, source: OrderSource.SALESPERSON, status: OrderStatus.CONFIRMED, totalAmount: "500.00", createdById: owner.id, ...(metadata ? { metadata } : {}), ...over }, select: { id: true } });
  const svc = new OrdersService(tx as never);
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  const idFor = async (u: { id: string; username: string; role: Role }, orderId: string) => (await svc.getOrder(as(u), orderId)).customer.abandonmentId;
  return { owner, other, manager, otherManager, admin, customer, stranger, checkout, order, idFor };
}

describe("order detail: which abandoned lead 'View Customer Details' opens", () => {
  it("the checkout the order was created from wins over a newer one", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const older = await w.checkout(w.customer.id, 120);
      const newer = await w.checkout(w.customer.id, 5);
      const o = await w.order(w.customer.id, { abandonment: { id: older.id, referenceId: "x" } });
      assert.equal(await w.idFor(w.owner, o.id), older.id);
      assert.notEqual(await w.idFor(w.owner, o.id), newer.id);
    });
  });

  it("an order without that link (also a historical / Shopify-synced one) opens the customer's most recent abandoned lead", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      await w.checkout(w.customer.id, 300);
      const latest = await w.checkout(w.customer.id, 10);
      const crm = await w.order(w.customer.id);
      const shopify = await w.order(w.customer.id, undefined, { source: OrderSource.WEBSITE, externalSource: "SHOPIFY", externalId: `gid-${uid()}`, createdById: null });
      assert.equal(await w.idFor(w.owner, crm.id), latest.id);
      assert.equal(await w.idFor(w.owner, shopify.id), latest.id);
    });
  });

  it("a customer with no abandoned lead gets null (the page shows a clear message instead of guessing)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const o = await w.order(w.customer.id);
      assert.equal(await w.idFor(w.owner, o.id), null);
    });
  });

  it("never another customer's: a link in the order's metadata that points at someone else's checkout is ignored", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const mine = await w.checkout(w.customer.id, 30);
      const foreign = await w.checkout(w.stranger.id, 1);
      const o = await w.order(w.customer.id, { abandonment: { id: foreign.id, referenceId: "x" } });
      assert.equal(await w.idFor(w.owner, o.id), mine.id);
      const onlyForeign = await w.order(w.stranger.id, { abandonment: { id: mine.id, referenceId: "x" } });
      assert.equal(await w.idFor(w.owner, onlyForeign.id), foreign.id, "the stranger's own checkout, not the customer's");
    });
  });

  it("permissions: only someone who may open that abandoned lead gets an id (the owner, the assigned manager, an admin) - another telecaller or manager gets null", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const a = await w.checkout(w.customer.id, 10);
      const o = await w.order(w.customer.id);
      assert.equal(await w.idFor(w.owner, o.id), a.id);
      assert.equal(await w.idFor(w.manager, o.id), a.id);
      assert.equal(await w.idFor(w.admin, o.id), a.id);
      assert.equal(await w.idFor(w.other, o.id), null, "a telecaller who does not own the lead cannot open it");
      assert.equal(await w.idFor(w.otherManager, o.id), null, "a manager the lead is not assigned to cannot either");
    });
  });
});
