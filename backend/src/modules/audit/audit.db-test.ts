// Database integration tests for the E6.6 Audit Trail. Run with: npm run test:db
//
// Every test runs inside ONE transaction that is always rolled back, so nothing is ever committed
// and it is safe to run against a shared/development database (including while the Shopify backfill
// is inserting unrelated rows elsewhere). Mirrors the pattern in customers.db-test.ts.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { ActivitySource, ActivityType, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { upsertOrder } from "../shopify/shopify.persist.js";
import { mapOrder } from "../shopify/shopify.mapper.js";
import { normalized, orderNode, rawFulfillment, rawTransaction } from "../shopify/shopify.fixtures.js";
import AuditService from "./audit.service.js";

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

describe("Audit Trail", () => {
  it("records who/what caused a manual lead action, and never invents an actor for a Shopify-driven one", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const source = await tx.source.create({ data: { name: "Instagram", code: `ig-${uid()}` } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Priya", sourceId: source.id } });

      // A human-initiated event (the existing lead-management write path): actor + role are captured.
      await tx.activity.create({
        data: { leadId: lead.id, actorId: admin.id, actorRole: Role.ADMIN, type: ActivityType.LEAD_UPDATED, source: ActivitySource.USER, title: "Lead updated" },
      });

      const svc = new AuditService(tx);
      const result = await svc.listAudit(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].actor?.id, admin.id);
      assert.equal(result.items[0].actorRole, Role.ADMIN);
      assert.equal(result.items[0].source, "USER");
    });
  });

  it("records an order created via Shopify sync as SHOPIFY_SYNC with no actor, then a later status change and a payment event on re-sync", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const orderId = uid();
      const customerId = uid();
      const transactionId = `gid://shopify/OrderTransaction/${orderId}1`;

      const node = {
        ...orderNode(),
        id: `gid://shopify/Order/${orderId}`,
        displayFinancialStatus: "PENDING",
        customer: { id: `gid://shopify/Customer/${customerId}`, firstName: "Priya", lastName: "Shah", email: `p-${orderId}@example.com`, phone: null },
        transactions: [rawTransaction({ id: transactionId, status: "PENDING", paymentId: `pay_${orderId}` })],
      };
      const created = await upsertOrder(tx, mapOrder(normalized(node)));
      assert.equal(created.action, "created");

      const createdEvents = await tx.activity.findMany({ where: { orderId: created.orderId }, orderBy: { createdAt: "asc" } });
      const orderCreated = createdEvents.find((e) => e.type === ActivityType.ORDER_CREATED)!;
      assert.equal(orderCreated.source, ActivitySource.SHOPIFY_SYNC, "no human performed this - it must say so");
      assert.equal(orderCreated.actorId, null, "a sync-driven event never pretends to be a user");
      assert.equal(orderCreated.actorRole, null);

      // Re-sync as if a webhook delivered the update: status changes and the payment succeeds.
      const updatedNode = {
        ...node,
        updatedAt: "2026-09-19T11:00:00Z",
        displayFinancialStatus: "PAID",
        transactions: [rawTransaction({ id: transactionId, status: "SUCCESS", paymentId: `pay_${orderId}`, processedAt: "2026-09-19T10:30:00Z" })],
      };
      await upsertOrder(tx, mapOrder(normalized(updatedNode)), { source: ActivitySource.SHOPIFY_WEBHOOK });

      const afterEvents = await tx.activity.findMany({ where: { orderId: created.orderId } });
      const statusChange = afterEvents.find((e) => e.type === ActivityType.ORDER_STATUS_CHANGED);
      assert.ok(statusChange, "a real status change must be recorded");
      assert.equal(statusChange!.source, ActivitySource.SHOPIFY_WEBHOOK, "this run's source is the webhook, not the sync");
      assert.deepEqual(statusChange!.oldValue, { status: "PENDING_PAYMENT" });
      assert.deepEqual(statusChange!.newValue, { status: "CONFIRMED" });

      // The payment row itself was already created (as PENDING) during the first sync - PENDING is not
      // an auditable event on its own (matches the pre-existing PAYMENT_EVENTS filter), so its move to
      // SUCCESS is a status change on an existing payment, not a fresh PAYMENT_CREATED.
      const paymentEvent = afterEvents.find((e) => e.type === ActivityType.PAYMENT_STATUS_CHANGED);
      assert.ok(paymentEvent, "the PENDING -> SUCCESS transition on the existing payment must be recorded");
      assert.equal(paymentEvent!.referenceType, "Payment", "the payment event's entity is the payment itself");
      assert.deepEqual(paymentEvent!.oldValue, { status: "PENDING" });

      // Re-syncing the exact same (unchanged) data again must not add any more events - no noise on a no-op backfill re-visit.
      const before = await tx.activity.count({ where: { orderId: created.orderId } });
      await upsertOrder(tx, mapOrder(normalized(updatedNode)), { force: true });
      assert.equal(await tx.activity.count({ where: { orderId: created.orderId } }), before, "no duplicate events for an unchanged re-sync");

      const svc = new AuditService(tx);
      const orderAudit = await svc.getOrderAudit(as(admin, Role.ADMIN), created.orderId!, { page: 1, pageSize: 20 });
      assert.ok(orderAudit.pagination.totalItems >= 3, "order-scoped audit sees the order, status and payment events together");
    });
  });

  it("records a shipment created, then a status change and a tracking update as separate, specific events", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const orderId = uid();
      const customerId = uid();

      const node = {
        ...orderNode(),
        id: `gid://shopify/Order/${orderId}`,
        customer: { id: `gid://shopify/Customer/${customerId}`, firstName: "Rohit", lastName: null, email: `r-${orderId}@example.com`, phone: null },
        fulfillments: [rawFulfillment("SHIPPED", { trackingInfo: [{ company: "Delhivery", number: "DL1", url: "https://track.example/DL1" }] })],
      };
      const created = await upsertOrder(tx, mapOrder(normalized(node)));

      const afterCreate = await tx.activity.findMany({ where: { orderId: created.orderId, referenceType: "Shipment" } });
      assert.equal(afterCreate.length, 1);
      assert.equal(afterCreate[0].type, ActivityType.SHIPMENT_CREATED);

      const delivered = {
        ...node,
        updatedAt: "2026-09-19T12:00:00Z",
        fulfillments: [rawFulfillment("DELIVERED", { trackingInfo: [{ company: "Bluedart", number: "BD2", url: "https://track.example/BD2" }] })],
      };
      await upsertOrder(tx, mapOrder(normalized(delivered)));

      const shipmentEvents = await tx.activity.findMany({ where: { orderId: created.orderId, referenceType: "Shipment" }, orderBy: { createdAt: "asc" } });
      const types = shipmentEvents.map((e) => e.type).filter((t) => t !== ActivityType.SHIPMENT_CREATED);
      assert.ok(types.includes(ActivityType.SHIPMENT_STATUS_CHANGED), "status changed from SHIPPED to DELIVERED");
      assert.ok(types.includes(ActivityType.TRACKING_UPDATED), "courier and AWB both changed");

      const svc = new AuditService(tx);
      const filtered = await svc.listAudit(as(admin, Role.ADMIN), { page: 1, pageSize: 20, type: ActivityType.TRACKING_UPDATED });
      assert.ok(filtered.items.some((i) => i.entityType === "Shipment"));
    });
  });

  it("resolves the order link for a legacy-style row that predates the orderId column (referenceType=Order, orderId null)", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Legacy" } });
      const order = await tx.order.create({
        data: { orderNumber: `ORD-${uid()}`, leadId: lead.id, source: "WEBSITE", status: "CONFIRMED", totalAmount: "500.00" },
      });
      // Written the way the pre-E6.6 code did: no orderId, just the polymorphic reference.
      await tx.activity.create({
        data: { leadId: lead.id, referenceType: "Order", referenceId: order.id, type: ActivityType.ORDER_CREATED, source: ActivitySource.SHOPIFY_SYNC },
      });

      const svc = new AuditService(tx);
      const result = await svc.listAudit(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].order?.id, order.id, "the order link must resolve even without the orderId column");
      assert.equal(result.items[0].order?.orderNumber, order.orderNumber);
    });
  });

  it("respects lead-based role scoping: a salesperson only sees audit events for leads they own", async () => {
    await inRollback(async (tx) => {
      const rep = await tx.user.create({ data: { name: "Rep", email: `r-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const otherRep = await tx.user.create({ data: { name: "Other", email: `o-${uid()}@example.invalid`, role: Role.SALESPERSON } });
      const ownLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Owned", ownerId: rep.id } });
      const otherLead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "NotOwned", ownerId: otherRep.id } });

      await tx.activity.create({ data: { leadId: ownLead.id, type: ActivityType.LEAD_CREATED, source: ActivitySource.USER, actorId: rep.id, actorRole: Role.SALESPERSON } });
      await tx.activity.create({ data: { leadId: otherLead.id, type: ActivityType.LEAD_CREATED, source: ActivitySource.USER, actorId: otherRep.id, actorRole: Role.SALESPERSON } });

      const svc = new AuditService(tx);
      const result = await svc.listAudit(as(rep, Role.SALESPERSON), { page: 1, pageSize: 20 });
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].leadId, ownLead.id);

      await assert.rejects(() => svc.getCustomerAudit(as(rep, Role.SALESPERSON), otherLead.id, { page: 1, pageSize: 20 }), /Customer not found/);
      assert.ok(await svc.getCustomerAudit(as(rep, Role.SALESPERSON), ownLead.id, { page: 1, pageSize: 20 }));
    });
  });

  it("paginates and supports filtering by actor, entity type and date range", async () => {
    await inRollback(async (tx) => {
      const admin = await tx.user.create({ data: { name: "Admin", email: `a-${uid()}@example.invalid`, role: Role.ADMIN } });
      const lead = await tx.lead.create({ data: { leadNumber: `L-${uid()}`, firstName: "Multi" } });

      for (let i = 0; i < 5; i++) {
        await tx.activity.create({
          data: {
            leadId: lead.id,
            type: ActivityType.LEAD_UPDATED,
            source: ActivitySource.USER,
            actorId: admin.id,
            createdAt: new Date(`2026-01-0${i + 1}T00:00:00.000Z`),
          },
        });
      }

      const svc = new AuditService(tx);
      const page1 = await svc.listAudit(as(admin, Role.ADMIN), { page: 1, pageSize: 2, leadId: lead.id });
      assert.equal(page1.pagination.totalItems, 5);
      assert.equal(page1.items.length, 2);
      assert.equal(page1.items[0].occurredAt.toISOString(), "2026-01-05T00:00:00.000Z", "most recent first");

      const byActor = await svc.listAudit(as(admin, Role.ADMIN), { page: 1, pageSize: 20, leadId: lead.id, actorId: admin.id });
      assert.equal(byActor.pagination.totalItems, 5);

      const byDate = await svc.listAudit(as(admin, Role.ADMIN), {
        page: 1,
        pageSize: 20,
        leadId: lead.id,
        dateFrom: new Date("2026-01-03T00:00:00.000Z"),
        dateTo: new Date("2026-01-04T23:59:59.999Z"),
      });
      assert.equal(byDate.pagination.totalItems, 2);
    });
  });

  it("does not record an audit event when a Shopify order is re-synced unchanged (no N+1 noise from the backfill)", async () => {
    await inRollback(async (tx) => {
      const orderId = uid();
      const customerId = uid();
      const node = {
        ...orderNode(),
        id: `gid://shopify/Order/${orderId}`,
        customer: { id: `gid://shopify/Customer/${customerId}`, firstName: "Static", lastName: null, email: `s-${orderId}@example.com`, phone: null },
      };
      const mapped = mapOrder(normalized(node));
      const created = await upsertOrder(tx, mapped);
      const before = await tx.activity.count({ where: { orderId: created.orderId } });
      assert.ok(before > 0);

      // Same externalUpdatedAt as before, without --force: upsertOrder short-circuits before any writes.
      const again = await upsertOrder(tx, mapped);
      assert.equal(again.action, "skipped");
      assert.equal(await tx.activity.count({ where: { orderId: created.orderId } }), before);
    });
  });
});
