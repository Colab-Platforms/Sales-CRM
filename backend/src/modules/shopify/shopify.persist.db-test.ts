// Database integration tests for the Shopify sync. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back, so nothing is ever committed and it is safe
// to run against a shared development database. They still need DATABASE_URL and a migrated schema.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivityType, LeadWorkingStatus, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, ProductStatus, Role } from "../../../generated/prisma/enums.js";
import { ShopifyClient } from "./shopify.client.js";
import { loadShopifyConfig } from "./shopify.config.js";
import { codOrderNode, ENV, money, normalized, orderNode, rawFulfillment, rawLineItem, rawTransaction } from "./shopify.fixtures.js";
import { mapOrder, mapProduct } from "./shopify.mapper.js";
import { resolveLead, upsertCustomerLead, upsertOrder, upsertProduct, type Db, type TxRunner } from "./shopify.persist.js";
import { runSync, syncOrderById } from "./shopify.sync.js";
import { createPrismaWebhookStore } from "./shopify.webhook.store.js";
import { EMPTY_WINDOW, startOfDay } from "./shopify.window.js";
import OrdersService from "../orders/orders.service.js";

class Rollback extends Error {}

/** Runs `fn` in a transaction and always rolls it back. */
async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx, { $transaction: (cb) => cb(tx) });
        throw new Rollback();
      },
      { timeout: 180_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

// ---- fixtures (random ids so nothing can collide with real data; phones start with 5, which no Indian mobile does) ----

const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join("");
const uid = () => `9${digits(11)}`;
const phone = () => `5${digits(9)}`;

interface MakeOptions {
  id?: string;
  name?: string;
  customerId?: string | null;
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  updatedAt?: string;
  /** Cash on delivery instead of a paid Cashfree order. */
  cod?: boolean;
  node?: Record<string, unknown>;
}

// Every id is random, so a test can never match (or collide with) real synced data.
function make(o: MakeOptions = {}) {
  const id = o.id ?? uid();
  const customerId = o.customerId === undefined ? uid() : o.customerId;
  const productId = uid();
  const variantId = uid();
  const contactPhone = o.phone === undefined ? phone() : o.phone;
  const base = o.cod ? codOrderNode() : orderNode();
  const transaction = `gid://shopify/OrderTransaction/${id}1`;

  const node = {
    ...base,
    id: `gid://shopify/Order/${id}`,
    name: o.name ?? `#DB${id.slice(-7)}`,
    updatedAt: o.updatedAt ?? "2026-09-19T10:05:00Z",
    email: customerId ? null : (o.email ?? null),
    phone: customerId ? null : contactPhone,
    customer: customerId
      ? { id: `gid://shopify/Customer/${customerId}`, firstName: o.firstName ?? "Test", lastName: "Buyer", email: o.email === undefined ? `t${id}@example.com` : o.email, phone: contactPhone }
      : null,
    shippingAddress: { ...(base.shippingAddress as Record<string, unknown>), phone: null },
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [rawLineItem({ id: `gid://shopify/LineItem/${id}1`, product: { id: `gid://shopify/Product/${productId}` }, variant: { id: `gid://shopify/ProductVariant/${variantId}` } })],
    },
    transactions: o.cod
      ? [rawTransaction({ id: transaction, gateway: "Cash on Delivery (COD)", status: "PENDING", amountSet: money("699.0"), paymentId: `cod_${id}` })]
      : [rawTransaction({ id: transaction, paymentId: `pay_${id}` })],
    ...o.node,
  };
  return { id, customerId, productId, variantId, transaction, node, mapped: mapOrder(normalized(node)) };
}

const ext = { externalSource: "SHOPIFY" } as const;

async function counts(tx: Db, orderExternalId: string) {
  const order = await tx.order.findFirst({ where: { ...ext, externalId: orderExternalId }, select: { id: true } });
  if (!order) return { orders: 0, items: 0, payments: 0, shipments: 0, activities: 0 };
  const [items, payments, shipments, activities] = await Promise.all([
    tx.orderItem.count({ where: { orderId: order.id } }),
    tx.payment.count({ where: { orderId: order.id } }),
    tx.shipment.count({ where: { orderId: order.id } }),
    tx.activity.count({ where: { orderId: order.id } }),
  ]);
  return { orders: 1, items, payments, shipments, activities };
}

// ---------------------------------------------------------------------------------------------

describe("importing an order", () => {
  it("creates the lead, order, items, payment and timeline entries", async () => {
    await inRollback(async (tx) => {
      const { id, customerId, mapped } = make();
      const result = await upsertOrder(tx, mapped);
      assert.equal(result.action, "created");
      assert.equal(result.lead?.action, "created");

      const order = await tx.order.findFirstOrThrow({
        where: { ...ext, externalId: id },
        include: { items: true, payments: true, lead: { include: { source: true } } },
      });
      assert.equal(order.orderNumber, mapped.orderNumber);
      assert.equal(order.externalNumber, mapped.externalNumber);
      assert.equal(order.source, OrderSource.SHOPIFY);
      assert.equal(order.status, OrderStatus.CONFIRMED);
      assert.equal(order.totalAmount.toString(), "649");
      assert.equal(order.currency, "INR");
      assert.equal(order.createdAt.toISOString(), "2026-09-19T10:00:00.000Z", "the Shopify creation time is kept");
      assert.equal(order.externalUpdatedAt?.toISOString(), "2026-09-19T10:05:00.000Z");
      assert.equal(order.shippingPincode, "786125");
      assert.equal((order.shippingAddress as { city: string }).city, "Tinsukia");
      assert.equal(order.createdById, null);

      assert.equal(order.items.length, 1);
      assert.equal(order.items[0].skuSnapshot, "AW-HM-PN-60");
      assert.equal(order.items[0].quantity, 1);
      assert.equal(order.items[0].unitPrice.toString(), "649");
      assert.equal(order.items[0].productId, null, "no product synced yet, so no link, but the snapshot is kept");
      assert.equal(order.items[0].productNameSnapshot, "Aayush Wellness Herbal Masala");

      assert.equal(order.payments.length, 1);
      assert.equal(order.payments[0].status, PaymentStatus.SUCCESS);
      assert.equal(order.payments[0].externalSource, "SHOPIFY");

      assert.equal(order.lead.source?.code, "SHOPIFY");
      assert.equal(order.lead.workingStatus, LeadWorkingStatus.CONVERTED);
      assert.equal(order.lead.leadNumber, `SHP-C-${customerId}`);
      assert.equal(order.lead.ownerId, null);
      assert.equal(order.lead.externalId, customerId);

      const activities = await tx.activity.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(
        activities.map((a) => a.type).sort(),
        [ActivityType.ORDER_CONFIRMED, ActivityType.ORDER_CREATED, ActivityType.PAYMENT_CREATED].sort(),
      );
      assert.equal(activities[0].leadId, order.leadId, "the timeline hangs off the customer's lead");
      const payment = activities.find((a) => a.type === ActivityType.PAYMENT_CREATED)!;
      assert.equal(payment.referenceType, "Payment", "a payment event's entity is the payment, not the order");
      assert.equal(payment.source, "SHOPIFY_SYNC");
    });
  });

  it("is idempotent: importing the same order again skips it and adds nothing", async () => {
    await inRollback(async (tx) => {
      const { id, mapped } = make();
      await upsertOrder(tx, mapped);
      const before = await counts(tx, id);
      const leadsBefore = await tx.lead.count();

      assert.equal((await upsertOrder(tx, mapped)).action, "skipped");
      assert.deepEqual(await counts(tx, id), before);
      assert.equal(await tx.lead.count(), leadsBefore);
    });
  });

  it("re-applies with --force, still without duplicates or repeated timeline entries", async () => {
    await inRollback(async (tx) => {
      const { id, mapped } = make();
      await upsertOrder(tx, mapped);
      const before = await counts(tx, id);

      const again = await upsertOrder(tx, mapped, { force: true });
      assert.equal(again.action, "updated");
      assert.deepEqual(await counts(tx, id), before);
    });
  });

  it("updates an existing order when Shopify's copy is newer, and records the status change", async () => {
    await inRollback(async (tx) => {
      const first = make({ cod: true });
      const created = await upsertOrder(tx, first.mapped);
      assert.equal(created.action, "created");
      const order = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: first.id }, include: { payments: true } });
      assert.equal(order.status, OrderStatus.CONFIRMED);
      assert.equal(order.payments[0].method, PaymentMethod.COD);
      assert.equal(order.payments[0].status, PaymentStatus.PENDING);

      // Shipped, delivered and the cash collected.
      const delivered = make({
        id: first.id, customerId: first.customerId, cod: true, updatedAt: "2026-09-21T09:30:00Z",
        node: {
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "FULFILLED",
          fulfillments: [rawFulfillment("DELIVERED")],
          transactions: [rawTransaction({ id: first.transaction, gateway: "Cash on Delivery (COD)", status: "SUCCESS", amountSet: money("699.0"), processedAt: "2026-09-21T09:00:00Z" })],
        },
      });
      const updated = await upsertOrder(tx, delivered.mapped);
      assert.equal(updated.action, "updated");
      assert.equal(updated.orderId, order.id);

      const after = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: first.id }, include: { payments: true } });
      assert.equal(after.status, OrderStatus.DELIVERED);
      assert.equal(after.payments.length, 1, "the same payment was updated, not duplicated");
      assert.equal(after.payments[0].status, PaymentStatus.SUCCESS);
      assert.equal(after.payments[0].method, PaymentMethod.COD);
      assert.ok(after.payments[0].paidAt);

      const changes = await tx.activity.findMany({ where: { referenceType: "Order", referenceId: order.id, type: ActivityType.ORDER_STATUS_CHANGED } });
      assert.equal(changes.length, 1);
      assert.equal(changes[0].description, "CONFIRMED -> DELIVERED");
      assert.equal(changes[0].source, "SHOPIFY_SYNC");
      assert.equal(await tx.activity.count({ where: { orderId: order.id, type: ActivityType.PAYMENT_STATUS_CHANGED } }), 1);
    });
  });

  it("replaces a placeholder COD payment when a real transaction appears", async () => {
    await inRollback(async (tx) => {
      const bare = make({ cod: true, node: { transactions: [] } });
      await upsertOrder(tx, bare.mapped);
      const order = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: bare.id }, include: { payments: true } });
      assert.equal(order.payments.length, 1);
      assert.match(order.payments[0].externalId ?? "", /^synthetic-/);
      assert.equal(order.payments[0].method, PaymentMethod.COD);

      const real = make({ id: bare.id, customerId: bare.customerId, cod: true, updatedAt: "2026-09-20T00:00:00Z" });
      const result = await upsertOrder(tx, real.mapped);
      assert.deepEqual(result.payments, { created: 1, updated: 0, deleted: 1 });
      const payments = await tx.payment.findMany({ where: { orderId: order.id } });
      assert.equal(payments.length, 1);
      assert.doesNotMatch(payments[0].externalId ?? "", /^synthetic-/);
    });
  });

  it("stores cancelled orders as cancelled, with the reason, and does not count a new cancelled customer as converted", async () => {
    await inRollback(async (tx) => {
      const { id, mapped } = make({ node: { cancelledAt: "2026-09-19T11:00:00Z", cancelReason: "CUSTOMER" } });
      const result = await upsertOrder(tx, mapped);
      const order = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: id }, include: { lead: true } });
      assert.equal(order.status, OrderStatus.CANCELLED);
      assert.equal(order.cancelReason, "CUSTOMER");
      assert.equal(order.cancelledAt?.toISOString(), "2026-09-19T11:00:00.000Z");
      assert.equal(order.lead.workingStatus, LeadWorkingStatus.NEW);
      assert.equal(result.lead?.action, "created");
    });
  });

  it("records a later cancellation as a status change", async () => {
    await inRollback(async (tx) => {
      const first = make();
      await upsertOrder(tx, first.mapped);
      const cancelled = make({ id: first.id, customerId: first.customerId, updatedAt: "2026-09-20T00:00:00Z", node: { cancelledAt: "2026-09-20T00:00:00Z", cancelReason: "OTHER" } });
      await upsertOrder(tx, cancelled.mapped);

      const order = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: first.id } });
      assert.equal(order.status, OrderStatus.CANCELLED);
      const change = await tx.activity.findFirstOrThrow({ where: { referenceType: "Order", referenceId: order.id, type: ActivityType.ORDER_CANCELLED } });
      assert.equal(change.description, "CONFIRMED -> CANCELLED");
      assert.deepEqual(change.newValue, { status: "CANCELLED", cancelReason: "OTHER" });
    });
  });

  it("stores fully and partly refunded payments with the refunded amount", async () => {
    await inRollback(async (tx) => {
      const sale = (id: string) => rawTransaction({ id: `gid://shopify/OrderTransaction/${id}1`, amountSet: money("649.0") });
      const refund = (id: string, amount: string) =>
        rawTransaction({ id: `gid://shopify/OrderTransaction/${id}2`, kind: "REFUND", amountSet: money(amount), processedAt: "2026-09-25T08:00:00Z", parentTransaction: { id: `gid://shopify/OrderTransaction/${id}1` } });

      const full = uid();
      await upsertOrder(tx, make({ id: full, node: { displayFinancialStatus: "REFUNDED", transactions: [sale(full), refund(full, "649.0")] } }).mapped);
      const fullOrder = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: full }, include: { payments: true } });
      assert.equal(fullOrder.status, OrderStatus.REFUNDED);
      assert.equal(fullOrder.payments[0].status, PaymentStatus.REFUNDED);
      assert.equal(fullOrder.payments[0].refundedAmount?.toString(), "649");
      assert.ok(fullOrder.payments[0].refundedAt);

      const part = uid();
      await upsertOrder(tx, make({ id: part, node: { displayFinancialStatus: "PARTIALLY_REFUNDED", transactions: [sale(part), refund(part, "200.0")] } }).mapped);
      const partOrder = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: part }, include: { payments: true } });
      assert.equal(partOrder.status, OrderStatus.CONFIRMED);
      assert.equal(partOrder.payments[0].status, PaymentStatus.PARTIALLY_REFUNDED);
      assert.equal(partOrder.payments[0].refundedAmount?.toString(), "200");
    });
  });

  it("stores a shipment with courier and tracking, and progresses it as Shopify updates the fulfilment", async () => {
    await inRollback(async (tx) => {
      const fulfillmentGid = `gid://shopify/Fulfillment/${uid()}`;
      const { id, mapped } = make({
        node: { displayFulfillmentStatus: "FULFILLED", fulfillments: [rawFulfillment("IN_TRANSIT", { id: fulfillmentGid })] },
      });
      await upsertOrder(tx, mapped);

      const order = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: id }, include: { shipments: true } });
      assert.equal(order.shipments.length, 1);
      assert.equal(order.shipments[0].status, "IN_TRANSIT");
      assert.equal(order.shipments[0].courier, "Shiprocket");
      assert.equal(order.shipments[0].trackingNumber, "SR12345");
      assert.equal(order.shipments[0].trackingUrl, "https://track.example/SR12345");
      assert.ok(order.shipments[0].shippedAt);
      assert.equal(order.shipments[0].deliveredAt, null);
      assert.equal(order.shipments[0].externalSource, "SHOPIFY");

      // Shopify later reports the same fulfilment as delivered: the row is updated, not duplicated.
      const delivered = make({
        id,
        customerId: null,
        node: {
          displayFulfillmentStatus: "FULFILLED",
          updatedAt: "2026-09-22T09:00:00Z",
          fulfillments: [rawFulfillment("DELIVERED", { id: fulfillmentGid })],
        },
      });
      await upsertOrder(tx, delivered.mapped, { force: true });

      const after = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: id }, include: { shipments: true } });
      assert.equal(after.shipments.length, 1, "the same Shopify fulfilment updates its row instead of adding a new one");
      assert.equal(after.shipments[0].status, "DELIVERED");
      assert.ok(after.shipments[0].deliveredAt);
    });
  });

  it("removes a shipment row if Shopify later cancels that fulfilment", async () => {
    await inRollback(async (tx) => {
      const fulfillmentGid = `gid://shopify/Fulfillment/${uid()}`;
      const { id, mapped } = make({ node: { displayFulfillmentStatus: "FULFILLED", fulfillments: [rawFulfillment("IN_TRANSIT", { id: fulfillmentGid })] } });
      await upsertOrder(tx, mapped);
      assert.equal((await counts(tx, id)).shipments, 1);

      const cancelled = make({
        id,
        customerId: null,
        node: { displayFulfillmentStatus: "UNFULFILLED", updatedAt: "2026-09-22T09:00:00Z", fulfillments: [rawFulfillment("IN_TRANSIT", { id: fulfillmentGid, status: "CANCELLED" })] },
      });
      await upsertOrder(tx, cancelled.mapped, { force: true });
      assert.equal((await counts(tx, id)).shipments, 0);
    });
  });

  it("does not create a shipment for an order Shopify has not fulfilled yet", async () => {
    await inRollback(async (tx) => {
      const { id, mapped } = make();
      await upsertOrder(tx, mapped);
      assert.equal((await counts(tx, id)).shipments, 0);
    });
  });

  it("never touches payments or orders that were created inside the CRM", async () => {
    await inRollback(async (tx) => {
      const { id, customerId, mapped } = make();
      await upsertOrder(tx, mapped);
      const order = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: id } });
      const crmPayment = await tx.payment.create({ data: { orderId: order.id, amount: "10", status: PaymentStatus.SUCCESS } }); // no external identity
      const crmOrder = await tx.order.create({ data: { orderNumber: `CRM-${id}`, leadId: order.leadId, source: OrderSource.SALESPERSON, totalAmount: "5" } });

      await upsertOrder(tx, make({ id, customerId, node: { transactions: [] , displayFinancialStatus: "PENDING" } }).mapped, { force: true });
      assert.ok(await tx.payment.findUnique({ where: { id: crmPayment.id } }), "the CRM's own payment survives a Shopify re-sync");
      assert.ok(await tx.order.findUnique({ where: { id: crmOrder.id } }));
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("matching Shopify customers to leads", () => {
  it("uses the lead that already carries the Shopify customer id", async () => {
    await inRollback(async (tx) => {
      const owner = await tx.user.create({ data: { name: "Rep", email: `rep-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const customerId = uid();
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Existing", ownerId: owner.id, externalSource: "SHOPIFY", externalId: customerId } });
      const before = await tx.lead.count();

      const { id, mapped } = make({ customerId });
      const result = await upsertOrder(tx, mapped);
      assert.equal(result.lead?.leadId, lead.id);
      assert.equal(result.lead?.matchedBy, "externalId");
      const order = await tx.order.findFirstOrThrow({ where: { ...ext, externalId: id } });
      assert.equal(order.leadId, lead.id);
      assert.equal(await tx.lead.count(), before, "no new lead");
      const after = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
      assert.equal(after.ownerId, owner.id, "ownership is preserved");
      assert.equal(after.firstName, "Existing", "the name is not overwritten");
    });
  });

  it("matches by phone number however it is written, keeping the lead's source, owner and name, and claiming the Shopify id", async () => {
    await inRollback(async (tx) => {
      const owner = await tx.user.create({ data: { name: "Rep", email: `rep-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const source = await tx.source.create({ data: { name: "Google Ads", code: `GADS-${uid()}` } });
      const number = phone();
      const lead = await tx.lead.create({
        data: { leadNumber: `L-${uid()}`, firstName: "Original", mobile: number, normalizedMobile: `+91${number}`, ownerId: owner.id, sourceId: source.id, workingStatus: LeadWorkingStatus.INTERESTED },
      });
      const before = await tx.lead.count();

      const customerId = uid();
      const { mapped } = make({ customerId, phone: `+91 ${number.slice(0, 5)} ${number.slice(5)}`, email: `fill-${uid()}@example.com`, firstName: "Different" });
      const result = await resolveLead(tx, mapped.identity, { converted: true, fallbackKey: "x", activityAt: new Date() });

      assert.equal(result.leadId, lead.id);
      assert.equal(result.matchedBy, "phone");
      assert.equal(await tx.lead.count(), before);
      const after = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
      assert.equal(after.externalId, customerId, "the Shopify customer id is attached");
      assert.equal(after.sourceId, source.id, "the original source is preserved");
      assert.equal(after.ownerId, owner.id);
      assert.equal(after.firstName, "Original");
      assert.equal(after.workingStatus, LeadWorkingStatus.INTERESTED, "the sales stage is not changed by an import");
      assert.ok(after.email, "an empty email is filled in");
    });
  });

  it("matches by email when there is no id or phone match", async () => {
    await inRollback(async (tx) => {
      const email = `Match.${uid()}@Example.com`;
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "ByEmail", email, normalizedEmail: email.toLowerCase() } });
      const { mapped } = make({ customerId: uid(), phone: phone(), email: email.toUpperCase() });

      const result = await resolveLead(tx, mapped.identity, { converted: true, fallbackKey: "x", activityAt: new Date() });
      assert.equal(result.leadId, lead.id);
      assert.equal(result.matchedBy, "email");
    });
  });

  it("creates a new lead when nothing matches, and reuses it for the same customer's next order", async () => {
    await inRollback(async (tx) => {
      const customerId = uid();
      const one = make({ customerId });
      const two = make({ customerId, phone: one.mapped.identity.phone });
      const r1 = await upsertOrder(tx, one.mapped);
      const r2 = await upsertOrder(tx, two.mapped);

      assert.equal(r1.lead?.action, "created");
      assert.equal(r2.lead?.leadId, r1.lead?.leadId);
      assert.equal(r2.lead?.matchedBy, "externalId");
      assert.equal(await tx.lead.count({ where: { ...ext, externalId: customerId } }), 1);
    });
  });

  it("handles a guest checkout: a lead without a Shopify id, matched by phone next time", async () => {
    await inRollback(async (tx) => {
      const number = phone();
      const one = make({ customerId: null, phone: number });
      const two = make({ customerId: null, phone: number });
      const r1 = await upsertOrder(tx, one.mapped);
      const r2 = await upsertOrder(tx, two.mapped);

      const lead = await tx.lead.findUniqueOrThrow({ where: { id: r1.lead!.leadId } });
      assert.equal(lead.externalId, null);
      assert.match(lead.leadNumber, /^SHP-O-/);
      assert.equal(r2.lead?.leadId, r1.lead?.leadId);
      assert.equal(r2.lead?.matchedBy, "phone");
    });
  });

  it("turns a Shopify sign-up into a customer when its first live order arrives", async () => {
    await inRollback(async (tx) => {
      const customerId = uid();
      const number = phone();
      const signup = await resolveLead(tx, { externalId: customerId, firstName: "New", lastName: null, email: null, phone: number, location: null }, { converted: false, fallbackKey: "x", activityAt: new Date() });
      assert.equal((await tx.lead.findUniqueOrThrow({ where: { id: signup.leadId } })).workingStatus, LeadWorkingStatus.NEW);

      await upsertOrder(tx, make({ customerId, phone: number }).mapped);
      assert.equal((await tx.lead.findUniqueOrThrow({ where: { id: signup.leadId } })).workingStatus, LeadWorkingStatus.CONVERTED);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("products and variants", () => {
  const product = (id: string, variants: Array<{ id: string; title: string; sku: string | null; price: string | null }>, over = {}) =>
    mapProduct({
      id: `gid://shopify/Product/${id}`, title: "Test Product", handle: "t", status: "ACTIVE", vendor: null, productType: null, description: "d",
      updatedAt: "2026-09-18T00:00:00Z", variantsTruncated: false,
      variants: variants.map((v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, title: v.title, sku: v.sku, price: v.price, updatedAt: null })),
      ...over,
    });

  it("creates a product and its variants, skips an unchanged one, and updates a changed one", async () => {
    await inRollback(async (tx) => {
      const pid = uid(), v1 = uid(), v2 = uid();
      const created = await upsertProduct(tx, product(pid, [{ id: v1, title: "A", sku: "SKU-A", price: "100.0" }, { id: v2, title: "B", sku: "SKU-B", price: "150.5" }]));
      assert.equal(created.action, "created");
      assert.deepEqual(created.variants, { created: 2, updated: 0, skipped: 0 });

      const row = await tx.product.findFirstOrThrow({ where: { ...ext, externalId: pid }, include: { variants: true } });
      assert.equal(row.name, "Test Product");
      assert.equal(row.basePrice?.toString(), "100");
      assert.equal(row.sku, null);
      assert.deepEqual(row.variants.map((v) => v.sku).sort(), ["SKU-A", "SKU-B"]);

      const again = await upsertProduct(tx, product(pid, [{ id: v1, title: "A", sku: "SKU-A", price: "100.0" }, { id: v2, title: "B", sku: "SKU-B", price: "150.5" }]));
      assert.equal(again.action, "skipped");
      assert.equal(await tx.productVariant.count({ where: { productId: row.id } }), 2);

      const changed = await upsertProduct(tx, product(pid, [{ id: v1, title: "A", sku: "SKU-A", price: "120.0" }, { id: v2, title: "B", sku: "SKU-B", price: "150.5" }], { updatedAt: "2026-09-19T00:00:00Z" }));
      assert.equal(changed.action, "updated");
      assert.deepEqual(changed.variants, { created: 0, updated: 1, skipped: 1 });
      assert.equal((await tx.productVariant.findFirstOrThrow({ where: { ...ext, externalId: v1 } })).price?.toString(), "120");
    });
  });

  it("deactivates a variant removed in Shopify instead of deleting it", async () => {
    await inRollback(async (tx) => {
      const pid = uid(), v1 = uid(), v2 = uid();
      await upsertProduct(tx, product(pid, [{ id: v1, title: "A", sku: null, price: "1.0" }, { id: v2, title: "B", sku: null, price: "1.0" }]));
      await upsertProduct(tx, product(pid, [{ id: v1, title: "A", sku: null, price: "1.0" }], { updatedAt: "2026-09-19T00:00:00Z" }));
      assert.equal((await tx.productVariant.findFirstOrThrow({ where: { ...ext, externalId: v2 } })).status, ProductStatus.INACTIVE);
      assert.equal((await tx.productVariant.findFirstOrThrow({ where: { ...ext, externalId: v1 } })).status, ProductStatus.ACTIVE);
    });
  });

  it("links order items to the synced product and variant", async () => {
    await inRollback(async (tx) => {
      const order = make();
      await upsertProduct(tx, product(order.productId, [{ id: order.variantId, title: "Paan Masala", sku: "AW-HM-PN-60", price: "649.0" }]));
      await upsertOrder(tx, order.mapped);

      const item = await tx.orderItem.findFirstOrThrow({
        where: { order: { ...ext, externalId: order.id } },
        include: { product: true, variant: true },
      });
      assert.equal(item.product?.externalId, order.productId);
      assert.equal(item.variant?.externalId, order.variantId);
      assert.equal(item.variant?.sku, "AW-HM-PN-60");
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("webhook events in the database", () => {
  it("records a delivery once: the unique (provider, delivery id) rejects a repeat", async () => {
    await inRollback(async (tx) => {
      const store = createPrismaWebhookStore(tx);
      const deliveryId = `wh-${uid()}`;
      const first = await store.record({ eventType: "orders/updated", externalEventId: deliveryId, payload: { id: 1 } });
      const second = await store.record({ eventType: "orders/updated", externalEventId: deliveryId, payload: { id: 1 } });

      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(second.id, first.id);
      assert.equal(await tx.webhookEvent.count({ where: { provider: "SHOPIFY", externalEventId: deliveryId } }), 1);
    });
  });

  it("lets exactly one worker claim an event, and never again once it is processed", async () => {
    await inRollback(async (tx) => {
      const store = createPrismaWebhookStore(tx);
      const { id } = await store.record({ eventType: "orders/updated", externalEventId: `wh-${uid()}`, payload: { id: 1 } });
      const now = new Date();

      const claimed = await store.claim(id, now);
      assert.equal(claimed?.attempts, 1);
      assert.equal(await store.claim(id, now), null, "already held");

      await store.complete(id, "PROCESSED", now);
      assert.equal(await store.claim(id, new Date(now.getTime() + 3_600_000)), null, "a processed event is never re-claimed");
      assert.equal((await tx.webhookEvent.findUniqueOrThrow({ where: { id } })).status, "PROCESSED");
    });
  });

  it("schedules a failed event for retry and picks it up only when due", async () => {
    await inRollback(async (tx) => {
      const store = createPrismaWebhookStore(tx);
      const { id } = await store.record({ eventType: "orders/updated", externalEventId: `wh-${uid()}`, payload: { id: 1 } });
      const now = new Date();
      await store.claim(id, now);
      const retryAt = new Date(now.getTime() + 60_000);
      await store.fail(id, "boom", retryAt);

      assert.equal((await store.due(now, 50)).includes(id), false);
      assert.equal((await store.due(new Date(retryAt.getTime() + 1), 50)).includes(id), true);
      assert.equal((await store.claim(id, new Date(retryAt.getTime() + 1)))?.attempts, 2);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the E6 Orders API on imported Shopify data", () => {
  it("lists and shows a Shopify COD order, with role scoping still applied", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const other = await tx.user.create({ data: { name: "Other", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });

      const suffix = uid().slice(-6);
      const cod = make({ cod: true, name: `#DBAPI${suffix}` });
      await upsertOrder(tx, cod.mapped);

      const svc = new OrdersService(tx);
      const seen = async (u: ReturnType<typeof as>, extra = {}) => (await svc.listOrders(u, { page: 1, pageSize: 100, search: `DBAPI${suffix}`, ...extra })).items;

      const [row] = await seen(as(admin, Role.ADMIN));
      assert.equal(row.orderNumber, cod.mapped.orderNumber);
      assert.equal(row.externalNumber, `#DBAPI${suffix}`);
      assert.equal(row.source, OrderSource.SHOPIFY);
      assert.equal(row.paymentStatus, PaymentStatus.PENDING);
      assert.equal(row.paymentMode, "COD");
      assert.equal(row.status, OrderStatus.CONFIRMED);
      assert.equal(row.totalAmount, "699");
      assert.equal(row.itemCount, 1);
      assert.equal(row.leadSource?.name, "Shopify");
      assert.equal(row.salesperson, null);
      assert.match(row.customer.name, /^Test Buyer$/);

      // Filters work with the new values.
      assert.equal((await seen(as(admin, Role.ADMIN), { source: OrderSource.SHOPIFY })).length, 1);
      assert.equal((await seen(as(admin, Role.ADMIN), { source: OrderSource.WEBSITE })).length, 0);
      assert.equal((await seen(as(admin, Role.ADMIN), { paymentStatus: PaymentStatus.PENDING })).length, 1);
      assert.equal((await seen(as(admin, Role.ADMIN), { status: OrderStatus.CONFIRMED })).length, 1);
      assert.equal((await seen(as(admin, Role.ADMIN), { status: OrderStatus.DELIVERED })).length, 0);

      // The lead has no owner yet, so only an admin sees the order.
      assert.equal((await seen(as(rep, Role.SALESPERSON))).length, 0);
      assert.equal((await seen(as(other, Role.SALESPERSON))).length, 0);
      await assert.rejects(() => svc.getOrder(as(rep, Role.SALESPERSON), row.id), /Order not found/);

      // Once the lead is owned, its owner sees the order and nobody else does.
      await tx.lead.update({ where: { id: (await tx.order.findUniqueOrThrow({ where: { id: row.id } })).leadId }, data: { ownerId: rep.id } });
      assert.equal((await seen(as(rep, Role.SALESPERSON))).length, 1);
      assert.equal((await seen(as(other, Role.SALESPERSON))).length, 0);

      const detail = await svc.getOrder(as(rep, Role.SALESPERSON), row.id);
      assert.equal(detail.externalNumber, `#DBAPI${suffix}`);
      assert.equal(detail.paymentMode, "COD");
      assert.equal(detail.shippingPincode, "786125");
      assert.equal(detail.customer.leadNumber, `SHP-C-${cod.customerId}`);
      assert.equal(detail.items[0].sku, "AW-HM-PN-60");
      assert.equal(detail.items[0].variantName, "Paan Masala Flavour / 60 - Pouches");
      assert.equal(detail.payments[0].method, PaymentMethod.COD);
      assert.equal(detail.payments[0].provider, "Cash on Delivery (COD)");
      assert.equal(detail.subtotal, "649");
      assert.equal(detail.shippingAmount, "50");
      assert.equal(detail.totalAmount, "699");

      const history = await svc.getStatusHistory(as(rep, Role.SALESPERSON), row.id);
      assert.equal(history.currentStatus, OrderStatus.CONFIRMED);
      assert.ok(history.entries.some((e) => e.event === "CREATED" && e.source === "ACTIVITY" && new RegExp(`Shopify order #DBAPI${suffix}`).test(e.title)));
    });
  });

  it("shows a prepaid order as prepaid", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const { mapped } = make({ name: "#TST1001" });
      await upsertOrder(tx, mapped);
      const [row] = (await new OrdersService(tx).listOrders({ id: admin.id, email: admin.email, role: Role.ADMIN }, { page: 1, pageSize: 10, search: "TST1001" })).items;
      assert.equal(row.paymentMode, "PREPAID");
      assert.equal(row.paymentStatus, PaymentStatus.SUCCESS);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the sync orchestration (with a fake Shopify)", () => {
  const client = (orders: Array<Record<string, unknown>>, products: Record<string, Record<string, unknown>> = {}) => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: { id?: string; first?: number } };
      const name = query.match(/query (\w+)/)![1];
      calls.push(`${name}${variables.id ? `:${variables.id.split("/").pop()}` : ""}`);
      const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      if (name === "ConnectionCheck") return ok({ shop: { name: "S", myshopifyDomain: "demo-store.myshopify.com", currencyCode: "INR", ianaTimezone: "Asia/Kolkata" }, currentAppInstallation: { accessScopes: [{ handle: "read_orders" }, { handle: "read_customers" }, { handle: "read_products" }] } });
      if (name === "Count") return ok({ result: { count: orders.length, precision: "EXACT" } });
      if (name === "OrderRefs") return ok({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: orders.slice(0, variables.first).map((o) => ({ id: o.id, updatedAt: o.updatedAt })) } });
      if (name === "OrderById") return ok({ order: orders.find((o) => o.id === variables.id) ?? null });
      if (name === "ProductById") return ok({ product: products[variables.id!] ?? null });
      throw new Error(`unexpected query ${name}`);
    }) as unknown as typeof fetch;
    return { calls, shopify: new ShopifyClient(loadShopifyConfig(ENV), { fetchImpl }) };
  };

  const productNode = (id: string, variantId: string) => ({
    id: `gid://shopify/Product/${id}`, title: "Fetched Product", handle: "p", status: "ACTIVE", vendor: null, productType: null, description: null,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
    variants: { pageInfo: { hasNextPage: false }, nodes: [{ id: `gid://shopify/ProductVariant/${variantId}`, title: "V", sku: "AW-HM-PN-60", price: "649.0", updatedAt: "2026-09-18T00:00:00Z" }] },
  });

  it("fetches an unknown product before importing the order, so items link to real product data", async () => {
    await inRollback(async (tx, runner) => {
      const o = make();
      const { calls, shopify } = client([o.node], { [`gid://shopify/Product/${o.productId}`]: productNode(o.productId, o.variantId) });

      const outcome = await syncOrderById({ client: shopify, runner }, `gid://shopify/Order/${o.id}`);
      assert.equal(outcome.result?.action, "created");
      assert.equal(outcome.productsSynced, 1);
      assert.deepEqual(calls, [`OrderById:${o.id}`, `ProductById:${o.productId}`]);

      const item = await tx.orderItem.findFirstOrThrow({ where: { order: { ...ext, externalId: o.id } }, include: { product: true } });
      assert.equal(item.product?.name, "Fetched Product");

      // A second import of the same order needs no product fetch.
      const again = await syncOrderById({ client: shopify, runner }, `gid://shopify/Order/${o.id}`);
      assert.equal(again.result?.action, "skipped");
      assert.equal(again.productsSynced, 0);
    });
  });

  it("imports a batch, isolates a bad order, and on a second run skips everything without re-fetching", async () => {
    await inRollback(async (tx, runner) => {
      const good1 = make(), good2 = make();
      const broken = { ...make().node, name: 12345 }; // malformed: name must be a string
      const products = Object.fromEntries([good1, good2].map((o) => [`gid://shopify/Product/${o.productId}`, productNode(o.productId, o.variantId)]));
      const { calls, shopify } = client([good1.node, broken, good2.node], products);
      const options = { limit: 10, window: EMPTY_WINDOW, only: ["orders" as const], force: false, dryRun: false };

      const first = await runSync({ client: shopify, runner }, options);
      assert.equal(first.error, null);
      assert.deepEqual(first.counts.orders, { created: 2, updated: 0, skipped: 0, failed: 1 });
      assert.equal(first.failures.length, 1);
      assert.match(first.failures[0].reason, /unexpected shape/);
      assert.deepEqual(first.leads, { created: 2, matched: 0, updated: 0 });
      assert.equal(first.counts.products.created, 2);
      assert.ok(first.databaseWrites > 0);

      const ordersAfterFirst = await tx.order.count({ where: { ...ext, externalId: { in: [good1.id, good2.id] } } });
      assert.equal(ordersAfterFirst, 2);

      calls.length = 0;
      const second = await runSync({ client: shopify, runner }, options);
      assert.deepEqual(second.counts.orders, { created: 0, updated: 0, skipped: 2, failed: 1 });
      assert.equal(calls.filter((c) => c.startsWith("OrderById")).length, 1, "only the broken order is fetched again; unchanged ones are skipped from the list alone");
      assert.equal(await tx.order.count({ where: { ...ext, externalId: { in: [good1.id, good2.id] } } }), 2, "no duplicates");
    });
  });

  it("a dry run reads and maps but writes nothing and needs no database", async () => {
    const o = make();
    const { shopify } = client([o.node]);
    const report = await runSync({ client: shopify }, { limit: 5, window: EMPTY_WINDOW, only: ["orders"], force: false, dryRun: true });
    assert.equal(report.databaseWrites, 0);
    assert.equal(report.preview.length, 1);
    assert.equal(report.preview[0].mapped.orderNumber, o.mapped.orderNumber);
  });

  it("reports the window and the exact count in a real run too, and how long it took", async () => {
    await inRollback(async (_tx, runner) => {
      const o = make();
      const { shopify } = client([o.node], { [`gid://shopify/Product/${o.productId}`]: productNode(o.productId, o.variantId) });
      const report = await runSync({ client: shopify, runner }, { limit: 10, window: EMPTY_WINDOW, only: ["orders"], force: false, dryRun: false });
      assert.equal(report.window?.timeZone, "Asia/Kolkata");
      assert.equal(report.window?.createdFrom.toISOString(), "2025-12-31T18:30:00.000Z");
      assert.deepEqual(report.estimate.orders, { count: 1, exact: true, kind: "matching" });
      assert.equal(report.visited.orders, 1);
      assert.ok(report.elapsedMs >= 0);
    });
  });

  it("does not import an order created before the start date when a webhook asks for it", async () => {
    await inRollback(async (tx, runner) => {
      const old = make({ updatedAt: "2026-09-18T10:00:00Z", node: { createdAt: "2025-12-31T10:00:00Z" } });
      const { shopify } = client([old.node]);
      const floor = startOfDay("2026-01-01", "Asia/Kolkata");

      const outcome = await syncOrderById({ client: shopify, runner }, `gid://shopify/Order/${old.id}`, { notBefore: floor });
      assert.equal(outcome.outOfWindow, true);
      assert.equal(outcome.result, null);
      assert.equal(await tx.order.count({ where: { ...ext, externalId: old.id } }), 0);
      assert.equal(await tx.lead.count({ where: { externalId: old.customerId } }), 0, "no lead is created for it either");
    });
  });

  it("imports an order created on 1 January IST even though it is still 31 December in UTC", async () => {
    await inRollback(async (tx, runner) => {
      const first = make({ node: { createdAt: "2025-12-31T19:46:18Z" } });
      const { shopify } = client([first.node], { [`gid://shopify/Product/${first.productId}`]: productNode(first.productId, first.variantId) });
      const outcome = await syncOrderById({ client: shopify, runner }, `gid://shopify/Order/${first.id}`, { notBefore: startOfDay("2026-01-01", "Asia/Kolkata") });
      assert.equal(outcome.result?.action, "created");
      assert.equal(await tx.order.count({ where: { ...ext, externalId: first.id } }), 1);
    });
  });

  it("an explicit earlier --since (no notBefore) still imports an old order", async () => {
    await inRollback(async (tx, runner) => {
      const old = make({ node: { createdAt: "2025-06-01T10:00:00Z" } });
      const { shopify } = client([old.node], { [`gid://shopify/Product/${old.productId}`]: productNode(old.productId, old.variantId) });
      const outcome = await syncOrderById({ client: shopify, runner }, `gid://shopify/Order/${old.id}`);
      assert.equal(outcome.result?.action, "created");
      assert.equal(await tx.order.count({ where: { ...ext, externalId: old.id } }), 1);
    });
  });
});

describe("customers from before the start date", () => {
  const identity = (externalId: string, over: Partial<{ email: string | null; phone: string | null }> = {}) => ({
    externalId, firstName: "Old", lastName: "Customer", email: over.email ?? null, phone: over.phone ?? null, location: null,
    externalUpdatedAt: new Date("2026-09-18T00:00:00Z"),
  });

  it("are not created, but an existing lead is still updated", async () => {
    await inRollback(async (tx) => {
      const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const skipped = await upsertCustomerLead(tx, identity(id, { email: `old-${id}@example.invalid` }), { createIfMissing: false });
      assert.equal(skipped, null);
      assert.equal(await tx.lead.count({ where: { externalId: id } }), 0);

      const created = await upsertCustomerLead(tx, identity(id, { email: `old-${id}@example.invalid` }));
      assert.equal(created?.action, "created");

      const again = await upsertCustomerLead(tx, identity(id, { email: `old-${id}@example.invalid`, phone: "+919811122334" }), { createIfMissing: false });
      assert.equal(again?.leadId, created?.leadId);
      assert.equal(again?.action, "updated");
    });
  });
});
