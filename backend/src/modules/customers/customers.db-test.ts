// Database integration tests for Customer 360. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back, so nothing is ever committed
// and it is safe to run against a shared/development database (including while the Shopify
// backfill is inserting unrelated rows elsewhere). Mirrors the pattern in shopify.persist.db-test.ts.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import {
  ActivityType,
  AssignmentType,
  CallDirection,
  CallStatus,
  InterestedPeriodStatus,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Role,
  TaskStatus,
  TaskType,
} from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import CustomersService from "./customers.service.js";

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

describe("Customer 360", () => {
  it("aggregates orders and payments across a customer's whole history", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const source = await tx.source.create({ data: { name: "Instagram", code: `ig-${uid()}` } });
      const lead = await tx.lead.create({
        data: {
          leadNumber: `L-${uid()}`,
          firstName: "Priya",
          lastName: "Shah",
          mobile: "9876543210",
          email: "priya@example.invalid",
          sourceId: source.id,
        },
      });

      const order1 = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "1000.00", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      });
      await tx.payment.create({ data: { orderId: order1.id, amount: "1000.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });

      const order2 = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.PENDING_PAYMENT, totalAmount: "500.00", createdAt: new Date("2026-02-01T00:00:00.000Z") },
      });
      await tx.payment.create({ data: { orderId: order2.id, amount: "500.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });
      await tx.shipment.create({
        data: { orderId: order2.id, status: "OUT_FOR_DELIVERY", courier: "Delhivery", trackingNumber: "DL777", shippedAt: new Date("2026-02-02T00:00:00.000Z") },
      });

      const svc = new CustomersService(tx);
      const result = await svc.getCustomer360(as(admin, Role.ADMIN), lead.id);

      assert.equal(result.profile.name, "Priya Shah");
      assert.equal(result.profile.leadNumber, lead.leadNumber);
      assert.equal(result.profile.source?.name, "Instagram");
      assert.equal(result.orders.length, 2);
      assert.equal(result.latestOrder?.id, order2.id, "the most recently created order is latest");
      assert.equal(result.currentOrderStatus, OrderStatus.PENDING_PAYMENT);
      assert.equal(result.latestOrder?.latestShipment?.courier, "Delhivery");
      assert.equal(result.latestOrder?.latestShipment?.trackingNumber, "DL777");
      assert.equal(result.orders.find((o) => o.id === order1.id)?.latestShipment, null, "order1 has no shipment yet");

      const p = result.paymentSummary;
      assert.equal(p.orderCount, 2);
      assert.equal(p.totalOrderValue, "1500.00");
      assert.equal(p.totalPaid, "1000.00");
      assert.equal(p.totalPending, "500.00");
      assert.equal(p.codOrderCount, 1);
      assert.equal(p.codValue, "500.00");
      assert.equal(p.prepaidOrderCount, 1);
      assert.equal(p.prepaidValue, "1000.00");
    });
  });

  it("respects lead-based role scoping: owner and their manager can see it, an unrelated rep cannot", async () => {
    await inRollback(async (tx) => {
      const manager = await tx.user.create({ data: { name: "Manager", email: `m-${uid()}@example.invalid`, role: Role.MANAGER } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherRep = await tx.user.create({ data: { name: "Other", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const group = await tx.group.create({ data: { name: `Team-${uid()}`, managerId: manager.id } });
      await tx.groupMember.create({ data: { groupId: group.id, userId: rep.id, joinedAt: new Date(), isActive: true } });

      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Owned", ownerId: rep.id } });

      const svc = new CustomersService(tx);
      assert.ok(await svc.getCustomer360(as(rep, Role.SALESPERSON), lead.id), "owner can see their own customer");
      assert.ok(await svc.getCustomer360(as(manager, Role.MANAGER), lead.id), "the owner's manager can see it via team scope");
      await assert.rejects(() => svc.getCustomer360(as(otherRep, Role.SALESPERSON), lead.id), /Customer not found/);

      const timeline = await svc.getTimeline(as(rep, Role.SALESPERSON), lead.id, { page: 1, pageSize: 20 });
      assert.equal(timeline.leadId, lead.id);
      await assert.rejects(() => svc.getTimeline(as(otherRep, Role.SALESPERSON), lead.id, { page: 1, pageSize: 20 }), /Customer not found/);
    });
  });

  it("builds a chronological timeline from leads, orders, calls, assignments and interested periods with no duplicates", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });

      const lead = await tx.lead.create({
        data: { leadNumber: `L-${uid()}`, firstName: "Timeline", ownerId: rep.id, createdAt: new Date("2026-01-01T00:00:00.000Z") },
      });

      await tx.leadAssignment.create({
        data: { leadId: lead.id, userId: rep.id, assignmentType: AssignmentType.MANUAL, assignedAt: new Date("2026-01-02T00:00:00.000Z"), isCurrent: true },
      });

      await tx.call.create({
        data: {
          leadId: lead.id,
          agentId: rep.id,
          provider: "test",
          direction: CallDirection.OUTBOUND,
          status: CallStatus.COMPLETED,
          startedAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      });

      await tx.interestedLeadPeriod.create({
        data: {
          leadId: lead.id,
          qualifiedById: rep.id,
          startedAt: new Date("2026-01-04T00:00:00.000Z"),
          expiresAt: new Date("2026-01-11T00:00:00.000Z"),
          endedAt: new Date("2026-01-10T00:00:00.000Z"),
          status: InterestedPeriodStatus.CONVERTED,
        },
      });

      await tx.task.create({
        data: {
          leadId: lead.id,
          assignedToId: rep.id,
          type: TaskType.FOLLOW_UP,
          status: TaskStatus.COMPLETED,
          title: "Follow up call",
          completedAt: new Date("2026-01-05T00:00:00.000Z"),
        },
      });

      // Order 1 has real Activity rows (as the Shopify sync would write), so the CREATED
      // milestone must be sourced from the Activity, not synthesized a second time.
      const order1 = await tx.order.create({
        data: {
          orderNumber: `ORD-${uid()}`,
          leadId: lead.id,
          source: OrderSource.SHOPIFY,
          status: OrderStatus.CONFIRMED,
          totalAmount: "999.00",
          createdAt: new Date("2026-01-06T00:00:00.000Z"),
        },
      });
      await tx.activity.create({
        data: {
          leadId: lead.id,
          referenceType: "Order",
          referenceId: order1.id,
          type: ActivityType.ORDER_CREATED,
          title: "Shopify order placed",
          createdAt: new Date("2026-01-06T00:00:00.000Z"),
        },
      });
      await tx.shipment.create({
        data: {
          orderId: order1.id,
          status: "DELIVERED",
          courier: "Bluedart",
          trackingNumber: "BD555",
          shippedAt: new Date("2026-01-06T12:00:00.000Z"),
          deliveredAt: new Date("2026-01-09T09:00:00.000Z"),
        },
      });

      // Order 2 has no Activity rows at all, so its CREATED milestone must fall back to the
      // order's own createdAt.
      const order2 = await tx.order.create({
        data: {
          orderNumber: `ORD-${uid()}`,
          leadId: lead.id,
          source: OrderSource.WEBSITE,
          status: OrderStatus.CANCELLED,
          totalAmount: "199.00",
          createdAt: new Date("2026-01-07T00:00:00.000Z"),
          cancelledAt: new Date("2026-01-08T00:00:00.000Z"),
        },
      });

      const svc = new CustomersService(tx);
      const timeline = await svc.getTimeline(as(admin, Role.ADMIN), lead.id, { page: 1, pageSize: 50 });

      // Chronological ordering: most recent first.
      const times = timeline.entries.map((e) => e.occurredAt.getTime());
      const sorted = [...times].sort((a, b) => b - a);
      assert.deepEqual(times, sorted, "entries must be sorted most-recent-first");

      // No invented events: every expected source event appears exactly once.
      const byType = (t: string) => timeline.entries.filter((e) => e.type === t);
      assert.equal(byType("LEAD_CREATED").length, 1);
      assert.equal(byType("ASSIGNMENT").length, 1);
      assert.equal(byType("CALL").length, 1);
      assert.equal(byType("INTERESTED_STARTED").length, 1);
      assert.equal(byType("INTERESTED_ENDED").length, 1);
      assert.equal(byType("TASK").length, 1);
      assert.equal(byType("ORDER_CANCELLED").length, 1);
      assert.equal(byType("SHIPMENT_SHIPPED").length, 1);
      assert.equal(byType("SHIPMENT_DELIVERED").length, 1);
      assert.match(byType("SHIPMENT_SHIPPED")[0].title, /Bluedart/);
      assert.match(byType("SHIPMENT_SHIPPED")[0].description ?? "", /BD555/);
      assert.equal(byType("SHIPMENT_SHIPPED")[0].order?.id, order1.id);

      // Order 1's CREATED milestone came from the real Activity row, not a synthesized duplicate.
      const order1Created = byType("ORDER_CREATED").filter((e) => e.order?.id === order1.id);
      assert.equal(order1Created.length, 1);
      assert.equal(order1Created[0].source, "ACTIVITY");

      // Order 2's CREATED milestone was synthesized from the order row since no Activity exists.
      const order2Created = byType("ORDER_CREATED").filter((e) => e.order?.id === order2.id);
      assert.equal(order2Created.length, 1);
      assert.equal(order2Created[0].source, "RECORD");

      // No id appears twice.
      const ids = timeline.entries.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, "no duplicate timeline entries");

      // Pagination: two pages of 4 cover the same ground as one page of 50, with no repeats.
      const page1 = await svc.getTimeline(as(admin, Role.ADMIN), lead.id, { page: 1, pageSize: 4 });
      const page2 = await svc.getTimeline(as(admin, Role.ADMIN), lead.id, { page: 2, pageSize: 4 });
      assert.equal(page1.pagination.totalItems, timeline.pagination.totalItems);
      const pagedIds = [...page1.entries, ...page2.entries].map((e) => e.id);
      assert.equal(new Set(pagedIds).size, pagedIds.length, "pages do not repeat entries");
    });
  });
});

describe("Customer list (E6.7)", () => {
  it("derives each customer's segment and post-sale state, filters by segment, and paginates", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      // Every seeded lead shares this token in its last name, so every query below is scoped by
      // `search` to just these 4 rows - an ADMIN's otherwise-unfiltered query would scan the whole
      // live/shared database (real Shopify-synced customers included), which is both slow and makes
      // "page 1 of 20" nondeterministic against this test's own rows.
      const token = `Seg${uid().slice(0, 8)}`;
      const named = (first: string) => ({ firstName: first, lastName: token });

      // NEW: no orders at all.
      const fresh = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, ...named("Fresh") } });

      // HOT: no orders, but marked INTERESTED.
      const hot = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, ...named("Hot"), workingStatus: "INTERESTED" } });

      // REPEAT: two successful orders.
      const repeat = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, ...named("Repeat") } });
      for (let i = 0; i < 2; i++) {
        const order = await tx.order.create({
          data: { orderNumber: `ORD-${uid()}`, leadId: repeat.id, source: OrderSource.WEBSITE, status: OrderStatus.CONFIRMED, totalAmount: "500.00" },
        });
        await tx.payment.create({ data: { orderId: order.id, amount: "500.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });
      }

      // DORMANT: one successful order 200 days ago.
      const dormant = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, ...named("Dormant") } });
      const dormantOrder = await tx.order.create({
        data: {
          orderNumber: `ORD-${uid()}`,
          leadId: dormant.id,
          source: OrderSource.WEBSITE,
          status: OrderStatus.DELIVERED,
          totalAmount: "300.00",
          createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
        },
      });
      await tx.payment.create({ data: { orderId: dormantOrder.id, amount: "300.00", method: PaymentMethod.CARD, status: PaymentStatus.SUCCESS } });

      const svc = new CustomersService(tx);

      const all = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: token });
      assert.equal(all.pagination.totalItems, 4, "only the 4 seeded leads match this token");
      const byLeadId = new Map(all.items.map((c) => [c.leadId, c]));
      assert.equal(byLeadId.get(fresh.id)?.segment, "NEW");
      assert.equal(byLeadId.get(hot.id)?.segment, "HOT");
      assert.equal(byLeadId.get(repeat.id)?.segment, "REPEAT");
      assert.equal(byLeadId.get(repeat.id)?.orderCount, 2);
      assert.equal(byLeadId.get(repeat.id)?.totalPaid, "1000.00");
      assert.equal(byLeadId.get(dormant.id)?.segment, "DORMANT");
      assert.equal(byLeadId.get(dormant.id)?.currentOrderStatus, OrderStatus.DELIVERED);
      assert.equal(byLeadId.get(dormant.id)?.currentPaymentStatus, PaymentStatus.SUCCESS);

      const repeatOnly = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: token, segment: "REPEAT" });
      assert.equal(repeatOnly.pagination.totalItems, 1);
      assert.equal(repeatOnly.items[0]?.leadId, repeat.id);

      const withOrders = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: token, hasOrders: true });
      assert.equal(withOrders.pagination.totalItems, 2, "repeat and dormant have orders; fresh and hot do not");
      assert.ok(!withOrders.items.some((c) => c.leadId === fresh.id), "the customer with no orders is excluded");
      assert.ok(!withOrders.items.some((c) => c.leadId === hot.id));

      const noOrdersOnly = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: token, hasOrders: false });
      assert.equal(noOrdersOnly.pagination.totalItems, 2);
      assert.ok(noOrdersOnly.items.some((c) => c.leadId === fresh.id));
      assert.ok(!noOrdersOnly.items.some((c) => c.leadId === repeat.id));

      // Pagination over just these 4 seeded leads.
      const page1 = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 2, search: token });
      const page2 = await svc.listCustomers(as(admin, Role.ADMIN), { page: 2, pageSize: 2, search: token });
      assert.equal(page1.items.length, 2);
      assert.equal(page2.items.length, 2);
      assert.equal(page1.pagination.totalPages, 2);
      const pagedIds = [...page1.items, ...page2.items].map((c) => c.leadId);
      assert.equal(new Set(pagedIds).size, 4, "two pages of 2 cover all 4 seeded leads with no repeats");
    });
  });

  it("filters by owner and search, and supports the payment/shipment post-sale filters", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const owner = await tx.user.create({ data: { name: "Rep One", email: `r1-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherOwner = await tx.user.create({ data: { name: "Rep Two", email: `r2-${uid()}@example.invalid`, role: Role.SALESPERSON } });

      const searchToken = `Zephyr${uid().slice(0, 8)}`;
      const owned = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: searchToken, lastName: "Owned", ownerId: owner.id } });
      await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Someone", lastName: "Else", ownerId: otherOwner.id } });

      const order = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: owned.id, source: OrderSource.WEBSITE, status: OrderStatus.OUT_FOR_DELIVERY, totalAmount: "400.00" },
      });
      await tx.payment.create({ data: { orderId: order.id, amount: "400.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });
      await tx.shipment.create({ data: { orderId: order.id, status: "OUT_FOR_DELIVERY", courier: "Delhivery" } });

      const svc = new CustomersService(tx);

      const byOwner = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, ownerId: owner.id });
      assert.equal(byOwner.pagination.totalItems, 1);
      assert.equal(byOwner.items[0].leadId, owned.id);

      const bySearch = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: searchToken });
      assert.equal(bySearch.pagination.totalItems, 1);
      assert.equal(bySearch.items[0].leadId, owned.id);

      const pendingPayment = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: searchToken, paymentStatus: PaymentStatus.PENDING });
      assert.equal(pendingPayment.items.length, 1);

      const wrongPayment = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: searchToken, paymentStatus: PaymentStatus.SUCCESS });
      assert.equal(wrongPayment.items.length, 0);

      const outForDelivery = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: searchToken, shipmentStatus: "OUT_FOR_DELIVERY" as any });
      assert.equal(outForDelivery.items.length, 1);
      assert.equal(outForDelivery.items[0].currentShipmentStatus, "OUT_FOR_DELIVERY");
    });
  });

  it("respects lead-based role scoping: a salesperson only sees customers for leads they own", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherRep = await tx.user.create({ data: { name: "Other", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const ownLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Owned", ownerId: rep.id } });
      await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "NotOwned", ownerId: otherRep.id } });

      const svc = new CustomersService(tx);
      const result = await svc.listCustomers(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].leadId, ownLead.id);
    });
  });
});

describe("Next Best Action (E6.8)", () => {
  it("recommends FOLLOW_UP_PAYMENT for an order with an outstanding balance, on Customer 360, the dedicated endpoint, and the list, in agreement", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Unpaid", lastName: "Customer" } });
      const order = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: OrderSource.WEBSITE, status: OrderStatus.PENDING_PAYMENT, totalAmount: "1200.00" },
      });
      await tx.payment.create({ data: { orderId: order.id, amount: "1200.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });

      const svc = new CustomersService(tx);
      const c360 = await svc.getCustomer360(as(admin, Role.ADMIN), lead.id);
      assert.equal(c360.nextBestAction.action, "FOLLOW_UP_PAYMENT");
      assert.equal(c360.nextBestAction.priority, "HIGH");
      assert.equal(c360.nextBestAction.recommendedChannel, "CALL");
      assert.equal(c360.nextBestAction.relatedOrderId, order.id);
      assert.match(c360.nextBestAction.reason, /1200\.00/);

      const dedicated = await svc.getNextBestAction(as(admin, Role.ADMIN), lead.id);
      assert.deepEqual(dedicated, c360.nextBestAction, "the dedicated endpoint must agree exactly with Customer 360");

      const list = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: "Unpaid" });
      assert.equal(list.items[0]?.nbaAction, "FOLLOW_UP_PAYMENT");
      assert.equal(list.items[0]?.nbaPriority, "HIGH");
    });
  });

  it("recommends FOLLOW_UP_DELIVERY for an out-for-delivery shipment, and HANDLE_RETURN for a returned one", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });

      const ofdLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "OutForDelivery" } });
      const ofdOrder = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: ofdLead.id, source: OrderSource.WEBSITE, status: OrderStatus.OUT_FOR_DELIVERY, totalAmount: "500.00" },
      });
      await tx.payment.create({ data: { orderId: ofdOrder.id, amount: "500.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });
      await tx.shipment.create({ data: { orderId: ofdOrder.id, status: "OUT_FOR_DELIVERY", courier: "Delhivery" } });

      const returnedLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Returned" } });
      const returnedOrder = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: returnedLead.id, source: OrderSource.WEBSITE, status: OrderStatus.RETURNED, totalAmount: "300.00" },
      });
      await tx.payment.create({ data: { orderId: returnedOrder.id, amount: "300.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });
      await tx.shipment.create({ data: { orderId: returnedOrder.id, status: "RETURNED", courier: "Bluedart" } });

      const svc = new CustomersService(tx);
      const ofd = await svc.getNextBestAction(as(admin, Role.ADMIN), ofdLead.id);
      assert.equal(ofd.action, "FOLLOW_UP_DELIVERY");
      assert.equal(ofd.relatedOrderId, ofdOrder.id);

      const returned = await svc.getNextBestAction(as(admin, Role.ADMIN), returnedLead.id);
      assert.equal(returned.action, "HANDLE_RETURN");
      assert.equal(returned.relatedOrderId, returnedOrder.id);
    });
  });

  it("recommends INTERESTED_LEAD_FOLLOW_UP, RETENTION_FOLLOW_UP, REPEAT_PURCHASE_FOLLOW_UP and HIGH_VALUE_CUSTOMER_FOLLOW_UP matching each segment", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const svc = new CustomersService(tx);

      const hotLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Interested", workingStatus: "INTERESTED" } });
      assert.equal((await svc.getNextBestAction(as(admin, Role.ADMIN), hotLead.id)).action, "INTERESTED_LEAD_FOLLOW_UP");

      const dormantLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Dormant" } });
      const dormantOrder = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: dormantLead.id, source: OrderSource.WEBSITE, status: OrderStatus.DELIVERED, totalAmount: "300.00", createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
      });
      await tx.payment.create({ data: { orderId: dormantOrder.id, amount: "300.00", method: PaymentMethod.CARD, status: PaymentStatus.SUCCESS } });
      const dormantNba = await svc.getNextBestAction(as(admin, Role.ADMIN), dormantLead.id);
      assert.equal(dormantNba.action, "RETENTION_FOLLOW_UP");
      assert.equal(dormantNba.priority, "LOW");

      const repeatLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Repeat" } });
      for (let i = 0; i < 2; i++) {
        const o = await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: repeatLead.id, source: OrderSource.WEBSITE, status: OrderStatus.DELIVERED, totalAmount: "200.00" } });
        await tx.payment.create({ data: { orderId: o.id, amount: "200.00", method: PaymentMethod.UPI, status: PaymentStatus.SUCCESS } });
      }
      assert.equal((await svc.getNextBestAction(as(admin, Role.ADMIN), repeatLead.id)).action, "REPEAT_PURCHASE_FOLLOW_UP");

      const vipLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Vip" } });
      const vipOrder = await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: vipLead.id, source: OrderSource.WEBSITE, status: OrderStatus.DELIVERED, totalAmount: "20000.00" } });
      await tx.payment.create({ data: { orderId: vipOrder.id, amount: "20000.00", method: PaymentMethod.CARD, status: PaymentStatus.SUCCESS } });
      const vipNba = await svc.getNextBestAction(as(admin, Role.ADMIN), vipLead.id);
      assert.equal(vipNba.action, "HIGH_VALUE_CUSTOMER_FOLLOW_UP");
      assert.match(vipNba.reason, /VIP/);
    });
  });

  it("filters the customer list by NBA action and priority", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const token = `Nba${uid().slice(0, 8)}`;

      const unpaidLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: token, lastName: "Unpaid" } });
      const unpaidOrder = await tx.order.create({ data: { orderNumber: `ORD-${uid()}`, leadId: unpaidLead.id, source: OrderSource.WEBSITE, status: OrderStatus.PENDING_PAYMENT, totalAmount: "700.00" } });
      await tx.payment.create({ data: { orderId: unpaidOrder.id, amount: "700.00", method: PaymentMethod.COD, status: PaymentStatus.PENDING } });

      const freshLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: token, lastName: "Fresh" } });

      const svc = new CustomersService(tx);
      const paymentFollowUps = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: token, nbaAction: "FOLLOW_UP_PAYMENT" });
      assert.equal(paymentFollowUps.pagination.totalItems, 1);
      assert.equal(paymentFollowUps.items[0]?.leadId, unpaidLead.id);

      const highPriority = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: token, nbaPriority: "HIGH" });
      assert.equal(highPriority.pagination.totalItems, 1);
      assert.equal(highPriority.items[0]?.leadId, unpaidLead.id);

      const lowPriority = await svc.listCustomers(as(admin, Role.ADMIN), { page: 1, pageSize: 20, search: token, nbaPriority: "LOW" });
      assert.equal(lowPriority.items[0]?.leadId, freshLead.id);
    });
  });

  it("respects lead-based role scoping and 404s consistently for an out-of-scope customer on the dedicated NBA endpoint", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherRep = await tx.user.create({ data: { name: "Other", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const ownLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Owned", ownerId: rep.id } });
      const otherLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "NotOwned", ownerId: otherRep.id } });

      const svc = new CustomersService(tx);
      assert.ok(await svc.getNextBestAction(as(rep, Role.SALESPERSON), ownLead.id));
      await assert.rejects(() => svc.getNextBestAction(as(rep, Role.SALESPERSON), otherLead.id), /Customer not found/);
    });
  });
});
