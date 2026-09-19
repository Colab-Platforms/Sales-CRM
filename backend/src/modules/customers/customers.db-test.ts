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

      const svc = new CustomersService(tx);
      const result = await svc.getCustomer360(as(admin, Role.ADMIN), lead.id);

      assert.equal(result.profile.name, "Priya Shah");
      assert.equal(result.profile.leadNumber, lead.leadNumber);
      assert.equal(result.profile.source?.name, "Instagram");
      assert.equal(result.orders.length, 2);
      assert.equal(result.latestOrder?.id, order2.id, "the most recently created order is latest");
      assert.equal(result.currentOrderStatus, OrderStatus.PENDING_PAYMENT);

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
