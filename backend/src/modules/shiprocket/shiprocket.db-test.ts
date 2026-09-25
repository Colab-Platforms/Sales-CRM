// Database integration tests for the Shiprocket shipment integration. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back, so nothing is ever committed and it is safe to run
// against a shared development database. The database must have the 20260921120000_add_cashfree_shiprocket_integration
// migration applied. Shiprocket itself is never called: a fake stands in for it, so these tests need no credentials.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ActivityType, OrderSource, OrderStatus, PaymentMethod, PaymentStatus, Role, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ProviderHttpError, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { memoryStore } from "../integrations/integrations.testutil.js";
import { codOrderNode, money, normalized, orderNode, rawFulfillment, rawLineItem, rawTransaction } from "../shopify/shopify.fixtures.js";
import { mapOrder } from "../shopify/shopify.mapper.js";
import { upsertOrder } from "../shopify/shopify.persist.js";
import OrdersService from "../orders/orders.service.js";
import { loadShiprocketConfig } from "./shiprocket.config.js";
import ShiprocketShipmentsService, { type ShiprocketApi } from "./shiprocket.shipments.service.js";
import { processShiprocketEvent } from "./shiprocket.webhook.processor.js";

class Rollback extends Error {}

async function inRollback(fn: (tx: Db, runner: TxRunner) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx, { $transaction: (cb) => cb(tx) });
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

after(() => prisma.$disconnect());

const uid = () => randomUUID();
const as = (u: { id: string; email: string }, role: Role) => ({ id: u.id, email: u.email, role });
const CONFIG = loadShiprocketConfig({ SHIPROCKET_ENABLED: "true", SHIPROCKET_EMAIL: "api@example.com", SHIPROCKET_PASSWORD: "not-real", SHIPROCKET_PICKUP_LOCATION: "Primary" });
const DIMS = { weight: 0.5, length: 10, breadth: 10, height: 5 };
const ADDRESS = { name: "Priya Shah", address1: "12 MG Road", city: "Pune", province: "Maharashtra", zip: "411001", country: "India", phone: "9876500000" };

async function makeUser(tx: Db, role: Role = Role.MANAGER) {
  return tx.user.create({ data: { name: "User", email: `u-${uid()}@example.invalid`, role }, select: { id: true, email: true } });
}

async function makeLead(tx: Db, ownerId: string, groupId?: string) {
  const source = await tx.source.create({ data: { name: "Website", code: `web-${uid()}` }, select: { id: true } });
  // Explicit select: the shared dev database has an unapplied lead-import migration, so a Lead is never read whole.
  return tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", lastName: "Shah", mobile: "9876500000", normalizedMobile: "919876500000", sourceId: source.id, ownerId, ...(groupId ? { groupId } : {}) }, select: { id: true } });
}

/** A manager and a lead in a group they run - the only way the existing scoping rule gives a manager access to a lead. */
async function managerWithLead(tx: Db) {
  const manager = await makeUser(tx);
  const group = await tx.group.create({ data: { name: `G-${uid()}`, managerId: manager.id }, select: { id: true } });
  const lead = await makeLead(tx, manager.id, group.id);
  return { manager, lead };
}

async function makeOrder(tx: Db, leadId: string, overrides: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const order = await tx.order.create({
    data: { orderNumber: `ORD-${uid()}`, leadId, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "649.00", shippingAddress: ADDRESS, shippingPincode: "411001", ...overrides },
    select: { id: true },
  });
  await tx.orderItem.create({ data: { orderId: order.id, productNameSnapshot: "Herbal Tea", skuSnapshot: "HT-250", quantity: 2, unitPrice: "300.00", totalPrice: "600.00" } });
  await tx.payment.create({ data: { orderId: order.id, amount: "649.00", status: PaymentStatus.SUCCESS, method: PaymentMethod.UPI } });
  return order;
}

function fakeApi(over: Partial<ShiprocketApi> = {}) {
  const calls = { create: [] as Parameters<ShiprocketApi["createOrder"]>[0][], assign: [] as [string, number][], pickup: [] as string[], label: [] as string[], track: [] as string[] };
  const api: ShiprocketApi = {
    createOrder: async (request) => {
      calls.create.push(request);
      return { orderId: "555", shipmentId: "777", awb: null, courierName: null, courierCompanyId: null };
    },
    getCouriers: async () => [{ courierId: 10, name: "Delhivery", rate: 60, etd: null, estimatedDays: "3", cod: true, rating: 4 }],
    assignAwb: async (shipmentId, courierId) => {
      calls.assign.push([shipmentId, courierId]);
      return { awb: "AWB123", courierName: "Delhivery", courierCompanyId: courierId };
    },
    generatePickup: async (shipmentId) => {
      calls.pickup.push(shipmentId);
      return { scheduledDate: "2026-09-23 10:00:00", tokenNumber: "9" };
    },
    generateLabel: async (shipmentId) => {
      calls.label.push(shipmentId);
      return "https://labels.test/AWB123.pdf";
    },
    track: async (awb) => {
      calls.track.push(awb);
      return { awb, currentStatus: "In Transit", trackUrl: `https://track.test/${awb}`, etd: "2026-09-26 00:00:00", courierName: "Delhivery" };
    },
    ...over,
  };
  return { api, calls };
}

const service = (runner: TxRunner, api: ShiprocketApi) => new ShiprocketShipmentsService(runner, { config: () => CONFIG, client: () => api });
const direct = (tx: Db, orderId: string) => tx.shipment.findMany({ where: { orderId, externalSource: "SHIPROCKET" }, orderBy: { createdAt: "asc" } });

async function deliver(runner: TxRunner, payload: Record<string, unknown>) {
  const { store, rows } = memoryStore();
  const { id } = await store.record({ eventType: "shipment.status", externalEventId: uid(), payload });
  return { outcome: await processShiprocketEvent(id, { store, runner }), row: rows[0] };
}

async function setup(tx: Db, runner: TxRunner, api = fakeApi()) {
  const { manager, lead } = await managerWithLead(tx);
  const order = await makeOrder(tx, lead.id);
  return { manager, user: as(manager, Role.MANAGER), lead, order, fake: api, svc: service(runner, api.api) };
}

describe("creating a shipment", () => {
  it("creates one Shiprocket-tagged shipment, stores Shiprocket's identifiers, and refuses a second live one", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order, svc, fake } = await setup(tx, runner);
      const result = await svc.createShipment(user, order.id, DIMS);
      assert.equal(result.status, ShipmentStatus.CREATED);
      assert.equal(result.shiprocketOrderId, "555");
      assert.equal(result.paymentMethod, "Prepaid"); // fully paid
      assert.equal(result.collectOnDelivery, "0.00");

      const [row] = await direct(tx, order.id);
      assert.equal(row.externalId, "777");
      assert.equal(row.providerOrderId, "555");
      assert.ok(row.channelOrderId && row.channelOrderId.length <= 50);
      assert.equal(fake.calls.create[0].order_id, row.channelOrderId);
      assert.equal(fake.calls.create[0].pickup_location, "Primary");
      assert.equal(fake.calls.create[0].billing_pincode, "411001");

      const created = await tx.activity.findMany({ where: { orderId: order.id, type: ActivityType.SHIPMENT_CREATED } });
      assert.equal(created.length, 1);
      assert.equal(created[0].actorId, user.id);

      await assert.rejects(svc.createShipment(user, order.id, DIMS), (e: { statusCode: number }) => e.statusCode === 409);
      assert.equal(fake.calls.create.length, 1);
      assert.equal((await direct(tx, order.id)).length, 1);
    });
  });

  it("collects the unpaid balance on delivery", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const order = await makeOrder(tx, lead.id, { totalAmount: "900.00" });
      const result = await service(runner, fakeApi().api).createShipment(as(manager, Role.MANAGER), order.id, DIMS);
      assert.equal(result.paymentMethod, "COD");
      assert.equal(result.collectOnDelivery, "251.00");
    });
  });

  it("says exactly what is missing before anything reaches Shiprocket", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const order = await makeOrder(tx, lead.id, { shippingAddress: { name: "Priya" } });
      const fake = fakeApi();
      await assert.rejects(service(runner, fake.api).createShipment(as(manager, Role.MANAGER), order.id, DIMS), /missing: .*pincode/);
      assert.equal(fake.calls.create.length, 0);
    });
  });

  it("does not ship a cancelled order, and is scoped to the caller's own leads", async () => {
    await inRollback(async (tx, runner) => {
      const owner = await makeUser(tx, Role.SALESPERSON);
      const other = await makeUser(tx, Role.MANAGER); // a manager with no team, so no access to this lead
      const lead = await makeLead(tx, owner.id);
      const cancelled = await makeOrder(tx, lead.id, { status: OrderStatus.CANCELLED });
      const live = await makeOrder(tx, lead.id);
      const admin = await makeUser(tx, Role.ADMIN);
      const svc = service(runner, fakeApi().api);
      await assert.rejects(svc.createShipment(as(admin, Role.ADMIN), cancelled.id, DIMS), /cancelled order/);
      await assert.rejects(svc.createShipment(as(other, Role.MANAGER), live.id, DIMS), /Order not found/);
      assert.ok((await svc.createShipment(as(admin, Role.ADMIN), live.id, DIMS)).id);
    });
  });

  it("never lets an outage of unknown outcome silently produce a duplicate at Shiprocket", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order } = await setup(tx, runner);
      const down = service(runner, fakeApi({ createOrder: async () => { throw new ProviderHttpError("SHIPROCKET", null, "timeout", true); } }).api);
      await assert.rejects(down.createShipment(user, order.id, DIMS), (e: { statusCode: number }) => e.statusCode === 502);
      const [row] = await direct(tx, order.id);
      assert.equal(row.status, ShipmentStatus.CANCELLED); // never left looking like a live shipment
      assert.match(JSON.stringify(row.metadata), /creationUnconfirmed":true/);

      const fake = fakeApi();
      const svc = service(runner, fake.api);
      await assert.rejects(svc.createShipment(user, order.id, DIMS), /may already exist in Shiprocket/);
      assert.equal(fake.calls.create.length, 0);
      const ok = await svc.createShipment(user, order.id, { ...DIMS, acknowledgeUnconfirmed: true });
      assert.equal(ok.status, ShipmentStatus.CREATED);
    });
  });

  it("treats a definite refusal as 'nothing was created', so the next attempt needs no confirmation", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order } = await setup(tx, runner);
      const refuse = service(runner, fakeApi({ createOrder: async () => { throw new ProviderHttpError("SHIPROCKET", 422, "Pickup location not found", false); } }).api);
      await assert.rejects(refuse.createShipment(user, order.id, DIMS), (e: { statusCode: number; message: string }) => e.statusCode === 400 && /Pickup location/.test(e.message));
      const [row] = await direct(tx, order.id);
      assert.match(JSON.stringify(row.metadata), /creationUnconfirmed":false/);
      assert.ok((await service(runner, fakeApi().api).createShipment(user, order.id, DIMS)).id);
    });
  });

  it("closes a creation that died half-way instead of blocking the order forever", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order } = await setup(tx, runner);
      await tx.shipment.create({ data: { orderId: order.id, status: ShipmentStatus.CREATED, externalSource: "SHIPROCKET", externalId: `pending:${uid()}`, createdAt: new Date(Date.now() - 10 * 60_000) } });
      await assert.rejects(service(runner, fakeApi().api).createShipment(user, order.id, DIMS), /may already exist in Shiprocket/);
      const [row] = await direct(tx, order.id);
      assert.equal(row.status, ShipmentStatus.CANCELLED);
    });
  });
});

describe("AWB, pickup, label and tracking", () => {
  it("walks a shipment forward, audits each step, and never repeats a step Shiprocket already did", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order, svc, fake } = await setup(tx, runner);
      const created = await svc.createShipment(user, order.id, DIMS);

      assert.equal((await svc.getCouriers(user, created.id))[0].courierId, 10);

      const assigned = await svc.assignAwb(user, created.id, 10);
      assert.equal(assigned.status, ShipmentStatus.AWB_ASSIGNED);
      assert.equal(assigned.awb, "AWB123");
      assert.equal(assigned.courier, "Delhivery");
      await svc.assignAwb(user, created.id, 10);
      assert.equal(fake.calls.assign.length, 1);

      const picked = await svc.schedulePickup(user, created.id);
      assert.equal(picked.status, ShipmentStatus.PICKUP_SCHEDULED);
      assert.ok(picked.pickupScheduledAt);
      await svc.schedulePickup(user, created.id);
      assert.equal(fake.calls.pickup.length, 1);

      const labelled = await svc.generateLabel(user, created.id);
      assert.equal(labelled.labelUrl, "https://labels.test/AWB123.pdf");
      await svc.generateLabel(user, created.id);
      assert.equal(fake.calls.label.length, 1);

      const tracked = await svc.refreshTracking(user, created.id);
      assert.equal(tracked.status, ShipmentStatus.IN_TRANSIT);
      assert.equal(tracked.providerStatus, "In Transit");
      assert.equal(tracked.trackingUrl, "https://track.test/AWB123");
      assert.ok(tracked.expectedDeliveryAt);
      const row = (await direct(tx, order.id))[0];
      assert.ok(row.shippedAt);

      const types = (await tx.activity.findMany({ where: { orderId: order.id }, select: { type: true } })).map((a) => a.type);
      for (const t of [ActivityType.SHIPMENT_CREATED, ActivityType.SHIPMENT_AWB_ASSIGNED, ActivityType.SHIPMENT_PICKUP_SCHEDULED, ActivityType.SHIPMENT_LABEL_GENERATED, ActivityType.SHIPMENT_STATUS_CHANGED]) {
        assert.ok(types.includes(t), `missing audit event ${t}`);
      }
    });
  });

  it("enforces the order of steps", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order, svc } = await setup(tx, runner);
      const created = await svc.createShipment(user, order.id, DIMS);
      await assert.rejects(svc.schedulePickup(user, created.id), /Assign an AWB/);
      await assert.rejects(svc.generateLabel(user, created.id), /Assign an AWB/);
      await assert.rejects(svc.refreshTracking(user, created.id), /no AWB/);
    });
  });

  it("only acts on shipments the CRM created, within the caller's scope", async () => {
    await inRollback(async (tx, runner) => {
      const { user, order, svc } = await setup(tx, runner);
      const created = await svc.createShipment(user, order.id, DIMS);
      const stranger = await makeUser(tx, Role.MANAGER);
      await assert.rejects(svc.assignAwb(as(stranger, Role.MANAGER), created.id, 10), /Shipment not found/);
      const shopifyOwned = await tx.shipment.create({ data: { orderId: order.id, status: ShipmentStatus.SHIPPED, externalSource: "SHOPIFY", externalId: uid(), trackingNumber: "X" } });
      await assert.rejects(svc.refreshTracking(user, shopifyOwned.id), /Shipment not found/);
    });
  });
});

describe("Shiprocket webhooks", () => {
  async function shipped(tx: Db, runner: TxRunner) {
    const ctx = await setup(tx, runner);
    const created = await ctx.svc.createShipment(ctx.user, ctx.order.id, DIMS);
    await ctx.svc.assignAwb(ctx.user, created.id, 10);
    return { ...ctx, shipmentId: created.id };
  }

  it("moves the shipment forward by AWB, records the wording, and audits it as a webhook", async () => {
    await inRollback(async (tx, runner) => {
      const { order, shipmentId } = await shipped(tx, runner);
      const { outcome } = await deliver(runner, { awb: "AWB123", current_status: "Out For Delivery", sr_order_id: 555, courier_name: "Delhivery", etd: "2026-09-25 18:00:00", is_return: 0 });
      assert.equal(outcome, "processed");
      const row = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      assert.equal(row.status, ShipmentStatus.OUT_FOR_DELIVERY);
      assert.equal(row.providerStatus, "Out For Delivery");
      assert.ok(row.expectedDeliveryAt);
      const change = await tx.activity.findFirstOrThrow({ where: { orderId: order.id, type: ActivityType.SHIPMENT_STATUS_CHANGED, source: ActivitySource.SHIPROCKET_WEBHOOK } });
      assert.equal(change.actorId, null);
    });
  });

  it("matches by Shiprocket order id or the channel order id when there is no AWB in the payload", async () => {
    await inRollback(async (tx, runner) => {
      const { order, shipmentId } = await shipped(tx, runner);
      const row = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      await deliver(runner, { sr_order_id: 555, current_status: "Picked Up" });
      assert.equal((await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status, ShipmentStatus.SHIPPED);
      await deliver(runner, { order_id: row.channelOrderId, current_status: "In Transit" });
      assert.equal((await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status, ShipmentStatus.IN_TRANSIT);
      assert.equal((await direct(tx, order.id)).length, 1);
    });
  });

  it("never regresses: a late older status is ignored, and DELIVERED is final", async () => {
    await inRollback(async (tx, runner) => {
      const { shipmentId } = await shipped(tx, runner);
      await deliver(runner, { awb: "AWB123", current_status: "Delivered" });
      const delivered = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      assert.equal(delivered.status, ShipmentStatus.DELIVERED);
      assert.ok(delivered.deliveredAt);

      await deliver(runner, { awb: "AWB123", current_status: "In Transit" });
      await deliver(runner, { awb: "AWB123", current_status: "Cancelled" });
      await deliver(runner, { awb: "AWB123", current_status: "RTO Delivered" });
      const after = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      assert.equal(after.status, ShipmentStatus.DELIVERED);
      assert.equal(after.returnedAt, null);
    });
  });

  it("keeps wording it does not map (an RTO in progress) without changing the status", async () => {
    await inRollback(async (tx, runner) => {
      const { shipmentId } = await shipped(tx, runner);
      await deliver(runner, { awb: "AWB123", current_status: "In Transit" });
      await deliver(runner, { awb: "AWB123", current_status: "RTO Initiated" });
      const row = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      assert.equal(row.status, ShipmentStatus.IN_TRANSIT);
      assert.equal(row.providerStatus, "RTO Initiated");
    });
  });

  it("ignores a delivery for a parcel the CRM did not create, and creates nothing", async () => {
    await inRollback(async (tx, runner) => {
      const { order } = await shipped(tx, runner);
      const before = await tx.shipment.count({ where: { orderId: order.id } });
      const { outcome, row } = await deliver(runner, { awb: "SOMEONE-ELSES-AWB", current_status: "Delivered", sr_order_id: 999999 });
      assert.equal(outcome, "ignored");
      assert.equal(row.status, "IGNORED");
      assert.equal(await tx.shipment.count({ where: { orderId: order.id } }), before);
    });
  });
});

describe("Shopify sync alongside a direct Shiprocket shipment", () => {
  const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join("");
  const shopifyNode = (id: string, extra: Record<string, unknown> = {}) => ({
    ...codOrderNode(),
    id: `gid://shopify/Order/${id}`,
    name: `#DB${id.slice(-7)}`,
    updatedAt: "2026-09-19T10:05:00Z",
    email: null,
    phone: `5${digits(9)}`,
    customer: null,
    shippingAddress: { ...(orderNode().shippingAddress as Record<string, unknown>), phone: null },
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [rawLineItem({ id: `gid://shopify/LineItem/${id}1`, product: { id: `gid://shopify/Product/9${digits(11)}` }, variant: { id: `gid://shopify/ProductVariant/9${digits(11)}` } })] },
    transactions: [rawTransaction({ id: `gid://shopify/OrderTransaction/${id}1`, gateway: "Cash on Delivery (COD)", status: "PENDING", amountSet: money("699.0"), paymentId: `cod_${id}` })],
    ...extra,
  });

  it("neither deletes nor overwrites the direct shipment, and links it to Shopify's by AWB", async () => {
    await inRollback(async (tx, runner) => {
      const id = `9${digits(11)}`;
      const withFulfilment = (updatedAt: string) => shopifyNode(id, { updatedAt, fulfillments: [rawFulfillment("IN_TRANSIT", { trackingInfo: [{ company: "Shiprocket", number: "AWB123", url: null }] })] });
      // The Shopify-tagged order is created directly, so the sync takes its "existing order" path. (Importing a brand-new
      // order goes through resolveLead, which reads Lead without a select and so needs the unapplied lead-import columns.)
      const admin = await makeUser(tx, Role.ADMIN);
      const user = as(admin, Role.ADMIN);
      const lead = await makeLead(tx, admin.id);
      const seeded = await makeOrder(tx, lead.id, { orderNumber: `SHP-${id}`, source: OrderSource.SHOPIFY, externalSource: "SHOPIFY", externalId: id });
      const first = await upsertOrder(tx, mapOrder(normalized(withFulfilment("2026-09-19T10:05:00Z"))), { force: true });
      const orderId = first.orderId!;
      assert.equal(orderId, seeded.id);
      await tx.order.update({ where: { id: orderId }, data: { shippingAddress: ADDRESS }, select: { id: true } });

      const svc = service(runner, fakeApi().api);
      const created = await svc.createShipment(user, orderId, DIMS);
      await svc.assignAwb(user, created.id, 10); // the same AWB Shopify already reports for this parcel

      // Shopify reports the order again, changed.
      await upsertOrder(tx, mapOrder(normalized(withFulfilment("2026-09-21T10:05:00Z"))), { force: true });
      const rows = await tx.shipment.findMany({ where: { orderId }, select: { id: true, externalSource: true, status: true, trackingNumber: true } });
      assert.equal(rows.filter((r) => r.externalSource === "SHIPROCKET").length, 1);
      assert.equal(rows.find((r) => r.externalSource === "SHIPROCKET")!.status, ShipmentStatus.AWB_ASSIGNED);
      assert.equal(rows.filter((r) => r.externalSource === "SHOPIFY").length, 1);

      // Displayed together: two records of the same parcel, tied by AWB, neither hidden.
      const detail = await new OrdersService(tx).getOrder(user, orderId);
      const shopifyOne = detail.shipments.find((s) => s.source === "SHOPIFY")!;
      const directOne = detail.shipments.find((s) => s.source === "SHIPROCKET")!;
      assert.equal(shopifyOne.linkedShipmentId, directOne.id);
      assert.equal(directOne.linkedShipmentId, null);
      assert.equal(directOne.shiprocketOrderId, "555");

      // Even if Shopify stops reporting any fulfilment, its own row is removed - and the direct one is not.
      await upsertOrder(tx, mapOrder(normalized(shopifyNode(id, { updatedAt: "2026-09-22T10:05:00Z", fulfillments: [] }))), { force: true });
      const after = await tx.shipment.findMany({ where: { orderId }, select: { externalSource: true } });
      assert.deepEqual(after.map((r) => r.externalSource), ["SHIPROCKET"]);
    });
  });
});

describe("centralized shipment listing", () => {
  // Real Shiprocket never reuses an order/shipment id; the shared fakeApi() above hardcodes "555"/"777" (fine for
  // every other test here, which creates only one shipment), so a test creating several needs distinct ids per call.
  function fakeApiSeries() {
    let n = 0;
    return fakeApi({
      createOrder: async () => {
        n += 1;
        return { orderId: `list-${n}`, shipmentId: `list-${n}`, awb: null, courierName: null, courierCompanyId: null };
      },
    });
  }

  it("lists only Shiprocket-tagged shipments, newest first, paginated, alongside a correct summary", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const user = as(manager, Role.MANAGER);
      const svc = service(runner, fakeApiSeries().api);

      // A Shopify-derived shipment on its own order must never appear in this listing.
      const shopifyOrder = await makeOrder(tx, lead.id);
      await tx.shipment.create({ data: { orderId: shopifyOrder.id, status: ShipmentStatus.SHIPPED, externalSource: "SHOPIFY", externalId: uid(), trackingNumber: "SHOPIFY-AWB" } });

      const order1 = await makeOrder(tx, lead.id);
      const s1 = await svc.createShipment(user, order1.id, DIMS);
      const order2 = await makeOrder(tx, lead.id);
      const s2 = await svc.createShipment(user, order2.id, DIMS);
      await svc.assignAwb(user, s2.id, 10);

      const page1 = await svc.listShipments(user, { page: 1, pageSize: 1 });
      assert.equal(page1.pagination.totalItems, 2);
      assert.equal(page1.pagination.totalPages, 2);
      assert.equal(page1.items.length, 1);
      assert.equal(page1.items[0].id, s2.id); // newest first
      assert.equal(page1.items[0].order.orderNumber, (await tx.order.findUniqueOrThrow({ where: { id: order2.id }, select: { orderNumber: true } })).orderNumber);
      assert.equal(page1.items[0].customer.name, "Priya Shah");
      assert.equal(page1.items[0].awb, "AWB123");
      assert.equal(page1.items[0].amount, "649");
      assert.equal(page1.items[0].paymentMode, "PREPAID");
      assert.equal(page1.items[0].destinationCity, "Pune");
      assert.equal(page1.items[0].destinationPincode, "411001");

      const page2 = await svc.listShipments(user, { page: 2, pageSize: 1 });
      assert.equal(page2.items[0].id, s1.id);

      const summary = (await svc.listShipments(user, { page: 1, pageSize: 25 })).summary;
      assert.equal(summary.total, 2); // the Shopify-sourced shipment is never counted here
      // s1 (CREATED) and s2 (AWB_ASSIGNED) are both pre-pickup, so both fall under "pending".
      assert.equal(summary.pending, 2);
      assert.deepEqual([summary.inTransit, summary.outForDelivery, summary.delivered, summary.returned, summary.cancelled], [0, 0, 0, 0, 0]);
    });
  });

  it("searches by order number, AWB, customer name and mobile", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const user = as(manager, Role.MANAGER);
      const svc = service(runner, fakeApi().api);
      const order = await makeOrder(tx, lead.id);
      const created = await svc.createShipment(user, order.id, DIMS);
      await svc.assignAwb(user, created.id, 10);
      const orderNumber = (await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { orderNumber: true } })).orderNumber;

      for (const term of [orderNumber, "AWB123", "Priya", "9876500000"]) {
        const result = await svc.listShipments(user, { page: 1, pageSize: 25, search: term });
        assert.equal(result.items.length, 1, `search "${term}" should find the shipment`);
      }
      const none = await svc.listShipments(user, { page: 1, pageSize: 25, search: "no-such-thing-xyz" });
      assert.equal(none.items.length, 0);
    });
  });

  it("filters by status and by courier", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const user = as(manager, Role.MANAGER);
      const svc = service(runner, fakeApiSeries().api);
      const orderA = await makeOrder(tx, lead.id);
      const a = await svc.createShipment(user, orderA.id, DIMS); // CREATED, no courier yet
      const orderB = await makeOrder(tx, lead.id);
      const b = await svc.createShipment(user, orderB.id, DIMS);
      await svc.assignAwb(user, b.id, 10); // AWB_ASSIGNED, courier Delhivery

      const created = await svc.listShipments(user, { page: 1, pageSize: 25, status: ShipmentStatus.CREATED });
      assert.deepEqual(created.items.map((i) => i.id), [a.id]);

      const byCourier = await svc.listShipments(user, { page: 1, pageSize: 25, courier: "Delhivery" });
      assert.deepEqual(byCourier.items.map((i) => i.id), [b.id]);

      const options = await svc.getFilterOptions(user);
      assert.deepEqual(options.couriers, ["Delhivery"]);
    });
  });

  it("filters by payment type exactly as derivePaymentMode defines it, and by date range", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const user = as(manager, Role.MANAGER);
      const svc = service(runner, fakeApiSeries().api);

      const prepaidOrder = await makeOrder(tx, lead.id); // makeOrder's own payment is UPI -> prepaid
      const prepaid = await svc.createShipment(user, prepaidOrder.id, DIMS);

      const codOrder = await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "300.00", shippingAddress: ADDRESS, shippingPincode: "411001" }, select: { id: true } });
      await tx.orderItem.create({ data: { orderId: codOrder.id, productNameSnapshot: "Herbal Tea", quantity: 1, unitPrice: "300.00", totalPrice: "300.00" } });
      await tx.payment.create({ data: { orderId: codOrder.id, amount: "300.00", status: PaymentStatus.PENDING, method: PaymentMethod.COD } });
      const cod = await svc.createShipment(user, codOrder.id, DIMS);

      const prepaidResult = await svc.listShipments(user, { page: 1, pageSize: 25, paymentMode: "PREPAID" });
      assert.deepEqual(prepaidResult.items.map((i) => i.id), [prepaid.id]);
      const codResult = await svc.listShipments(user, { page: 1, pageSize: 25, paymentMode: "COD" });
      assert.deepEqual(codResult.items.map((i) => i.id), [cod.id]);

      const future = await svc.listShipments(user, { page: 1, pageSize: 25, dateFrom: new Date(Date.now() + 24 * 3_600_000) });
      assert.equal(future.items.length, 0);
      const past = await svc.listShipments(user, { page: 1, pageSize: 25, dateFrom: new Date(Date.now() - 24 * 3_600_000) });
      assert.equal(past.items.length, 2);
    });
  });

  it("scopes the list, the detail view and the filter options to the caller's own leads", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const stranger = await makeUser(tx, Role.MANAGER); // a manager with no group/team, so no access to this lead
      const admin = await makeUser(tx, Role.ADMIN);
      const svc = service(runner, fakeApi().api);
      const order = await makeOrder(tx, lead.id);
      const created = await svc.createShipment(as(manager, Role.MANAGER), order.id, DIMS);

      const orderNumber = (await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { orderNumber: true } })).orderNumber;

      // Scoped to this test's own order number: a stranger manager should find nothing regardless of what else
      // exists in the (shared) database, and an ADMIN's unscoped view can contain other real shipments too, so the
      // search filter - not an unscoped page length - is what actually isolates this one record.
      const strangerList = await svc.listShipments(as(stranger, Role.MANAGER), { page: 1, pageSize: 25, search: orderNumber });
      assert.equal(strangerList.items.length, 0);
      await assert.rejects(svc.getShipmentDetail(as(stranger, Role.MANAGER), created.id), /Shipment not found/);
      assert.deepEqual((await svc.getFilterOptions(as(stranger, Role.MANAGER))).couriers, []);

      const adminList = await svc.listShipments(as(admin, Role.ADMIN), { page: 1, pageSize: 25, search: orderNumber });
      assert.equal(adminList.items.length, 1);
      assert.equal(adminList.items[0].id, created.id);
    });
  });

  it("the detail view returns the full record - customer, destination, payment - and is honest about what is not stored", async () => {
    await inRollback(async (tx, runner) => {
      const { manager, lead } = await managerWithLead(tx);
      const user = as(manager, Role.MANAGER);
      await tx.lead.update({ where: { id: lead.id }, data: { email: "priya@example.invalid" }, select: { id: true } });
      const svc = service(runner, fakeApi().api);
      const order = await makeOrder(tx, lead.id);
      const created = await svc.createShipment(user, order.id, DIMS);
      await svc.assignAwb(user, created.id, 10);

      const detail = await svc.getShipmentDetail(user, created.id);
      assert.equal(detail.customer.name, "Priya Shah");
      assert.equal(detail.customer.mobile, "9876500000");
      assert.equal(detail.customerEmail, "priya@example.invalid");
      assert.equal(detail.destinationCity, "Pune");
      assert.equal(detail.destinationState, "Maharashtra");
      assert.equal(detail.destinationAddress1, "12 MG Road");
      assert.equal(detail.destinationCountry, "India");
      assert.equal(detail.paymentMode, "PREPAID");
      assert.equal(detail.amount, "649");
      assert.equal(detail.awb, "AWB123");
      assert.equal(detail.shiprocketOrderId, "555");
      assert.ok(detail.channelOrderId); // the order id the CRM sent Shiprocket when creating the shipment
      // No weight/length/breadth/height field exists on the result at all - never fabricated.
      assert.ok(!("weight" in detail) && !("length" in detail) && !("breadth" in detail) && !("height" in detail));
    });
  });
});
