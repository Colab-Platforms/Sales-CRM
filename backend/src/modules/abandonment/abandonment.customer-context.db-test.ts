// The abandoned lead's detail: full delivery address and the customer's earlier orders (CRM and Shopify-synced), through the REAL AbandonmentService. ONE rolled-back transaction on the
// isolated test database, synthetic data only.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { AbandonmentStatus, AbandonmentType, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import AbandonmentService from "./abandonment.service.js";
import { clearLiveHistoryCache, type LiveHistoryClient } from "./abandonment.shopify-history.js";
import { ShopifyConfigError } from "../shopify/shopify.config.js";

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

const ADDRESS = { name: "Asha Rao", phone: "9811600001", line1: "12 MG Road", line2: "Flat 4B", landmark: "Near Station", city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" };

async function world(tx: Prisma.TransactionClient) {
  const owner = await tx.user.create({ data: { name: "owner", username: `o-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true, role: true } });
  const other = await tx.user.create({ data: { name: "other", username: `x-${uid()}`, role: Role.SALESPERSON }, select: { id: true, username: true, role: true } });
  const source = await tx.source.create({ data: { name: "Checkout", code: `chk-${uid()}` }, select: { id: true } });
  const lead = (first: string, phone: string, over: Partial<Prisma.LeadUncheckedCreateInput> = {}) =>
    tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: first, mobile: phone.slice(3), normalizedMobile: phone, ownerId: owner.id, location: "Mumbai, Maharashtra", ...over }, select: { id: true } });
  const checkout = (leadId: string, snapshot: Record<string, unknown> | null) =>
    tx.abandonment.create({
      data: { leadId, type: AbandonmentType.CHECKOUT, sourceId: source.id, referenceType: "ShiprocketCheckoutCart", referenceId: `cart-${uid()}`, detectedAt: new Date(), status: AbandonmentStatus.ACTIVE, ...(snapshot ? { cartSnapshot: snapshot as Prisma.InputJsonValue } : {}) },
      select: { id: true },
    });
  const order = (leadId: string, over: Partial<Prisma.OrderUncheckedCreateInput> = {}, pay?: { status: PaymentStatus; method: PaymentMethod }) =>
    tx.order.create({
      data: { orderNumber: `ORD-${uid()}`, leadId, source: OrderSource.SALESPERSON, status: OrderStatus.CONFIRMED, totalAmount: "500.00", ...over, ...(pay ? { payments: { create: { amount: "500.00", method: pay.method, status: pay.status } } } : {}) },
      select: { id: true },
    });
  const svc = new AbandonmentService(tx as never, undefined, null);
  const as = (u: { id: string; username: string; role: Role }) => ({ id: u.id, username: u.username, role: u.role });
  return { owner, other, lead, checkout, order, svc, as, tx };
}
const PHONE = "+919811600001";

describe("abandoned lead detail: full delivery address", () => {
  it("shows every available part of the saved checkout address, not the abbreviated 'City, State'", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS, billingAddress: { ...ADDRESS, line1: "99 Billing Lane" } });
      const d = await w.svc.getAbandonment(w.as(w.owner), ab.id);
      assert.equal(d.addresses.shipping?.formatted, "12 MG Road, Flat 4B, Near Station, Pune, Maharashtra, 411001, India");
      assert.equal(d.addresses.billing?.line1, "99 Billing Lane");
      assert.equal(d.addresses.source, "CHECKOUT");
      assert.equal(d.addresses.leadLocation, "Mumbai, Maharashtra", "the short text is still available as a last resort");
    });
  });

  it("a partial checkout address shows what exists; with none, the customer's latest order address is used (and labelled); with neither, nothing is invented", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const partial = await w.checkout(l.id, { shippingAddress: { city: "Pune", state: "Maharashtra" } });
      assert.equal((await w.svc.getAbandonment(w.as(w.owner), partial.id)).addresses.shipping?.formatted, "Pune, Maharashtra");

      const l2 = await w.lead("Ravi", "+919811600002");
      const none = await w.checkout(l2.id, {});
      await w.order(l2.id, { shippingAddress: { name: "Ravi", address1: "7 Park Street", city: "Kolkata", province: "West Bengal", zip: "700016" } as Prisma.InputJsonValue });
      const d2 = await w.svc.getAbandonment(w.as(w.owner), none.id);
      assert.equal(d2.addresses.shipping?.formatted, "7 Park Street, Kolkata, West Bengal, 700016");
      assert.equal(d2.addresses.source, "LAST_ORDER");

      const l3 = await w.lead("Meena", "+919811600003");
      const bare = await w.checkout(l3.id, null);
      const d3 = await w.svc.getAbandonment(w.as(w.owner), bare.id);
      assert.deepEqual([d3.addresses.shipping, d3.addresses.source], [null, null]);
    });
  });
});

describe("abandoned lead detail: previous orders", () => {
  it("lists CRM-created and Shopify-synced orders, newest first, once each, with payment, fulfilment and status", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      const crm = await w.order(l.id, { createdAt: new Date("2026-10-01T10:00:00Z") }, { status: PaymentStatus.SUCCESS, method: PaymentMethod.PAYMENT_LINK });
      const shopify = await w.order(l.id, { createdAt: new Date("2026-10-10T10:00:00Z"), source: OrderSource.WEBSITE, externalSource: "SHOPIFY", externalId: `gid-${uid()}`, externalNumber: "#1042", status: OrderStatus.PENDING_PAYMENT }, { status: PaymentStatus.PENDING, method: PaymentMethod.COD });
      await tx.shipment.create({ data: { orderId: shopify.id, status: "IN_TRANSIT", courier: "Delhivery", trackingNumber: `AWB-${uid().slice(0, 8)}` } });
      const d = await w.svc.getAbandonment(w.as(w.owner), ab.id);
      assert.deepEqual(d.previousOrders.items.map((o) => o.id), [shopify.id, crm.id], "newest first, each once");
      assert.equal(d.previousOrders.total, 2);
      const s = d.previousOrders.items[0]!;
      assert.deepEqual([s.origin, s.externalNumber, s.paymentMode, s.paymentStatus, s.totalAmount, s.currency, s.fulfillmentStatus], ["SHOPIFY", "#1042", "COD", "PENDING", "500", "INR", "IN_TRANSIT"]);
      const c = d.previousOrders.items[1]!;
      assert.deepEqual([c.origin, c.paymentMode, c.paymentStatus, c.status], ["CRM", "PREPAID", "SUCCESS", "CONFIRMED"]);
      assert.equal(c.fulfillmentStatus, null, "not shipped yet");
    });
  });

  it("a customer with no earlier orders gets an empty list (not an error)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      const d = await w.svc.getAbandonment(w.as(w.owner), ab.id);
      assert.deepEqual([d.previousOrders.total, d.previousOrders.items.length], [0, 0]);
    });
  });

  it("identity: a duplicate lead of the SAME person contributes its orders; a different person on the same phone does not; the same e-mail on another phone does", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const subject = await w.lead("Asha", PHONE, { email: "asha@example.test", normalizedEmail: "asha@example.test" });
      const duplicate = await w.lead("asha", PHONE);                                                       // same person, second lead
      const familyMember = await w.lead("Meena", PHONE);                                                   // different person, same phone
      const sameEmail = await w.lead("Asha R", "+919811699999", { email: "asha@example.test", normalizedEmail: "asha@example.test" });
      const ab = await w.checkout(subject.id, { shippingAddress: ADDRESS });
      const mine = await w.order(subject.id);
      const dup = await w.order(duplicate.id);
      const fam = await w.order(familyMember.id);
      const em = await w.order(sameEmail.id);
      const ids = (await w.svc.getAbandonment(w.as(w.owner), ab.id)).previousOrders.items.map((o) => o.id);
      assert.ok(ids.includes(mine.id) && ids.includes(dup.id) && ids.includes(em.id));
      assert.ok(!ids.includes(fam.id), "the family member's order is not mixed in");
      assert.equal(new Set(ids).size, ids.length, "no order is listed twice");
    });
  });
});

describe("abandoned lead detail: the selected lead only", () => {
  it("each abandonment returns ITS lead's detail even when two leads share a phone (no stale or swapped details)", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const asha = await w.lead("Asha", PHONE);
      const meena = await w.lead("Meena", PHONE);
      const abA = await w.checkout(asha.id, { shippingAddress: { ...ADDRESS, line1: "ASHA HOUSE" } });
      const abM = await w.checkout(meena.id, { shippingAddress: { ...ADDRESS, line1: "MEENA HOUSE" } });
      const a = await w.svc.getAbandonment(w.as(w.owner), abA.id);
      const m = await w.svc.getAbandonment(w.as(w.owner), abM.id);
      assert.deepEqual([a.lead.id, a.addresses.shipping?.line1], [asha.id, "ASHA HOUSE"]);
      assert.deepEqual([m.lead.id, m.addresses.shipping?.line1], [meena.id, "MEENA HOUSE"]);
    });
  });

  it("authorization is unchanged: a telecaller who does not own the lead still gets 'not found'", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      await assert.rejects(() => w.svc.getAbandonment(w.as(w.other), ab.id), /not found/i);
    });
  });
});

// ---- the store's own history: orders that exist only in Shopify (the reported Shiprocket Checkout case) ----
describe("abandoned lead detail: previous orders that live only in Shopify", () => {
  const shopifyOrder = (id: string, over: Record<string, unknown> = {}) => ({
    id: `gid://shopify/Order/${id}`, externalId: id, name: `#${id}`, createdAt: "2026-09-01T10:00:00Z", processedAt: null, cancelledAt: null, financialStatus: "PAID", fulfillmentStatus: "FULFILLED", returnStatus: null,
    tags: [], paymentGateways: ["Razorpay"], customerName: null, customerEmail: null, customerPhone: null, currency: "INR", totalAmount: "1299.00", refundedAmount: null, shippingMethod: null, hasTracking: true,
    transactions: [], fulfillments: [{ id: "f", status: "SUCCESS", displayStatus: "Delivered", createdAt: null, deliveredAt: null, trackingCompany: "Delhivery", trackingNumber: "AWB9", trackingUrl: null }], itemCount: 1, ...over,
  });
  const customer = (phone: string | null, externalId = "501") => ({ id: `gid://shopify/Customer/${externalId}`, externalId, name: "Raj", email: null, phone, numberOfOrders: 1, amountSpent: null, address: null, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" });
  const live = (customers: unknown[], orders: unknown[]): LiveHistoryClient => ({ findCustomers: async () => customers as never, ordersOfCustomer: async () => ({ items: orders as never, truncated: false }) });
  const withLive = (tx: Prisma.TransactionClient, client: LiveHistoryClient | (() => never)) => new AbandonmentService(tx as never, undefined, typeof client === "function" ? client : () => client);

  it("a checkout lead with NO CRM orders shows the customer's Shopify orders (phone-matched), and the lead itself is not changed", async () => {
    await inRollback(async (tx) => {
      clearLiveHistoryCache();
      const w = await world(tx);
      const l = await w.lead("Shiprocket Checkout Lead", PHONE, { email: "9811600001@fastrr.com", normalizedEmail: "9811600001@fastrr.com" });
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      const d = await withLive(tx, live([customer(PHONE)], [shopifyOrder("1042")])).getAbandonment(w.as(w.owner), ab.id);
      assert.equal(d.previousOrders.shopify, "OK");
      assert.deepEqual(d.previousOrders.items.map((o) => [o.orderNumber, o.origin, o.inCrm]), [["#1042", "SHOPIFY", false]]);
      assert.equal(d.previousOrders.total, 1);
      assert.equal(await tx.order.count({ where: { leadId: l.id } }), 0, "reading history creates no order");
      assert.equal(await tx.lead.count({ where: { normalizedMobile: PHONE } }), 1, "and no lead");
    });
  });

  it("a Shopify order already synced into the CRM is listed once (the CRM row wins)", async () => {
    await inRollback(async (tx) => {
      clearLiveHistoryCache();
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      await w.order(l.id, { orderNumber: "CRM-SYNCED", externalSource: "SHOPIFY", externalId: "1042", externalNumber: "#1042" });
      const d = await withLive(tx, live([customer(PHONE)], [shopifyOrder("1042"), shopifyOrder("1050")])).getAbandonment(w.as(w.owner), ab.id);
      assert.deepEqual(d.previousOrders.items.map((o) => o.externalNumber ?? o.orderNumber).sort(), ["#1042", "#1050"]);
      assert.equal(d.previousOrders.items.filter((o) => o.inCrm).length, 1);
      assert.equal(d.previousOrders.total, 2);
    });
  });

  it("a Shopify customer with a DIFFERENT phone is never merged in, even if the search returned them", async () => {
    await inRollback(async (tx) => {
      clearLiveHistoryCache();
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      const d = await withLive(tx, live([customer("+919000000000")], [shopifyOrder("1042")])).getAbandonment(w.as(w.owner), ab.id);
      assert.equal(d.previousOrders.items.length, 0);
      assert.equal(d.previousOrders.shopify, "OK", "a clean 'no orders' - the empty state, not an error");
    });
  });

  it("Shopify down or not configured does not break the lead page; the CRM orders still show", async () => {
    await inRollback(async (tx) => {
      clearLiveHistoryCache();
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      await w.order(l.id, { orderNumber: "CRM-ONE" });
      const down = await withLive(tx, { findCustomers: async () => { throw new Error("boom"); }, ordersOfCustomer: async () => ({ items: [], truncated: false }) }).getAbandonment(w.as(w.owner), ab.id);
      assert.equal(down.previousOrders.shopify, "UNAVAILABLE");
      assert.deepEqual(down.previousOrders.items.map((o) => o.orderNumber), ["CRM-ONE"]);
    });
  });

  it("a Shiprocket Checkout lead (placeholder name, generated e-mail) matched by phone gets the store customer's orders; the generated e-mail is never searched", async () => {
    await inRollback(async (tx) => {
      clearLiveHistoryCache();
      const w = await world(tx);
      const l = await w.lead("Nick", PHONE, { email: "9811600001@fastrr.com", normalizedEmail: "9811600001@fastrr.com" });
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      const searches: string[] = [];
      const client: LiveHistoryClient = { findCustomers: async (q) => { searches.push(q); return [customer(PHONE)] as never; }, ordersOfCustomer: async () => ({ items: [shopifyOrder("1042"), shopifyOrder("1043")] as never, truncated: false }) };
      const d = await withLive(tx, client).getAbandonment(w.as(w.owner), ab.id);
      assert.deepEqual([d.previousOrders.shopify, d.previousOrders.shopifyCustomerFound, d.previousOrders.items.length], ["OK", true, 2]);
      assert.ok(searches.every((q) => !q.includes("fastrr")));
    });
  });

  it("explicit states reach the API: ambiguous match, Shopify not configured, and 'searched, nobody found' are all different from each other", async () => {
    await inRollback(async (tx) => {
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE, { email: "asha@example.com", normalizedEmail: "asha@example.com" });
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      clearLiveHistoryCache();
      const two: LiveHistoryClient = { findCustomers: async () => [customer(PHONE, "1"), { ...customer(null, "2"), email: "asha@example.com" }] as never, ordersOfCustomer: async () => ({ items: [shopifyOrder("1") ] as never, truncated: false }) };
      const amb = await withLive(tx, two).getAbandonment(w.as(w.owner), ab.id);
      assert.deepEqual([amb.previousOrders.shopify, amb.previousOrders.shopifyMatchCount, amb.previousOrders.items.length], ["AMBIGUOUS", 2, 0]);
      clearLiveHistoryCache();
      const none = await withLive(tx, live([], [])).getAbandonment(w.as(w.owner), ab.id);
      assert.deepEqual([none.previousOrders.shopify, none.previousOrders.shopifyCustomerFound], ["OK", false]);
      clearLiveHistoryCache();
      const missing = await withLive(tx, (() => { throw new ShopifyConfigError("SHOPIFY_STORE_DOMAIN is not set"); }) as never).getAbandonment(w.as(w.owner), ab.id);
      assert.equal(missing.previousOrders.shopify, "NOT_CONFIGURED");
    });
  });

  it("someone outside the lead's scope still cannot open it, so cannot see its Shopify history either", async () => {
    await inRollback(async (tx) => {
      clearLiveHistoryCache();
      const w = await world(tx);
      const l = await w.lead("Asha", PHONE);
      const ab = await w.checkout(l.id, { shippingAddress: ADDRESS });
      let asked = false;
      const spy: LiveHistoryClient = { findCustomers: async () => { asked = true; return []; }, ordersOfCustomer: async () => ({ items: [], truncated: false }) };
      await assert.rejects(withLive(tx, spy).getAbandonment(w.as(w.other), ab.id));
      assert.equal(asked, false, "Shopify was not even queried");
    });
  });
});
